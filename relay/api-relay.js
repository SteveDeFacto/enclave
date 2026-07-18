// Enclave API relay — discovery + placement front door for the fleet. UNTRUSTED
// as a router (it can misroute, not impersonate: enclaves are attested on
// their own origins), but on the /v1 gateway path it IS a TLS terminator and
// sees control-plane traffic — accepted trade for giving browsers one origin.
//
// It reads EnclaveRegistry on Base for live enclaves (slow-moving truth: who
// exists), polls each one's public /availability (fast-moving truth: free
// capacity), and routes each request by what it IS. A deployment lives on ONE
// enclave, sessions are stateless JWTs (ES256, signed by each enclave's
// in-enclave key — a login is currently pinned to the enclave that issued it;
// see docs/session-auth.md), and only CREATION is a placement decision:
//
//   POST /v1/deployments        -> pick() by the body's resources.{gpuShare,cpuShare}
//                                  (CPU-only work -> CPU enclaves first; GPU work
//                                  -> a GPU enclave with both pools free)
//   GET  /v1/deployments        -> fan out to every live enclave, merge the lists,
//                                  then MERGE THE LEDGER: every EnclaveDeployments
//                                  record the wallet owns appears, hosted or not
//                                  (queued/stopped/unfunded work is real work) —
//                                  this endpoint answers even with ZERO enclaves
//   GET  /v1/deployments/:id    -> the owning enclave when one is live, else the
//                                  ledger record (same zero-enclave guarantee)
//   /v1/deployments/:id/*, /x/:id* and app subdomains
//                               -> the enclave that OWNS the deployment (probed
//                                  once, cached)
//   /availability               -> FLEET aggregate (best card slice + best node
//                                  pool across enclaves; what deploy dials want)
//   /v1/auth/*, everything else -> one sticky enclave (nonces are per-enclave
//                                  state; GPU enclave preferred, it serves the
//                                  full API surface)
//   GET /route                  -> JSON answer { endpoint, repo } for clients
//                                  that want to hit the enclave directly
//
// Config (env):
//   REGISTRY_ADDRESS   required*   EnclaveRegistry on Base (chain 8453)
//   BASE_RPC           optional    RPC url (default https://mainnet.base.org)
//   ENCLAVES           required*   *instead of the registry: static comma list
//                                  of enclave origins (pilot / local dev)
//   API_RELAY_PORT     optional    listen port (default 8100)
//   API_RELAY_BIND     optional    bind address. DEFAULT = all interfaces (kept
//                                  so a directly-exposed relay isn't broken); set
//                                  API_RELAY_BIND=127.0.0.1 whenever a local Caddy
//                                  fronts :8100 (the production `nan` box does) so
//                                  the port is never reachable except via the proxy.
//   TRUSTED_PROXY      optional    "1"/on (default) trusts Caddy's x-forwarded-host
//                                  /x-forwarded-for; set 0/off/none when the relay
//                                  is directly internet-exposed so clients can't
//                                  spoof routing/source via those headers.
//   TRUSTED_OPERATORS  optional    comma-separated lowercased EnclaveRegistry
//                                  operator addresses; when set, on-chain discovery
//                                  is filtered to these (closes B1/B2/B3). Unset =
//                                  follow every registered enclave (+ loud warning).
//   CORS_ORIGINS       optional    comma-separated allowed browser origins
//                                  (default https://enclave.host,https://www.enclave.host)
//   FANOUT_MAX_INFLIGHT optional   global cap on concurrent upstream fan-out (256)
//   AVAIL_POLL_SEC     optional    availability poll cadence (default 10)
//   REGISTRY_POLL_SEC  optional    registry re-read cadence (default 300)
//   STALE_AFTER_SEC    optional    drop enclaves silent on-chain > this (3600)

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createHash, createHmac } from "node:crypto";
import { readCappedText, installProcessGuards } from "./fleet.mjs";
import { isBlockedHost } from "./net-guard.mjs";
installProcessGuards("api-relay");

let   REGISTRY_ADDRESS  = (process.env.REGISTRY_ADDRESS || "").trim();   // env fallback; the address book (below) overrides
let   DEPLOYMENTS_ADDRESS = (process.env.DEPLOYMENTS_ADDRESS || "").trim(); // EnclaveDeployments ledger; book overrides too
const ADDRESS_BOOK      = (process.env.ADDRESS_BOOK_ADDRESS || "").trim();
const BASE_RPC          = process.env.BASE_RPC || "https://mainnet.base.org";
const STATIC_ENCLAVES   = (process.env.ENCLAVES || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const PORT              = parseInt(process.env.API_RELAY_PORT || "8100", 10);
const AVAIL_POLL_SEC    = parseInt(process.env.AVAIL_POLL_SEC || "10", 10);
const REGISTRY_POLL_SEC = parseInt(process.env.REGISTRY_POLL_SEC || "300", 10);
const STALE_AFTER_SEC   = parseInt(process.env.STALE_AFTER_SEC || "3600", 10);
// Per-deployment app subdomains: <dep-id>.<APP_DOMAIN> maps to the enclave's
// /x/<id> data path, so each app is its OWN origin (isolated from the frontend
// and from other tenants). Host uses a hyphen ("dep-abc") since "_" is invalid
// in a hostname; we map it back to the canonical "dep_abc". Empty = disabled.
// Comma-separated: during a domain cutover both the new and the old suffix
// route (e.g. "app.enclave.host,app.nan.host"); the first entry is primary.
const APP_DOMAINS       = (process.env.APP_DOMAIN || "").toLowerCase().split(",")
  .map(s => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);

if (!REGISTRY_ADDRESS && !ADDRESS_BOOK && !STATIC_ENCLAVES.length) {
  console.error("fatal: set ADDRESS_BOOK_ADDRESS or REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}

// --- hardening config ----------------------------------------------------------
// SECURITY (B1/B2/B3): the on-chain registry is permissionless — anyone can
// register an endpoint. TRUSTED_OPERATORS (comma-separated, lowercased Enclave-
// Registry operator addresses) restricts on-chain discovery to vetted operators,
// so session tokens and /x data-path traffic only ever reach them.
//
// FAIL CLOSED: this single control sits behind three trust boundaries (token
// harvest, egress-token leak, subdomain hijack), so an UNSET var must never
// silently reopen them on a rebuilt or fresh box. When TRUSTED_OPERATORS is
// unset/empty we fall back to the BAKED canonical operator set below (not "trust
// everyone"). Running a genuinely unrestricted relay is still possible but only
// as an explicit, auditable opt-in: TRUSTED_OPERATORS=* (or "any"/"all").
const DEFAULT_TRUSTED_OPERATORS = ["0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1"]; // canonical Enclave fleet operator
const _rawOperators = (process.env.TRUSTED_OPERATORS ?? "").trim();
const OPERATORS_UNRESTRICTED = /^(\*|any|all)$/i.test(_rawOperators);
const TRUSTED_OPERATORS = OPERATORS_UNRESTRICTED ? []
  : (_rawOperators
      ? _rawOperators.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_TRUSTED_OPERATORS.slice());
const isHttpsEndpoint = (ep) => { try { return new URL(ep).protocol === "https:"; } catch { return false; } };
let _warnedUnauth = false;
function warnIfUnauthenticated() {
  if (STATIC_ENCLAVES.length || !OPERATORS_UNRESTRICTED || _warnedUnauth) return;
  _warnedUnauth = true;
  console.error("[api-relay] WARNING: TRUSTED_OPERATORS=* — routing tokens/traffic to EVERY endpoint in the " +
    "permissionless EnclaveRegistry (no operator allowlist), by explicit configuration. Unset it to restrict to the vetted operator set.");
}
// CORS (fix 5): allowlist instead of reflecting any Origin with credentials.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://enclave.host,https://www.enclave.host")
  .split(",").map((s) => s.trim()).filter(Boolean);
// Trusted-proxy switch (fix 6): Caddy fronts the relay in production and sets
// x-forwarded-host / x-forwarded-for. Default trusts those (current behavior).
// Set TRUSTED_PROXY to an off value (0/false/off/no/none) when the relay is
// directly internet-exposed, so a client can't spoof routing via x-forwarded-*.
const TRUSTED_PROXY = !/^(0|false|off|no|none)$/i.test((process.env.TRUSTED_PROXY ?? "1").trim());
const routingHost = (req) =>
  (TRUSTED_PROXY && req.headers["x-forwarded-host"]) || req.headers.host;
const clientIp = (req) => {
  if (TRUSTED_PROXY) { const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); if (xff) return xff; }
  return req.socket?.remoteAddress || "unknown";
};
const isLoopback = (req) => {
  const a = req.socket?.remoteAddress || "";
  return /^127\./.test(a) || a === "::1" || a === "::ffff:127.0.0.1" || a.startsWith("::ffff:127.");
};
// In-memory token-bucket rate limiter (fix 2), per source key. Generous by
// design — it only sheds the abusive miss/fan-out traffic, not normal browsing.
function makeRateLimiter({ capacity, refillPerSec }) {
  const buckets = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.at > 300_000) buckets.delete(k); }, 60_000).unref?.();
  return (key) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  };
}
const rlMiss = makeRateLimiter({ capacity: 60, refillPerSec: 10 });   // /x + app-subdomain owner misses
const rlHint = makeRateLimiter({ capacity: 20, refillPerSec: 2 });    // /v1/claim-hint fan-out
// Signed-upload authorization (/v1/apps/upload-token): per-wallet token-mint cap.
// Generous burst, ~30/hr steady — the gateway enforces the real BYTE budget.
const rlUpload = makeRateLimiter({ capacity: 30, refillPerSec: 30 / 3600 });
// Dedicated secret shared ONLY with the wasm add-gateway on this box (NOT the
// fleet SECRET). Empty = signed uploads unavailable (503). See ipfs-add-gateway.py.
const UPLOAD_KEY = process.env.UPLOAD_KEY || "";
// Global cap on concurrent upstream fan-out requests (fix 2): bounds the
// amplification of one inbound request into N enclave requests.
const FANOUT_MAX = parseInt(process.env.FANOUT_MAX_INFLIGHT || "256", 10);
let fanoutInflight = 0;
const fanoutReserve = (n) => { if (fanoutInflight + n > FANOUT_MAX) return false; fanoutInflight += n; return true; };
const fanoutRelease = (n) => { fanoutInflight = Math.max(0, fanoutInflight - n); };

// --- registry read (mirrors scripts/enclave-discover.mjs) ------------------------
const ABI = [
  { type: "function", name: "count", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "endpoint", type: "string" }, { name: "repo", type: "string" },
      { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
      { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" },
      { name: "active", type: "bool" }] }] },
];
let _client = null;
async function chain() {
  if (!_client) {
    const { createPublicClient, http: viemHttp } = await import("viem");
    const { base } = await import("viem/chains");
    _client = createPublicClient({ chain: base, transport: viemHttp(BASE_RPC) });
  }
  return _client;
}
// "registry" as ascii-right-padded bytes32 (the EnclaveAddressBook key)
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view",
  inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const BOOK_KEY_REGISTRY = "0x7265676973747279000000000000000000000000000000000000000000000000";
// An enclave's registry id is keccak256(bytes(endpoint)) — the contract's own
// derivation (EnclaveRegistry.register), which is also what EnclaveDeployments
// records as a lease's `runner`. Carrying the id on every registry row lets
// ledger rows be matched against the live fleet (see ledgerStatus).
let _hashEndpoint = null;
async function endpointId(endpoint) {
  if (!_hashEndpoint) {
    const { keccak256, stringToBytes } = await import("viem");
    _hashEndpoint = (s) => keccak256(stringToBytes(s));
  }
  return _hashEndpoint(endpoint);
}
async function readRegistry() {
  if (STATIC_ENCLAVES.length)
    return Promise.all(STATIC_ENCLAVES.map(async (endpoint) =>
      ({ endpoint, id: await endpointId(endpoint), repo: null, lastSeen: null })));
  const c = await chain();
  // resolve the registry from the on-chain address book each cycle, so a
  // registry redeploy reaches this box with one owner tx (no env edits)
  if (ADDRESS_BOOK) {
    try {
      const a = await c.readContract({ address: ADDRESS_BOOK, abi: BOOK_ABI, functionName: "addr", args: [BOOK_KEY_REGISTRY] });
      if (a && !/^0x0{40}$/i.test(a) && a.toLowerCase() !== REGISTRY_ADDRESS.toLowerCase()) {
        console.log(`[api-relay] address book: registry ${REGISTRY_ADDRESS || "(unset)"} -> ${a}`);
        REGISTRY_ADDRESS = a;
      }
    } catch (e) { /* keep the current registry; next poll retries */ }
  }
  if (!REGISTRY_ADDRESS) throw new Error("no registry address (book unresolved and REGISTRY_ADDRESS unset)");
  const total = Number(await c.readContract({ address: REGISTRY_ADDRESS, abi: ABI, functionName: "count" }));
  const out = [];
  for (let start = 0; start < total; start += 50)
    out.push(...await c.readContract({ address: REGISTRY_ADDRESS, abi: ABI,
      functionName: "getPage", args: [BigInt(start), 50n] }));
  const now = Math.floor(Date.now() / 1000);
  warnIfUnauthenticated();
  return Promise.all(out
    .filter((e) => e.active && now - Number(e.lastSeen) <= STALE_AFTER_SEC)
    // B2: only vetted operators (baked default, or the env allowlist). Pass-all
    // ONLY under the explicit TRUSTED_OPERATORS=* opt-in — never by omission.
    .filter((e) => OPERATORS_UNRESTRICTED || TRUSTED_OPERATORS.includes(String(e.operator || "").toLowerCase()))
    .map((e) => ({ e, endpoint: e.endpoint.replace(/\/+$/, "") }))
    // B1/B3: never route to a non-https discovered endpoint (real enclaves are https)
    .filter(({ endpoint }) => { const ok = isHttpsEndpoint(endpoint); if (!ok) console.error(`[api-relay] skipping non-https registry endpoint: ${endpoint}`); return ok; })
    // SSRF: the registry is permissionless — drop any endpoint whose host is a
    // literal private/loopback/link-local IP (or localhost) so an attacker can't
    // register https://127.0.0.1/ or https://169.254.169.254/ and make this relay
    // dial its own localhost / cloud metadata. (Real enclaves are public domains.)
    .filter(({ endpoint }) => { let h; try { h = new URL(endpoint).hostname; } catch { return false; } const ok = !isBlockedHost(h); if (!ok) console.error(`[api-relay] skipping non-global registry endpoint: ${endpoint}`); return ok; })
    .map(async ({ e, endpoint }) =>
      ({ endpoint, id: await endpointId(endpoint), repo: e.repo, lastSeen: Number(e.lastSeen) })));
}

// --- EnclaveDeployments ledger (the source of truth for a wallet's work) --------
// The fleet only reports deployments it currently HOSTS; created/funded/stopped
// records live on-chain regardless, so the list/get endpoints read the ledger
// too. Resolved from the address book like the registry; paged eth_calls (no
// log scans - public RPCs cap those), cached briefly.
const BOOK_KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473" + "0".repeat(42);   // "deployments" ascii right-padded
const DEP_TUPLE = [   // Deployment struct, schema rev 2
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
  { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
// rev-1 ledgers carry a removed sshPubKey string after ports (decoded, unused)
const DEP_TUPLE_V1 = [...DEP_TUPLE.slice(0, 4), { name: "sshPubKey", type: "string" }, ...DEP_TUPLE.slice(4)];
const depAbiFor = (components) => [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components }] },
];
// Which shape the ledger at DEPLOYMENTS_ADDRESS speaks: deploymentsSchema()
// reverts on rev-1 contracts (that IS the answer); cached per address so an
// address-book repoint re-sniffs. Transport errors don't cache - this round
// reads rev 1 and the next call retries the sniff.
let _depShape = { addr: null, abi: depAbiFor(DEP_TUPLE_V1) };
async function depAbi(c) {
  if (_depShape.addr === DEPLOYMENTS_ADDRESS) return _depShape.abi;
  try {
    const rev = Number(await c.readContract({ address: DEPLOYMENTS_ADDRESS,
      abi: [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "deploymentsSchema" }));
    _depShape = { addr: DEPLOYMENTS_ADDRESS, abi: depAbiFor(rev >= 2 ? DEP_TUPLE : DEP_TUPLE_V1) };
  } catch (e) {
    // Only a genuine REVERT proves a rev-1 contract (it has code but not the
    // selector). "returned no data" means THIS provider sees no code at the
    // address — a lagging/throttled pool member during a migration — and
    // viem's wrapper names (ContractFunction*) cover both, so classify by
    // message. Caching rev 1 on a transient wedged the supervisor's whole
    // claim path 2026-07-17 (supervisor.js sniffCachePolicy).
    if (/revert/i.test(e?.shortMessage || e?.message || "")) _depShape = { addr: DEPLOYMENTS_ADDRESS, abi: depAbiFor(DEP_TUPLE_V1) };
    else return depAbiFor(DEP_TUPLE_V1);
  }
  return _depShape.abi;
}
// a misaligned tuple decode (wrong cached shape for this ledger) — drop the
// sniff cache so the next tick re-sniffs instead of staying wedged
const shapeDecodeError = (e) => /safe integer range|out[- ]of[- ]bounds|data size|not a valid boolean/i.test(e?.shortMessage || e?.message || "");
async function resolveDeployments() {
  if (!ADDRESS_BOOK) return;
  try {
    const c = await chain();
    const a = await c.readContract({ address: ADDRESS_BOOK, abi: BOOK_ABI, functionName: "addr", args: [BOOK_KEY_DEPLOYMENTS] });
    if (a && !/^0x0{40}$/i.test(a) && a.toLowerCase() !== DEPLOYMENTS_ADDRESS.toLowerCase()) {
      console.log(`[api-relay] address book: deployments ${DEPLOYMENTS_ADDRESS || "(unset)"} -> ${a}`);
      DEPLOYMENTS_ADDRESS = a;
    }
  } catch (e) { /* keep the current address; next poll retries */ }
}
const LEDGER_TTL_MS = 10_000;
let _ledger = { rows: [], at: 0, inflight: null };
async function ledgerRows() {
  if (!DEPLOYMENTS_ADDRESS) return _ledger.rows;
  if (Date.now() - _ledger.at < LEDGER_TTL_MS) return _ledger.rows;
  if (_ledger.inflight) return _ledger.inflight;
  _ledger.inflight = (async () => {
    try {
      const c = await chain();
      const abi = await depAbi(c);
      const total = Number(await c.readContract({ address: DEPLOYMENTS_ADDRESS, abi, functionName: "count" }));
      const rows = [];
      for (let start = 0; start < total; start += 50)
        rows.push(...await c.readContract({ address: DEPLOYMENTS_ADDRESS, abi,
          functionName: "getPage", args: [BigInt(start), 50n] }));
      _ledger.rows = rows; _ledger.at = Date.now();
      return rows;
    } catch (e) {
      if (shapeDecodeError(e)) _depShape = { addr: null, abi: _depShape.abi };
      throw e;
    } finally { _ledger.inflight = null; }
  })();
  return _ledger.inflight;
}
// A ledger record's status, synthesized WITHOUT asking any enclave (the
// tokenless list is built purely from these): "running" = a live lease whose
// runner is a live, answering enclave — matched by registry id, keccak256 of
// the endpoint (the moment right after a claim, while the runner still
// provisions, reads as running here; the signed-in view carries the enclave's
// finer-grained truth); "claimed" = a lease is live but its runner isn't
// answering (enclave down/restarting); "queued" = funded work awaiting a claim
// (incl. expired leases - claimable); they resume by themselves, nothing needs
// the owner. "unfunded" = the balance can't buy one second (drained mid-run or
// funded below the rate): no enclave will claim it until the owner tops up —
// the boundary mirrors the contract's claimable() (balance6 >= rate) and the
// supervisor's own sweep gate, so "queued" always means "will start by itself".
const ZERO32 = /^0x0+$/;
const runnerIsLive = (runner) => {
  runner = String(runner).toLowerCase();
  return live.some((e) => e.id && e.id.toLowerCase() === runner);
};
function ledgerStatus(d) {
  if (!d.active) return "stopped";
  if (!(d.balance6 > 0n || d.spent6 > 0n)) return "awaiting_payment";
  if (!ZERO32.test(d.runner) && Number(d.leaseUntil) * 1000 > Date.now())
    return runnerIsLive(d.runner) ? "running" : "claimed";
  return d.balance6 >= d.rate ? "queued" : "unfunded";
}
// Dedicated per-deployment IPv6, synthesized from PUBLIC data (mirrors the
// supervisor's depAddrFor exactly: sha256(id) low 64 host bits into the routed
// /64, low range reserved for infra). The tokenless dashboard reads ledger
// rows, so without this no signed-out view ever shows a deployment's address.
// Only rows the inbound relays actually serve get one here: public + running +
// declared tcp/udp ports (the tcp6/udp relays' own netMap gate). Egress-only
// addresses stay the enclave view's call - it alone knows egress is enabled.
// DEP_ADDR_PREFIX = the relay box's routed /64 (same env as the supervisor).
const DEP_ADDR_PREFIX = (process.env.DEP_ADDR_PREFIX || "").trim();
function v6ToBig(s) {
  const [head, tail] = s.split("::");
  const hi = head ? head.split(":").filter(Boolean) : [];
  const lo = tail ? tail.split(":").filter(Boolean) : [];
  const mid = Array(8 - hi.length - lo.length).fill("0");
  const groups = s.includes("::") ? [...hi, ...mid, ...lo] : s.split(":");
  if (groups.length !== 8) throw new Error(`bad IPv6 "${s}"`);
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}
function bigToV6(n) {
  const g = [];
  for (let i = 0; i < 8; i++) g[i] = Number((n >> BigInt((7 - i) * 16)) & 0xffffn);
  let best = { i: -1, len: 0 }, cur = { i: -1, len: 0 };
  g.forEach((v, i) => {
    if (v === 0) { if (cur.i < 0) cur = { i, len: 0 }; cur.len++; if (cur.len > best.len) best = { ...cur }; }
    else cur = { i: -1, len: 0 };
  });
  const hex = g.map((v) => v.toString(16));
  if (best.len > 1) { hex.splice(best.i, best.len, ""); if (best.i === 0) hex.unshift(""); if (best.i + best.len === 8) hex.push(""); }
  return hex.join(":").replace(/:{3,}/, "::");
}
function depAddrFor(id) {
  if (!DEP_ADDR_PREFIX) return null;
  const [prefix] = DEP_ADDR_PREFIX.split("/");
  const net128 = v6ToBig(prefix) & (~0n << 64n);
  let host = BigInt("0x" + createHash("sha256").update(id).digest("hex").slice(0, 16)) & ((1n << 64n) - 1n);
  if (host < 0x10000n) host += 0x10000n;
  return bigToV6(net128 | host);
}
// the ledger row's declared ports ("http:8000,tcp:7777,udp:53"): only tcp:/udp:
// entries live on the dedicated address (http rides the gateway origin)
const rowPorts = (d, proto) => String(d.ports || "").split(",")
  .map((s) => s.trim()).filter((s) => s.startsWith(proto + ":"))
  .map((s) => +s.slice(proto.length + 1)).filter((p) => Number.isInteger(p) && p > 0);
function ledgerNetwork(d, status) {
  if (status !== "running" || !d.isPublic) return null;
  const address = depAddrFor(d.id); if (!address) return null;
  const tcp = rowPorts(d, "tcp"), udp = rowPorts(d, "udp");
  if (!tcp.length && !udp.length) return null;
  const net = { address };
  if (tcp.length) net.tcp = { address, ports: tcp };
  if (udp.length) net.udp = { address, ports: udp };
  return net;
}
// Shape a ledger record like the enclaves' own rows (supervisor view()), so
// dashboards/CLIs treat both alike. `ledger: true` marks the synthesis - logs
// and attestation exist only once a runner hosts it.
function ledgerView(d) {
  const rate6 = Number(d.rate);                               // per-second price, 6dp USDC
  // remaining runtime = the live lease's prepaid tail + what the balance still
  // buys (mirrors the supervisor's own view()). Balance alone reads ~0 the
  // moment a renew burns it into the lease - the owner still has minutes left.
  const leaseTail = Math.max(0, Number(d.leaseUntil) - Math.floor(Date.now() / 1000));
  const status = ledgerStatus(d);
  const network = ledgerNetwork(d, status);
  return {
    id: d.id, owner: d.owner.toLowerCase(), status, public: d.isPublic,
    ...(network ? { network } : {}),
    image: { reference: d.appRef },
    resources: { gpuShare: Number(d.gpuMilli) / 1000, cpuShare: Number(d.cpuMilli) / 1000 },
    createdAt: new Date(Number(d.createdAt) * 1000).toISOString(),
    ratePerSecondUsdc: (rate6 / 1e6).toFixed(7),
    spentUsdc: (Number(d.spent6) / 1e6).toFixed(2),
    paidUsdc: ((Number(d.balance6) + Number(d.spent6)) / 1e6).toFixed(2),
    timeRemainingSec: rate6 > 0 ? leaseTail + Math.floor(Number(d.balance6) / rate6) : null,
    onchain: { contract: DEPLOYMENTS_ADDRESS, id: d.id,
               leaseUntil: Number(d.leaseUntil) ? new Date(Number(d.leaseUntil) * 1000).toISOString() : null },
    ledger: true,
  };
}
// The wallet the session token names. The relay can't VERIFY the fleet's JWTs
// (that would mean holding the enclave SECRET here, and the relay is untrusted
// by design) - and it doesn't need to: every field a ledger row carries is
// public on-chain data; the token only picks WHICH owner's public records to
// return. Enclaves keep verifying it for everything they serve.
function tokenAddress(auth) {
  // SECURITY INVARIANT (fix 11): this decodes the JWT WITHOUT verifying its
  // signature (the relay holds no key — it can't verify an ES256 token and
  // deliberately never held the old HS256 SECRET either), so the returned
  // address is UNTRUSTED. It may ONLY be used to scope which
  // wallet's PUBLIC on-chain ledger rows to return — never to authorize an
  // action or release private data. Anything sensitive stays enclave-verified.
  const m = /^Bearer\s+(.+)$/.exec(auth || ""); if (!m) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1].split(".")[1], "base64url").toString());
    if (p.exp && p.exp * 1000 <= Date.now()) return null;
    return (typeof p.sub === "string" && /^0x[0-9a-fA-F]{40}$/.test(p.sub)) ? p.sub.toLowerCase() : null;
  } catch { return null; }
}

// --- availability polling -----------------------------------------------------
async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? JSON.parse(await readCappedText(r)) : null; }
  catch { return null; } finally { clearTimeout(t); }
}

let registry = [];                 // [{endpoint, id, repo, lastSeen}] (id = the registry's keccak256(endpoint))
let live = [];                     // registry ∩ answering, each + {availability, checkedAt}
let updatedAt = null;

async function pollRegistry() {
  try { registry = await readRegistry(); }
  catch (e) { console.error("[api-relay] registry read failed:", e.message); }
}
// Bounded /availability poll. The registry is permissionless, so an attacker can
// inflate the row count; a naive Promise.all(registry.map(...)) would open one
// concurrent socket PER row every cycle (unbounded fan-out / self-driving SSRF).
// A fixed worker pool caps in-flight probes regardless of registry size.
const AVAIL_POLL_CONCURRENCY = parseInt(process.env.AVAIL_POLL_CONCURRENCY || "32", 10);
async function pollAvailability() {
  const src = registry, rows = new Array(src.length);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= src.length) return;
      const e = src[idx];
      const a = await fetchJson(`${e.endpoint}/availability`);
      rows[idx] = a ? { ...e, availability: a, checkedAt: new Date().toISOString() } : null;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AVAIL_POLL_CONCURRENCY, src.length || 1) }, worker));
  live = rows.filter(Boolean);
  updatedAt = new Date().toISOString();
}

// Share-based routing — same rule as enclave-discover.mjs. Deployments buy two
// shares, so callers route on the shares they intend to buy (the app's specs
// only set the MINIMUM shares — compute those from /availability's
// cardVramGb/cardTflops/nodeRamGb/nodeGflops if you're sizing from specs).
// GPU work (gpuShare > 0) needs a GPU enclave whose free card slice AND cpu
// pool both fit. CPU-only work prefers CPU-only enclaves; GPU enclaves are the
// FALLBACK, serving it out of leftover cpu pool (a tenant buying a whole card
// + 10% of the node leaves 90% rentable). maxShare = deprecated fallback for
// old enclaves.
const gpuFreeOf = (a) => a.gpuShareFree ?? (a.gpu ? a.maxShare ?? 0 : 0);
const cpuFreeOf = (a) => a.cpuShareFree ?? (a.gpu ? 0 : a.maxShare ?? 0);
function pick(want = {}) {
  const { gpuShare = 0, cpuShare = 0 } = want;
  if (gpuShare > 0) {
    return live
      .filter((e) => e.availability.gpu && gpuFreeOf(e.availability) >= gpuShare
                                        && cpuFreeOf(e.availability) >= cpuShare)
      .sort((a, b) => gpuFreeOf(b.availability) - gpuFreeOf(a.availability))[0] || null;
  }
  const fits = live.filter((e) => cpuFreeOf(e.availability) >= cpuShare);
  const byCpuFree = (a, b) => cpuFreeOf(b.availability) - cpuFreeOf(a.availability);
  return fits.filter((e) => !e.availability.gpu).sort(byCpuFree)[0]
      || fits.filter((e) => e.availability.gpu).sort(byCpuFree)[0]
      || null;
}

// --- http ----------------------------------------------------------------------
// CORS (fix 5): the browser page (https://enclave.host) talks only to this relay,
// so WE answer preflight and stamp CORS on every response. Origin is matched
// against an ALLOWLIST (CORS_ORIGINS env, else enclave.host + www) rather than
// reflected — credentials (Authorization) are only granted to allowlisted
// origins, so a hostile page can't ride a signed-in user's session. "*" in the
// list serves the wildcard (without credentials, which browsers forbid anyway).
const corsAllowed = (origin) => !!origin && (CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin));
const cors = (req) => {
  const origin = req.headers.origin;
  const h = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Authorization,Content-Type",
    "Access-Control-Max-Age": "600",
  };
  if (corsAllowed(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Credentials"] = "true";
  } else if (CORS_ORIGINS.includes("*")) {
    h["Access-Control-Allow-Origin"] = "*";                    // wildcard, no credentials
  }
  return h;
};
const json = (res, code, body, req) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store",
                        ...(req ? cors(req) : { "Access-Control-Allow-Origin": "*" }) });
  res.end(JSON.stringify(body));
};

// Reverse-proxy this request to `origin` (an enclave). Streams method+headers+
// body through and pipes the response back, swapping the enclave's CORS for
// ours. This is the API-gateway path: the relay terminates TLS, so it sees the
// control-plane token/body in plaintext (accepted trade for a single origin).
// Attestation fetched this way is informational — real verification stays
// client-side-direct via Tinfoil SecureClient.
// Reverse-proxy `req` to `enclaveOrigin + path`. `setCors`: on the api.enclave.host
// control-plane paths WE own CORS (swap the enclave's for ours); on an app
// subdomain the app is its own origin, so pass its headers through untouched.
function proxyTo(origin, req, res, { path = req.url, setCors = true, idleMs = 30000 } = {}) {
  const target = new URL(origin.replace(/\/+$/, "") + path);
  const headers = { ...req.headers, host: target.host };
  delete headers["accept-encoding"];                          // let the enclave send identity; simpler passthrough
  const lib = target.protocol === "https:" ? https : http;
  const up = lib.request(
    { hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search, method: req.method, headers, timeout: idleMs },
    (upRes) => {
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (/^connection$|^transfer-encoding$/i.test(k)) continue;
        if (setCors && /^access-control-/i.test(k)) continue;
        out[k] = v;
      }
      if (setCors) Object.assign(out, cors(req));
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    });
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", (e) => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json", ...(setCors ? cors(req) : {}) });
                          res.end(JSON.stringify({ error: "upstream_error", message: e.message })); });
  req.pipe(up);
}

const proxied = (p) => p.startsWith("/v1/") || p === "/availability" || p === "/x" || p.startsWith("/x/");

// --- fleet-aware gateway helpers ----------------------------------------------
// Sticky enclave for non-deployment-scoped calls (auth nonces are per-enclave
// state, so /v1/auth/* must land on one box consistently). A GPU enclave is
// preferred because it serves the full API surface (/v1/gpu, card pricing).
const sticky = () =>
     live.filter((e) => e.availability.gpu).sort((a, b) => a.endpoint.localeCompare(b.endpoint))[0]
  || live.slice().sort((a, b) => a.endpoint.localeCompare(b.endpoint))[0] || null;

// Which enclave owns a deployment id — probed once, cached. Two probes:
// /x/:id (unauth; 404 = not here) covers the data path, and the /v1 record
// itself (with the caller's token; 200 = here) covers control-plane calls even
// after the instance is gone (a terminated record still exists on its enclave).
const OWNER = new Map();                                     // dep id -> { endpoint, at }
const OWNER_TTL_MS = 5 * 60_000;
const OWNER_NEG = new Map();                                 // dep id -> at (miss, short-lived; fix 2)
const OWNER_NEG_TTL_MS = 10_000;
const ownerCached = (id) => {
  const hit = OWNER.get(id);
  return (hit && Date.now() - hit.at < OWNER_TTL_MS && live.some((e) => e.endpoint === hit.endpoint))
    ? hit.endpoint : null;
};
const ownerNegRecent = (id) => { const at = OWNER_NEG.get(id); return at != null && Date.now() - at < OWNER_NEG_TTL_MS; };
const ownerLearn = (id, endpoint) => { if (id && endpoint) { OWNER.set(id, { endpoint, at: Date.now() }); OWNER_NEG.delete(id); } };
async function probe(url, init) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch { return null; } finally { clearTimeout(t); }
}
// SECURITY (fix 1c / B3): prefer the deployment's ON-CHAIN runner (the enclave
// that actually claimed the lease) over "first endpoint answering non-404", so
// a hostile enclave can't hijack another tenant's /x traffic by answering for
// its id. Returns the runner's endpoint only when it's a known, in-fleet enclave
// (which is already https-/operator-filtered); null (=> probe fallback) on any
// uncertainty, so a valid deployment never becomes unroutable.
async function runnerEndpointOf(id) {
  const h = String(id).toLowerCase();
  if (!/^0x[0-9a-f]{8,64}$/.test(h)) return null;           // dep_/non-onchain ids: probe path
  let rows; try { rows = await ledgerRows(); } catch { return null; }
  const hits = rows.filter((d) => String(d.id).toLowerCase().startsWith(h));
  if (hits.length !== 1) return null;                       // unknown/ambiguous -> fall back
  const d = hits[0];
  if (ZERO32.test(String(d.runner)) || Number(d.leaseUntil) * 1000 <= Date.now()) return null;
  const runner = String(d.runner).toLowerCase();
  const e = live.find((x) => x.id && x.id.toLowerCase() === runner);
  return e ? e.endpoint : null;
}
async function xOwnerOf(id) {                                // data-path resolve (no auth needed)
  const hit = ownerCached(id); if (hit) return hit;
  const byRunner = await runnerEndpointOf(id);              // fix 1c: on-chain claimer wins
  if (byRunner) { ownerLearn(id, byRunner); return byRunner; }
  if (ownerNegRecent(id)) return null;                      // recent miss: don't re-fan-out (fix 2)
  if (!fanoutReserve(live.length)) return null;             // global fan-out cap (fix 2)
  let ep = null;
  try {
    const found = await Promise.all(live.map(async (e) =>
      (r => r && r.status !== 404 ? e.endpoint : null)(await probe(`${e.endpoint}/x/${encodeURIComponent(id)}`, { method: "HEAD" }))));
    ep = found.find(Boolean) || null;
  } finally { fanoutRelease(live.length); }
  if (ep) ownerLearn(id, ep); else OWNER_NEG.set(id, Date.now());
  return ep;
}
async function v1OwnerOf(id, auth) {                         // control-plane probe (caller's token)
  const hit = ownerCached(id); if (hit) return hit;
  const byRunner = await runnerEndpointOf(id);              // fix 1c: on-chain claimer wins
  if (byRunner) { ownerLearn(id, byRunner); return byRunner; }
  let ep = null;
  if (fanoutReserve(live.length)) {
    try {
      const found = await Promise.all(live.map(async (e) => {
        const r = await probe(`${e.endpoint}/v1/deployments/${encodeURIComponent(id)}`,
                              { headers: auth ? { Authorization: auth, Accept: "application/json" } : { Accept: "application/json" } });
        return r && r.status === 200 ? e.endpoint : null;
      }));
      ep = found.find(Boolean) || null;
    } finally { fanoutRelease(live.length); }
  }
  if (ep) ownerLearn(id, ep);
  return ep || xOwnerOf(id);                                 // fall back to the data-path probe (e.g. expired token)
}

function readBody(req, max = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (ch) => { n += ch.length; if (n > max) { req.destroy(); reject(new Error("body too large")); } else chunks.push(ch); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Buffered forward (vs proxyTo's streaming): used where the relay needs to SEE
// the body or the response — placement reads the create request's shares, and
// the create/list responses teach the owner cache.
async function forward(origin, req, body, path = req.url) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    if (!/^(host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(k)) headers[k] = v;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(origin.replace(/\/+$/, "") + path,
      { method: req.method, headers, body: body && body.length ? body : undefined, signal: ctrl.signal });
    return { status: r.status, contentType: r.headers.get("content-type"), text: await readCappedText(r) };
  } finally { clearTimeout(t); }
}
function sendForwarded(res, r, req) {
  res.writeHead(r.status, { "Cache-Control": "no-store", ...(r.contentType ? { "Content-Type": r.contentType } : {}), ...cors(req) });
  res.end(r.text);
}

// Fleet /availability: the deploy-dial view. Best single-card slice across GPU
// enclaves + best node pool across ALL enclaves (they can be different boxes —
// that is the point of the two-pool model). gpuEnclaveCpuShareFree is the cpu
// pool on the best GPU enclave: a GPU deployment's cpuShare must fit THERE.
//
// spec* fields are for SIZING app specs into minimum shares, and they are the
// fleet-wide MINIMA of the hardware numbers the runners themselves divide by
// in their claim gate. The plain cardVramGb/nodeRamGb describe the BEST box
// (capacity view) — a dial floor computed on the biggest card under-sells on
// every smaller one, and a deployment below a runner's minimum is unclaimable
// there forever (created shares are immutable). Sizing against the minima
// keeps a bought share valid on EVERY live enclave.
function aggregateAvailability() {
  const gpus = live.filter((e) => e.availability.gpu);
  const g = gpus.slice()
    .sort((a, b) => gpuFreeOf(b.availability) - gpuFreeOf(a.availability))[0]?.availability || null;
  const c = live.slice()
    .sort((a, b) => cpuFreeOf(b.availability) - cpuFreeOf(a.availability))[0]?.availability || null;
  const minOf = (rows, field) => rows.reduce((m, e) => {
    const v = Number(e.availability?.[field]);
    return Number.isFinite(v) && v > 0 ? (m > 0 ? Math.min(m, v) : v) : m;
  }, 0);
  return {
    aggregate: true, enclaves: live.length, gpu: !!g, type: g ? "gpu" : "cpu",
    gpuShareFree: g ? gpuFreeOf(g) : 0, cpuShareFree: c ? cpuFreeOf(c) : 0,
    gpuEnclaveCpuShareFree: g ? cpuFreeOf(g) : 0,
    maxShare: g ? gpuFreeOf(g) : (c ? cpuFreeOf(c) : 0),     // deprecated alias, same rule as the enclaves'
    vramFreeGb: g ? g.vramFreeGb ?? 0 : 0, gpuTflopsFree: g ? g.gpuTflopsFree ?? 0 : 0,
    smFree: g ? g.smFree ?? 0 : 0, smTotal: g ? g.smTotal ?? 0 : 0,
    cardVramGb: g ? g.cardVramGb ?? 0 : 0, cardTflops: g ? g.cardTflops ?? 0 : 0, cards: g ? g.cards ?? 0 : 0,
    vcpusFree: c ? c.vcpusFree ?? 0 : 0, ramGbFree: c ? c.ramGbFree ?? 0 : 0, cpuGflopsFree: c ? c.cpuGflopsFree ?? 0 : 0,
    nodeVcpus: c ? c.nodeVcpus ?? 0 : 0, nodeRamGb: c ? c.nodeRamGb ?? 0 : 0, nodeGflops: c ? c.nodeGflops ?? 0 : 0,
    specCardVramGb: minOf(gpus, "cardVramGb"), specCardTflops: minOf(gpus, "cardTflops"),
    specNodeVcpus: minOf(live, "nodeVcpus"), specNodeRamGb: minOf(live, "nodeRamGb"), specNodeGflops: minOf(live, "nodeGflops"),
    // deployment-options capability (per-IP rate limit / WAF): true only when
    // EVERY live enclave enforces the envelope — any runner may claim any
    // deployment, so a mixed fleet would strand protected deploys on old
    // runners ("configCid retired" refusal). Same fleet-minimum rule as spec*.
    waf: live.length > 0 && live.every((e) => e.availability?.waf === true),
    // attached model volumes across the fleet (Modelwrap), deduped by name -
    // each carries `enclaves`: which endpoints can mount it (placement matters,
    // a volume only lives where its enclave declares it)
    volumes: fleetVolumes(),
    source: "api-relay", updatedAt,
  };
}

// Union of every live enclave's advertised model volumes, keyed by name, each
// annotated with the endpoints that carry it.
const MAX_VOLUMES_PER_ENCLAVE = 256;                        // guard a hostile /availability (fix 8)
function fleetVolumes() {
  const byName = new Map();
  for (const e of live) {
    const vols = e.availability?.volumes;
    for (const v of (Array.isArray(vols) ? vols.slice(0, MAX_VOLUMES_PER_ENCLAVE) : [])) {
      if (!v || !v.name) continue;
      const cur = byName.get(v.name) || { name: v.name, bytes: v.bytes || 0, onnx: !!v.onnx, gguf: !!v.gguf, sd: !!v.sd, endpoints: [] };
      cur.bytes = Math.max(cur.bytes, v.bytes || 0);
      cur.onnx = cur.onnx || !!v.onnx;
      cur.gguf = cur.gguf || !!v.gguf;
      cur.sd = cur.sd || !!v.sd;
      if (!cur.endpoints.includes(e.endpoint)) cur.endpoints.push(e.endpoint);
      byName.set(v.name, cur);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const DEP_PATH_RE = /^\/v1\/deployments\/([A-Za-z0-9_-]+)(?:\/|$)/;
const X_PATH_RE   = /^\/x\/([A-Za-z0-9_-]+)(?:\/|$)/;

async function gateway(u, req, res) {
  const p = u.pathname;

  // Ledger-backed reads FIRST: the wallet's list and bare record reads answer
  // from EnclaveDeployments even with zero live enclaves - on-chain work is
  // real whether or not anything currently hosts it.
  if (p === "/v1/deployments" && req.method === "GET") return listDeployments(u, req, res);
  const bare = p.match(/^\/v1\/deployments\/([A-Za-z0-9_-]+)$/);
  if (bare && req.method === "GET") return getDeployment(bare[1], u, req, res);

  if (!live.length) {
    // fleet-down answers that tell the truth about WHAT is down: the API
    // front door (this relay) is healthy - only enclave-served things are out
    if (p === "/v1/health")
      return json(res, 200, { ok: true, enclaves: 0, of: registry.length, gateway: "api-relay",
        note: "API relay up; no live enclaves right now - funded deployments queue on the ledger and are claimed when one returns.", updatedAt }, req);
    if (p.startsWith("/v1/auth/"))
      return json(res, 503, { error: "auth_unavailable",
        message: "Sign-in needs a live enclave (SIWE nonces and session tokens are enclave-issued; this relay deliberately can't mint them) and none is up right now. Everything wallet-signed still works without a session: deploying, funding, top-ups, terminate, and your deployment list.", updatedAt }, req);
    return json(res, 503, { error: "no_capacity", message: "No live enclaves.", updatedAt }, req);
  }
  if (p === "/availability") return json(res, 200, aggregateAvailability(), req);

  const dep = p.match(DEP_PATH_RE), x = p.match(X_PATH_RE);
  if (dep || x) {
    const id = (dep || x)[1];
    // rate-limit only the misses (the fan-out probe); cached routes stay fast (fix 2)
    if (!ownerCached(id) && !rlMiss(clientIp(req)))
      return json(res, 429, { error: "rate_limited", message: "Too many deployment lookups; retry shortly.", updatedAt }, req);
    const owner = dep ? await v1OwnerOf(id, req.headers.authorization) : await xOwnerOf(id);
    if (!owner) return json(res, 404, { error: "not_found", message: `No live enclave has ${id}.`, updatedAt }, req);
    // Tenant data path: generous idle window. A model-serving app's first
    // request can sit silent for the length of a session init (e.g. wasi-nn
    // loading a 100MB+ model onto the GPU under CC); 30s cut those off and
    // the abandoned sync load wedged the tenant's runtime threads.
    return proxyTo(owner, req, res, { idleMs: 180000 });
  }

  if (p === "/v1/apps/upload-token" && req.method === "POST") {
    // Authorize a wasm pin: the publisher signs `enclave-upload:<sha256hex>:<expiry>`
    // with their wallet; we recover the address (viem), rate-limit per wallet, and
    // mint an HMAC token the add-gateway verifies before it pins (the gateway does
    // NO EC crypto and never sees the fleet secret). Closes the open-pin storage DoS.
    if (!UPLOAD_KEY) return json(res, 503, { error: "upload_disabled", message: "Signed uploads are not configured here." }, req);
    let raw; try { raw = await readBody(req, 8192); } catch (e) { return json(res, 413, { error: "too_large", message: e.message }, req); }
    let b; try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: "bad_json", message: "Body must be JSON." }, req); }
    const hash = String(b.hash || "").toLowerCase().replace(/^0x/, "");
    const expiry = parseInt(b.expiry, 10);
    const signature = String(b.signature || "");
    const now = Math.floor(Date.now() / 1000);
    if (!/^[0-9a-f]{64}$/.test(hash)) return json(res, 422, { error: "bad_hash", message: "hash must be the 32-byte sha256 hex of the upload." }, req);
    if (!Number.isFinite(expiry) || expiry < now || expiry > now + 600) return json(res, 422, { error: "bad_expiry", message: "expiry must be a unix time within the next 10 minutes." }, req);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return json(res, 422, { error: "bad_sig", message: "signature must be a 65-byte personal_sign hex." }, req);
    let address;
    try {
      const { recoverMessageAddress } = await import("viem");
      address = (await recoverMessageAddress({ message: `enclave-upload:${hash}:${expiry}`, signature })).toLowerCase();
    } catch (e) { return json(res, 400, { error: "bad_sig", message: "Could not recover the signer: " + (e.shortMessage || e.message) }, req); }
    if (!rlUpload(address)) return json(res, 429, { error: "rate_limited", message: "Too many upload authorizations from this wallet; retry later." }, req);
    const token = createHmac("sha256", UPLOAD_KEY).update(`${address}:${hash}:${expiry}`).digest("hex");
    return json(res, 200, { token, address, expiry }, req);
  }

  if (p === "/v1/claim-hint" && req.method === "POST") {
    // Fan the hint to every live enclave: CPU-only enclaves take CPU work
    // immediately, GPU enclaves skip their CPU-first grace when hinted, and
    // the EnclaveDeployments contract referees any race (the loser's claim tx
    // reverts; gas is cents). Enclaves answer fast - the actual claim runs in
    // their background; deployers watch the ledger for the runner.
    // unauthenticated fan-out amplifier: per-source rate limit + global in-flight
    // cap (fix 2), and the response body from each enclave is size-capped (fix 8).
    if (!rlHint(clientIp(req)))
      return json(res, 429, { error: "rate_limited", message: "Too many claim hints; retry shortly." }, req);
    let body; try { body = await readBody(req); } catch (e) { return json(res, 413, { error: "too_large", message: e.message }, req); }
    if (!fanoutReserve(live.length))
      return json(res, 503, { accepted: false, reason: "Relay busy (fan-out cap); the sweep will still pick the deployment up." }, req);
    let results;
    try {
      results = await Promise.all(live.map(async (e) => {
        try {
          const r = await fetch(e.endpoint + "/v1/claim-hint",
            { method: "POST", headers: { "content-type": "application/json" },
              body, signal: AbortSignal.timeout(15_000) });
          return JSON.parse(await readCappedText(r));
        } catch { return null; }
      }));
    } finally { fanoutRelease(live.length); }
    const best = results.find(r => r && r.accepted) || results.find(Boolean)
              || { accepted: false, reason: "No live enclave answered the hint; the sweep will still pick the deployment up." };
    return json(res, 200, best, req);
  }

  if (p === "/v1/deployments" && req.method === "POST") {    // placement: the ONE routing decision
    let body; try { body = await readBody(req); } catch (e) { return json(res, 413, { error: "too_large", message: e.message }, req); }
    let want = {};
    try { const r = JSON.parse(body.toString() || "{}").resources || {};
          want = { gpuShare: Number(r.gpuShare) || 0, cpuShare: Number(r.cpuShare) || 0 }; } catch {}
    const c = pick(want);
    if (!c) return json(res, 409, { error: "no_capacity",
      message: `No live enclave has gpuShare >= ${want.gpuShare} and cpuShare >= ${want.cpuShare} free.`, updatedAt }, req);
    const r = await forward(c.endpoint, req, body).catch((e) => ({ status: 502, contentType: "application/json",
      text: JSON.stringify({ error: "upstream_error", message: e.message }) }));
    if (r.status === 201) { try { ownerLearn(JSON.parse(r.text).id, c.endpoint); } catch {} }
    return sendForwarded(res, r, req);
  }

  const c = sticky();                                        // auth, pricing, version, attestation, ...
  return proxyTo(c.endpoint, req, res);
}

// The address to scope PUBLIC ledger reads by: a session token's sub when one
// rides the request, else an explicit ?owner= (connected-wallet-only clients -
// everything a ledger row carries is public on-chain data, so naming an owner
// is scoping, not authentication; enclaves still verify tokens for their part).
const ownerScope = (u, req) =>
  tokenAddress(req.headers.authorization)
  || ((o) => /^0x[0-9a-fA-F]{40}$/.test(o) ? o.toLowerCase() : null)(u.searchParams.get("owner") || "");

// One wallet, one list: fan out to the live fleet (hosted rows carry live
// status/network - only for token holders; enclaves verify), then merge
// in the LEDGER's rows for the wallet - every on-chain deployment appears
// whether or not an enclave hosts it right now.
async function listDeployments(u, req, res) {
  const auth = req.headers.authorization;
  const addr = ownerScope(u, req);
  // no token = no enclave view (they'd all 401); the ledger alone answers
  const rs = auth ? await Promise.all(live.map((e) =>
    forward(e.endpoint, req, null).then((r) => ({ e, r })).catch(() => null))) : [];
  const answered = rs.filter(Boolean);
  const oks = answered.filter((x) => x.r.status === 200);
  // the fleet REFUSING a presented token is real (expired/garbage session):
  // surface it rather than mask it with public ledger rows
  if (auth && answered.length && !oks.length && answered.every((x) => x.r.status === 401))
    return sendForwarded(res, answered[0].r, req);
  if (!addr && !oks.length)
    return json(res, 401, { error: "unauthorized", message: "Pass ?owner=0x… (or a session token) to say whose deployments to list." }, req);
  const data = [], seen = new Set();
  // registry-id -> the ids that enclave's 200 list carried. The same token
  // scoped both the fan-out and the ledger loop below, so for THIS owner an
  // answering runner whose list LACKS a leased id is definitive: the lease
  // outlived the local record (enclave restart/update wiped state, or the
  // resume found no capacity) and nothing actually serves the app.
  const hostedByRunner = new Map();
  for (const { e, r } of oks) {
    const ids = new Set();
    try { for (const it of JSON.parse(r.text).data || []) { data.push(it); seen.add(String(it.id).toLowerCase()); ids.add(String(it.id).toLowerCase()); ownerLearn(it.id, e.endpoint); } } catch {}
    if (e.id) hostedByRunner.set(String(e.id).toLowerCase(), ids);
  }
  const tokenOwner = tokenAddress(auth);
  if (addr) {
    try {
      for (const d of await ledgerRows()) {
        if (d.owner.toLowerCase() !== addr || seen.has(d.id.toLowerCase())) continue;
        const view = ledgerView(d);
        // ledgerStatus says "running" for lease-live + runner-alive — but a
        // runner that answered this owner's list WITHOUT the id is not serving
        // it. Show "claimed" (+ stranded) instead of a lie the owner pays for
        // (observed live 2026-07-17: a displaced tenant read RUNNING for 30
        // minutes while its app was dark).
        if (view.status === "running" && tokenOwner && addr === tokenOwner) {
          const hosted = hostedByRunner.get(String(d.runner).toLowerCase());
          if (hosted && !hosted.has(d.id.toLowerCase())) { view.status = "claimed"; view.stranded = true; }
        }
        data.push(view);
      }
    } catch (e) { console.error("[api-relay] ledger read failed:", e.message); }
  }
  return json(res, 200, { data, cursor: null }, req);
}

// Bare record read: for token holders the owning enclave has the live view
// (status transitions, network) - prefer it; tokenless reads (and any id
// no live enclave hosts) answer from the ledger, so watchers keep working
// across enclave restarts, for still-queued work, and with no session at all.
async function getDeployment(id, u, req, res) {
  const auth = req.headers.authorization;
  if (live.length && auth) {
    const owner = await v1OwnerOf(id, auth);
    if (owner) return proxyTo(owner, req, res, { idleMs: 180000 });
  }
  const addr = ownerScope(u, req);
  let rows;
  try { rows = await ledgerRows(); }
  catch (e) { return json(res, 502, { error: "ledger_error", message: e.message, updatedAt }, req); }
  const want = id.toLowerCase();
  // full ids and unique prefixes both resolve (the CLI passes prefixes); an
  // ?owner=/token scope disambiguates, but isn't required - records are public
  const hits = rows.filter((d) => (!addr || d.owner.toLowerCase() === addr) && d.id.toLowerCase().startsWith(want));
  if (hits.length !== 1)
    return json(res, 404, { error: "not_found",
      message: hits.length ? `${id} is ambiguous (${hits.length} deployments match).`
                           : `No live enclave has ${id}, and the ledger has no deployment under it.`, updatedAt }, req);
  return json(res, 200, ledgerView(hits[0]), req);
}

// <label>.<APP_DOMAIN> -> canonical dep_<label>, or null if not an app subdomain.
// The subdomain drops the "dep_" (redundant in this namespace): "abc123" ->
// "dep_abc123". A legacy "dep-abc123" is still accepted.
function depFromHost(host) {
  host = (host || "").toLowerCase().split(":")[0];
  const dom = APP_DOMAINS.find(d => host.endsWith("." + d));
  if (!dom) return null;
  const label = host.slice(0, -(dom.length + 1)).replace(/^dep[-_]/, "");   // strip a legacy prefix if present
  // On-chain (EnclaveDeployments) ids are bytes32; a full 64-hex id exceeds DNS's
  // 63-char label limit, so their subdomain is a hex PREFIX of the id - the
  // canonical label is the FIRST 8 CHARS (32 bits; collisions are fantasy),
  // and any longer prefix keeps working. Enclaves resolve the prefix to the
  // unique matching deployment. (A retired-era dep_ label that happened to be
  // pure hex could shadow here; those deployments no longer exist.)
  const hex = label.startsWith("0x") ? label.slice(2) : label;
  if (/^[0-9a-f]{8,64}$/.test(hex)) return "0x" + hex;
  const id = "dep_" + label;
  return /^dep_[a-z0-9]+$/.test(id) ? id : null;
}

// Does a deployment exist on the fleet? (the /x owner probe: some enclave
// answers non-404 for it.) Gates on-demand TLS issuance so nobody can burn the
// CA rate limit with random <junk>.<APP_DOMAIN> names; the owner cache keeps
// repeat lookups cheap.
const deploymentExists = async (id) => !!(await xOwnerOf(id));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");

  // On-demand TLS gate: Caddy asks before minting a cert for <host>. Allow only
  // real deployment subdomains so random <junk>.<APP_DOMAIN> can't burn the CA
  // rate limit. Reached on loopback from Caddy — restricted to loopback (fix 11)
  // and rate-limited on the miss (fix 2) so it can't be driven as a fan-out probe.
  if (u.pathname === "/internal/tls-ask") {
    if (!isLoopback(req)) { res.writeHead(403); return res.end("forbidden"); }
    const id = depFromHost(u.searchParams.get("domain") || "");
    if (!id) { res.writeHead(400); return res.end("bad domain"); }
    if (!ownerCached(id) && !rlMiss(clientIp(req))) { res.writeHead(429); return res.end("rate limited"); }
    return deploymentExists(id).then((ok) => { res.writeHead(ok ? 200 : 404); res.end(); });
  }

  // App subdomain: <dep-id>.<APP_DOMAIN> is the deployment's OWN origin. Route it
  // to the OWNING enclave's /x/<id> data path, passing the app's own headers
  // through (it's a distinct origin, so the gateway doesn't impose CORS).
  const depHost = depFromHost(routingHost(req));            // x-forwarded-host only when TRUSTED_PROXY (fix 6)
  if (depHost) {
    if (!ownerCached(depHost) && !rlMiss(clientIp(req))) return json(res, 429, { error: "rate_limited", message: "Too many lookups; retry shortly." });
    return xOwnerOf(depHost).then((owner) => {
      if (!owner) return json(res, 404, { error: "not_found", message: "No live enclave has " + depHost + "." });
      const rest = req.url === "/" ? "/" : req.url;           // preserve path+query under /x/<id>
      // same generous idle window as the /x data path (see gateway()): app
      // subdomains ARE the data path, and long-silent first bytes are real
      proxyTo(owner, req, res, { path: "/x/" + depHost + rest, setCors: false, idleMs: 180000 });
    });
  }

  if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); return res.end(); }   // preflight for any path

  if (u.pathname === "/health")
    return json(res, 200, { ok: true, enclaves: live.length, of: registry.length, updatedAt }, req);

  if (u.pathname === "/enclaves") {
    const agg = {
      enclaves: live.length,
      totalGpuShareFree: Math.round(live.reduce((s, e) => s + gpuFreeOf(e.availability), 0) * 1000) / 1000,
      totalCpuShareFree: Math.round(live.reduce((s, e) => s + cpuFreeOf(e.availability), 0) * 1000) / 1000,
      totalVramFreeGb: Math.round(live.reduce((s, e) => s + (e.availability.vramFreeGb || 0), 0) * 10) / 10,
    };
    return json(res, 200, { updatedAt, aggregate: agg, enclaves: live }, req);
  }

  if (u.pathname === "/route") {
    // ?gpuShare=&cpuShare= — the two shares the deployment intends to buy
    // (0..1). gpuShare 0 = CPU-only (CPU enclaves preferred, GPU leftovers as
    // fallback). Legacy ?share= is read as gpuShare.
    const want = {
      gpuShare: parseFloat(u.searchParams.get("gpuShare") ?? u.searchParams.get("share") ?? "0") || 0,
      cpuShare: parseFloat(u.searchParams.get("cpuShare") || "0") || 0,
    };
    const c = pick(want);
    if (!c) return json(res, 503, { error: "no_capacity",
      message: `No live enclave has gpuShare >= ${want.gpuShare} and cpuShare >= ${want.cpuShare} free.`, updatedAt }, req);
    return json(res, 200, { endpoint: c.endpoint, repo: c.repo, availability: c.availability, updatedAt,
                            note: "Verify attestation at the endpoint (Tinfoil SecureClient + repo) before sending anything." }, req);
  }

  // API gateway: fleet-aware routing (see the header) — placement on create,
  // owner affinity on deployment-scoped calls, fan-out merge on list, fleet
  // aggregate on /availability, sticky enclave for the rest.
  if (proxied(u.pathname))
    return gateway(u, req, res).catch((e) =>
      json(res, 502, { error: "gateway_error", message: e.message, updatedAt }, req));

  json(res, 404, { error: "not_found", routes: ["/health", "/enclaves", "/route?gpuShare=0.25&cpuShare=0.05", "/v1/* /x/* /availability (fleet-routed to the enclaves)"] }, req);
});

// WebSocket upgrades. Node hands Upgrade requests to an 'upgrade' listener, not
// the request handler — without one the relay silently ate the enclaves' WS
// surfaces (the /x/:id/tcp/:port raw-TCP bridge, any app's own websockets) and
// bridge clients had to bypass the gateway for the enclave origin. Routing
// mirrors the request path: an app subdomain maps onto the owner's /x/<id>
// data path, a gateway /x/<id>/... URL passes through verbatim. The relay
// forwards the handshake bytes untouched and splices sockets after it — it
// never speaks WS itself, so anything the enclave upgrades to just works.
const UPGRADE_IDLE_MS = 180000;                              // match the /x data path's window
// The supervisor's WS bridges look deployments up by EXACT id (deployments.get),
// unlike its HTTP /x path which resolves hex prefixes — so a subdomain label
// (8-hex prefix) must be canonicalized to the full ledger id before proxying.
// Falls back to the given id when the ledger can't answer or the prefix is
// ambiguous; full-id URLs then still work exactly as before.
async function fullDepId(id) {
  if (!/^0x[0-9a-f]{8,63}$/.test(id)) return id;             // full 64-hex (or non-ledger-shaped): pass through
  try {
    const hits = (await ledgerRows()).filter((d) => String(d.id).toLowerCase().startsWith(id));
    if (hits.length === 1) return String(hits[0].id).toLowerCase();
  } catch {}
  return id;
}
server.on("upgrade", async (req, socket, head) => {
  socket.on("error", () => socket.destroy());               // dead client mid-handshake must not throw
  const refuse = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); };
  try {
    const depHost = depFromHost(routingHost(req));           // x-forwarded-host only when TRUSTED_PROXY (fix 6)
    const x = depHost ? null : (req.url || "").match(X_PATH_RE);
    if (!depHost && !x) return refuse(404, "Not Found");
    const id = await fullDepId(depHost || x[1]);
    const owner = await xOwnerOf(id);
    if (!owner) return refuse(404, "Not Found");
    const rest = depHost ? (req.url === "/" ? "/" : req.url) : req.url.slice(3 + (x[1].length));  // after "/x/<id>"
    const path = "/x/" + id + rest;
    const target = new URL(owner.replace(/\/+$/, "") + path);
    const secure = target.protocol === "https:";
    const up = (secure ? tls : net).connect({
      host: target.hostname, port: +target.port || (secure ? 443 : 80),
      ...(secure ? { servername: target.hostname } : {}),
    }, () => {
      let raw = `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2)     // rawHeaders keeps order, casing, duplicates
        raw += `${req.rawHeaders[i]}: ${/^host$/i.test(req.rawHeaders[i]) ? target.host : req.rawHeaders[i + 1]}\r\n`;
      up.write(raw + "\r\n");
      if (head?.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    const drop = () => { socket.destroy(); up.destroy(); };
    up.setTimeout(UPGRADE_IDLE_MS, drop); socket.setTimeout(UPGRADE_IDLE_MS, drop);
    up.on("error", drop); up.on("close", drop); socket.on("close", drop);
  } catch (e) { refuse(502, "Bad Gateway"); }
});

await pollRegistry();
await resolveDeployments();
await pollAvailability();
setInterval(pollRegistry, REGISTRY_POLL_SEC * 1000);
setInterval(resolveDeployments, REGISTRY_POLL_SEC * 1000);
setInterval(pollAvailability, AVAIL_POLL_SEC * 1000);

const BIND = process.env.API_RELAY_BIND || undefined;
if (!BIND) console.error("[api-relay] NOTE: binding ALL interfaces (no API_RELAY_BIND). If a local Caddy fronts this relay, set API_RELAY_BIND=127.0.0.1 so :" + PORT + " isn't reachable directly.");
server.listen(PORT, BIND, () => console.log(
  `[api-relay] :${PORT}${BIND ? " (" + BIND + ")" : ""} · ${STATIC_ENCLAVES.length ? `static list (${STATIC_ENCLAVES.length})` : `EnclaveRegistry ${REGISTRY_ADDRESS}`} · ${live.length}/${registry.length} live`
  + (STATIC_ENCLAVES.length || !OPERATORS_UNRESTRICTED ? "" : " · UNAUTHENTICATED fleet (TRUSTED_OPERATORS=*)")));
