// Enclave relay fleet discovery — shared by the DATA-PLANE relays (tcp6-relay,
// udp-relay, egress-relay) so they follow an arbitrary, CHANGING set of
// enclaves instead of being pinned to one by env. The fleet can grow and
// shrink at any time; nobody should be hand-editing relay env files when it
// does.
//
// Two sources, same precedence as api-relay.js:
//   ENCLAVES           static comma list of enclave origins (wins if set)
//   ENCLAVE_URL        legacy single-enclave pin — folded into the list, so
//                      existing env files keep working unchanged
//   REGISTRY_ADDRESS   EnclaveRegistry on Base (chain 8453): the on-chain truth of
//                      the live fleet, re-read every REGISTRY_POLL_SEC and
//                      filtered to active + recently-seen entries. This is the
//                      set-and-forget mode: a new enclave registers itself and
//                      every relay picks it up within one poll.
//
// The registry read mirrors api-relay.js / scripts/enclave-discover.mjs (count +
// getPage paging). This module holds NO trust: it only tells the relays which
// origins to serve; every origin still authenticates the relay (egress) or
// scopes it to public deployments (tcp6/udp) exactly as before.

import { isBlockedHost } from "./net-guard.mjs";

// Process-level safety net for the long-lived relay daemons. Node's default is
// --unhandled-rejections=throw, so a single stray rejection from any poller or a
// detached async in a request handler would otherwise crash the daemon and dark
// the relay. Log-and-continue on rejections (every request/poll is already
// independently try/caught); log-and-exit(1) on a genuine uncaughtException so
// systemd (Restart=always on the relay units) restarts from a clean state.
export function installProcessGuards(name, log = console.error) {
  if (installProcessGuards._done) return;   // idempotent per process
  installProcessGuards._done = true;
  process.on("unhandledRejection", (r) => log(`[${name}] unhandledRejection:`, r instanceof Error ? (r.stack || r.message) : r));
  process.on("uncaughtException", (e) => { log(`[${name}] uncaughtException:`, (e && e.stack) || e); process.exit(1); });
}

const DEFAULTS = {
  baseRpc: "https://mainnet.base.org",
  registryPollSec: 300,
  staleAfterSec: 3600,
};

// Parse the fleet-related env once. Returns { staticList, registryAddress,
// baseRpc, registryPollSec, staleAfterSec }; the caller decides what "neither
// source set" means (the daemons treat it as fatal).
export function fleetConfig(env = process.env) {
  const staticList = [...new Set([env.ENCLAVES, env.ENCLAVE_URL]
    .filter(Boolean).join(",")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean))];
  return {
    staticList,
    registryAddress: (env.REGISTRY_ADDRESS || "").trim(),
    addressBook: (env.ADDRESS_BOOK_ADDRESS || "").trim(),
    // EnclaveDeployments ledger (env fallback; the address book overrides). Only
    // read on demand by the runner resolver (relay.js's app-subdomain fallback);
    // the origin-following daemons never touch it.
    deploymentsAddress: (env.DEPLOYMENTS_ADDRESS || "").trim(),
    baseRpc: env.BASE_RPC || DEFAULTS.baseRpc,
    registryPollSec: parseInt(env.REGISTRY_POLL_SEC || "", 10) || DEFAULTS.registryPollSec,
    staleAfterSec: parseInt(env.STALE_AFTER_SEC || "", 10) || DEFAULTS.staleAfterSec,
    // Operator allowlist. Comma-separated, lowercased EnclaveRegistry operator
    // addresses. On-chain discovery is filtered to endpoints whose registry
    // `operator` is in the list, so tokens / the egress token / data-path traffic
    // only ever reach vetted operators (closes the permissionless-registry trust
    // gap). FAIL CLOSED: unset/empty falls back to the BAKED canonical operator
    // set (never "follow everyone"), so a rebuilt egress/dns relay can't silently
    // reopen the boundary. Explicit unrestricted mode is opt-in: set it to *.
    trustedOperators: parseTrustedOperators(env.TRUSTED_OPERATORS),
    operatorsUnrestricted: /^(\*|any|all)$/i.test((env.TRUSTED_OPERATORS ?? "").trim()),
  };
}

const DEFAULT_TRUSTED_OPERATORS = ["0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1"]; // canonical Enclave fleet operator
function parseTrustedOperators(raw) {
  const s = (raw ?? "").trim();
  if (/^(\*|any|all)$/i.test(s)) return [];              // explicit unrestricted opt-in
  const list = s.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_TRUSTED_OPERATORS.slice();
}

const BOOK_ABI = [
  { type: "function", name: "addr", stateMutability: "view",
    inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
];
// "registry" as ascii-right-padded bytes32 (the EnclaveAddressBook key)
const BOOK_KEY_REGISTRY = "0x7265676973747279000000000000000000000000000000000000000000000000";

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

// EnclaveDeployments — only the fields the runner resolver needs; the full tuple
// shape is required so viem can decode getPage()'s ABI-packed pages.
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
const BOOK_KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473" + "0".repeat(42); // "deployments" ascii, right-padded
const ZERO32 = /^0x0+$/;

// SECURITY (B1/B2/B3): anyone can register an endpoint on the permissionless
// registry, so the relay must not blindly follow every row. `endpoint` must be
// https: (enclaves are https — a non-https discovered endpoint is a downgrade/
// impersonation attempt, never a real enclave) and, when TRUSTED_OPERATORS is
// set, its `operator` must be allowlisted.
const isHttpsEndpoint = (ep) => { try { return new URL(ep).protocol === "https:"; } catch { return false; } };
let _warnedUnauth = false;
function warnIfUnauthenticated(cfg, log) {
  if (!cfg.operatorsUnrestricted || _warnedUnauth) return;
  _warnedUnauth = true;
  log("WARNING: TRUSTED_OPERATORS=* — this relay follows EVERY endpoint in the permissionless " +
      "EnclaveRegistry with no operator allowlist, by explicit configuration. Session tokens / the egress " +
      "token / data-path traffic may be routed to attacker-registered endpoints. Unset TRUSTED_OPERATORS " +
      "to restrict the fleet to the vetted operator set.");
}

// createFleet(cfg, log) -> { origins(), start() }
//   origins()  the current enclave https origins (static list, or the last
//              successful registry read — kept on read failure, never cleared)
//   start()    resolves after the first registry read in registry mode (so a
//              daemon's first reconcile already sees the fleet); schedules the
//              re-reads. No-op in static mode.
export function createFleet(cfg, log = () => {}) {
  let origins = cfg.staticList;

  // Shared on-chain runner resolver (used by relay.js's app-subdomain fallback,
  // fix 1c). Reads EnclaveDeployments lazily + cached; maps a deployment id (full
  // bytes32 or a unique hex prefix) to the endpoint whose keccak256(endpoint)
  // equals its on-chain `runner`, but ONLY if that endpoint is in the current
  // (already https-/operator-filtered) fleet. Returns null on any uncertainty so
  // the caller safely falls back to probing — a valid deployment never 404s from
  // this alone.
  let _runnerClient = null, _deploymentsAddress = cfg.deploymentsAddress;
  let _hashEndpoint = null;
  const _endpointIdCache = new Map();
  let _ledger = { rows: [], at: 0 };
  async function runnerClient() {
    if (!_runnerClient) {
      const { createPublicClient, http } = await import("viem");
      const { base } = await import("viem/chains");
      _runnerClient = createPublicClient({ chain: base, transport: http(cfg.baseRpc) });
    }
    return _runnerClient;
  }
  async function endpointId(ep) {
    if (_endpointIdCache.has(ep)) return _endpointIdCache.get(ep);
    if (!_hashEndpoint) {
      const { keccak256, stringToBytes } = await import("viem");
      _hashEndpoint = (s) => keccak256(stringToBytes(s));
    }
    const id = _hashEndpoint(ep).toLowerCase();
    _endpointIdCache.set(ep, id);
    return id;
  }
  async function deploymentsAddress(c) {
    if (cfg.addressBook) {
      try {
        const a = await c.readContract({ address: cfg.addressBook, abi: BOOK_ABI,
          functionName: "addr", args: [BOOK_KEY_DEPLOYMENTS] });
        if (a && !/^0x0{40}$/i.test(a)) _deploymentsAddress = a;
      } catch { /* keep last known */ }
    }
    return _deploymentsAddress;
  }
  // ledger struct shape, sniffed per address (rev-1 contracts revert the call)
  let _depShape = { addr: null, abi: depAbiFor(DEP_TUPLE_V1) };
  async function depAbi(c, addr) {
    if (_depShape.addr === addr) return _depShape.abi;
    try {
      const rev = Number(await c.readContract({ address: addr,
        abi: [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "deploymentsSchema" }));
      _depShape = { addr, abi: depAbiFor(rev >= 2 ? DEP_TUPLE : DEP_TUPLE_V1) };
    } catch (e) {
      if (/ContractFunction|CallExecution/.test(e?.name || "")) _depShape = { addr, abi: depAbiFor(DEP_TUPLE_V1) };
      else return depAbiFor(DEP_TUPLE_V1);   // transport error: don't cache, retry next call
    }
    return _depShape.abi;
  }
  async function ledgerRows() {
    if (Date.now() - _ledger.at < 10_000) return _ledger.rows;
    const c = await runnerClient();
    const addr = await deploymentsAddress(c);
    if (!addr) return [];
    const abi = await depAbi(c, addr);
    const total = Number(await c.readContract({ address: addr, abi, functionName: "count" }));
    const rows = [];
    for (let start = 0; start < total; start += 50)
      rows.push(...await c.readContract({ address: addr, abi,
        functionName: "getPage", args: [BigInt(start), 50n] }));
    _ledger = { rows, at: Date.now() };
    return rows;
  }
  async function runnerEndpointFor(id) {
    const h = String(id).toLowerCase();
    if (!/^0x[0-9a-f]{8,64}$/.test(h)) return null;   // dep_ / non-onchain ids: probe path
    if (!cfg.addressBook && !cfg.deploymentsAddress) return null;
    let rows;
    try { rows = await ledgerRows(); } catch { return null; }
    const hits = rows.filter((d) => String(d.id).toLowerCase().startsWith(h));
    if (hits.length !== 1) return null;               // unknown/ambiguous -> fall back
    const d = hits[0];
    if (ZERO32.test(String(d.runner)) || Number(d.leaseUntil) * 1000 <= Date.now()) return null;
    const runner = String(d.runner).toLowerCase();
    for (const ep of origins) if ((await endpointId(ep)) === runner) return ep;   // known + in-fleet
    return null;
  }

  if (cfg.staticList.length) {
    return { origins: () => origins, runnerEndpointFor,
             async start() { log(`static fleet: ${origins.join(", ")}`); } };
  }

  let client = null;
  let registryAddress = cfg.registryAddress;   // env fallback; the book (below) overrides
  async function readRegistry() {
    if (!client) {
      const { createPublicClient, http } = await import("viem");
      const { base } = await import("viem/chains");
      client = createPublicClient({ chain: base, transport: http(cfg.baseRpc) });
    }
    // ADDRESS_BOOK_ADDRESS set: resolve the registry from the on-chain book
    // each cycle, so a registry redeploy reaches the relay boxes with one
    // owner tx instead of hand-editing /etc/nan-relay/*.env (the drift that
    // broke egress on 2026-07-07). Failure falls back to the last known.
    if (cfg.addressBook) {
      try {
        const a = await client.readContract({ address: cfg.addressBook, abi: BOOK_ABI,
          functionName: "addr", args: [BOOK_KEY_REGISTRY] });
        if (a && !/^0x0{40}$/i.test(a) && a.toLowerCase() !== registryAddress.toLowerCase()) {
          log(`address book: registry ${registryAddress || "(unset)"} -> ${a}`);
          registryAddress = a;
        }
      } catch (e) { /* keep the current registry address; next cycle retries */ }
    }
    if (!registryAddress) throw new Error("no registry address (book unresolved and REGISTRY_ADDRESS unset)");
    const total = Number(await client.readContract({
      address: registryAddress, abi: ABI, functionName: "count" }));
    const rows = [];
    for (let start = 0; start < total; start += 50)
      rows.push(...await client.readContract({ address: registryAddress, abi: ABI,
        functionName: "getPage", args: [BigInt(start), 50n] }));
    const now = Math.floor(Date.now() / 1000);
    warnIfUnauthenticated(cfg, log);
    const ops = cfg.trustedOperators;
    return rows
      .filter((e) => e.active && now - Number(e.lastSeen) <= cfg.staleAfterSec)
      // B2: only vetted operators (baked default, or the env allowlist). Pass-all
      // ONLY under the explicit TRUSTED_OPERATORS=* opt-in — never by omission.
      .filter((e) => cfg.operatorsUnrestricted || ops.includes(String(e.operator || "").toLowerCase()))
      .map((e) => e.endpoint.replace(/\/+$/, ""))
      // B1/B3: never dial a non-https discovered endpoint (enclaves are https)
      .filter((ep) => { const ok = isHttpsEndpoint(ep); if (!ok) log(`skipping non-https registry endpoint: ${ep}`); return ok; })
      // SSRF: drop endpoints whose host is a literal private/loopback/link-local
      // IP (or localhost) so a permissionless-registry row can't make the data-
      // plane relays dial the relay box's own localhost / cloud metadata.
      .filter((ep) => { let h; try { h = new URL(ep).hostname; } catch { return false; } const ok = !isBlockedHost(h); if (!ok) log(`skipping non-global registry endpoint: ${ep}`); return ok; });
  }

  async function refresh() {
    try {
      const next = [...new Set(await readRegistry())];
      if (next.join(",") !== origins.join(","))
        log(`fleet: ${next.length ? next.join(", ") : "(empty)"}`);
      origins = next;
    } catch (e) {
      // keep the last known fleet — a flaky RPC must not unbind live relays
      log(`registry read failed (keeping ${origins.length} known): ${e.message}`);
    }
  }

  return {
    origins: () => origins,
    runnerEndpointFor,
    async start() {
      log(`on-chain fleet: ${cfg.addressBook ? "EnclaveAddressBook " + cfg.addressBook + " -> registry" : "EnclaveRegistry " + cfg.registryAddress}`
          + (cfg.operatorsUnrestricted ? " · UNAUTHENTICATED (TRUSTED_OPERATORS=*)" : ` · trusted operators: ${cfg.trustedOperators.length}`));
      await refresh();
      setInterval(refresh, cfg.registryPollSec * 1000);
    },
  };
}

// Read a fetch Response body as text but abort past `max` bytes — discovered
// endpoints are untrusted, so an unbounded /availability or /net-map must not
// be able to OOM a relay (fix 8). Default 8 MiB covers the largest legitimate
// fleet map with wide margin.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export async function readCappedText(r, max = MAX_BODY_BYTES) {
  if (!r.body) return await r.text();
  const reader = r.body.getReader();
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch {} throw new Error("response body too large"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Small shared helper: GET url, JSON on 2xx, null on anything else (timeout,
// refused, non-2xx, oversize) — per-origin poll failures are data, not exceptions.
export async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? JSON.parse(await readCappedText(r)) : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}
