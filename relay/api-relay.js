// Enclave API relay — discovery + placement front door for the fleet. UNTRUSTED
// as a router (it can misroute, not impersonate: enclaves are attested on
// their own origins), but on the /v1 gateway path it IS a TLS terminator and
// sees control-plane traffic — accepted trade for giving browsers one origin.
//
// It reads EnclaveRegistry on Base for live enclaves (slow-moving truth: who
// exists), polls each one's public /availability (fast-moving truth: free
// capacity), and routes each request by what it IS. A deployment lives on ONE
// enclave, sessions are stateless JWTs (HS256 over the enclave SECRET — give
// every enclave the SAME secret or a login only works on the enclave that
// issued it), and only CREATION is a placement decision:
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
//   API_RELAY_BIND     optional    bind address (default all interfaces; set
//                                  127.0.0.1 when fronted by a local reverse proxy)
//   AVAIL_POLL_SEC     optional    availability poll cadence (default 10)
//   REGISTRY_POLL_SEC  optional    registry re-read cadence (default 300)
//   STALE_AFTER_SEC    optional    drop enclaves silent on-chain > this (3600)

import http from "node:http";
import https from "node:https";

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
  return Promise.all(out
    .filter((e) => e.active && now - Number(e.lastSeen) <= STALE_AFTER_SEC)
    .map(async (e) => {
      const endpoint = e.endpoint.replace(/\/+$/, "");
      return { endpoint, id: await endpointId(endpoint), repo: e.repo, lastSeen: Number(e.lastSeen) };
    }));
}

// --- EnclaveDeployments ledger (the source of truth for a wallet's work) --------
// The fleet only reports deployments it currently HOSTS; created/funded/stopped
// records live on-chain regardless, so the list/get endpoints read the ledger
// too. Resolved from the address book like the registry; paged eth_calls (no
// log scans - public RPCs cap those), cached briefly.
const BOOK_KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473" + "0".repeat(42);   // "deployments" ascii right-padded
const DEP_ABI = [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
      { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "sshPubKey", type: "string" }, { name: "configCid", type: "string" },
      { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
      { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
      { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
      { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
      { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
      { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
    ] }] },
];
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
      const total = Number(await c.readContract({ address: DEPLOYMENTS_ADDRESS, abi: DEP_ABI, functionName: "count" }));
      const rows = [];
      for (let start = 0; start < total; start += 50)
        rows.push(...await c.readContract({ address: DEPLOYMENTS_ADDRESS, abi: DEP_ABI,
          functionName: "getPage", args: [BigInt(start), 50n] }));
      _ledger.rows = rows; _ledger.at = Date.now();
      return rows;
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
// the owner.
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
  return "queued";
}
// Shape a ledger record like the enclaves' own rows (supervisor view()), so
// dashboards/CLIs treat both alike. `ledger: true` marks the synthesis - logs,
// ssh and attestation exist only once a runner hosts it.
function ledgerView(d) {
  const rate6 = Number(d.rate);                               // per-second price, 6dp USDC
  return {
    id: d.id, owner: d.owner.toLowerCase(), status: ledgerStatus(d), public: d.isPublic,
    image: { reference: d.appRef },
    resources: { gpuShare: Number(d.gpuMilli) / 1000, cpuShare: Number(d.cpuMilli) / 1000 },
    createdAt: new Date(Number(d.createdAt) * 1000).toISOString(),
    ratePerSecondUsdc: (rate6 / 1e6).toFixed(7),
    spentUsdc: (Number(d.spent6) / 1e6).toFixed(2),
    paidUsdc: ((Number(d.balance6) + Number(d.spent6)) / 1e6).toFixed(2),
    timeRemainingSec: rate6 > 0 ? Math.floor(Number(d.balance6) / rate6) : null,
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
  try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

let registry = [];                 // [{endpoint, id, repo, lastSeen}] (id = the registry's keccak256(endpoint))
let live = [];                     // registry ∩ answering, each + {availability, checkedAt}
let updatedAt = null;

async function pollRegistry() {
  try { registry = await readRegistry(); }
  catch (e) { console.error("[api-relay] registry read failed:", e.message); }
}
async function pollAvailability() {
  const rows = await Promise.all(registry.map(async (e) => {
    const a = await fetchJson(`${e.endpoint}/availability`);
    return a ? { ...e, availability: a, checkedAt: new Date().toISOString() } : null;
  }));
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
// CORS: the browser page (https://enclave.host) talks only to this relay, so WE must
// answer preflight and stamp CORS on every response. Reflect the Origin (so
// Authorization works without the wildcard-vs-credentials clash) and echo the
// requested headers on preflight.
const cors = (req) => ({
  "Access-Control-Allow-Origin": req.headers.origin || "*",
  "Vary": "Origin",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Authorization,Content-Type",
  "Access-Control-Max-Age": "600",
});
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
const ownerCached = (id) => {
  const hit = OWNER.get(id);
  return (hit && Date.now() - hit.at < OWNER_TTL_MS && live.some((e) => e.endpoint === hit.endpoint))
    ? hit.endpoint : null;
};
const ownerLearn = (id, endpoint) => { if (id && endpoint) OWNER.set(id, { endpoint, at: Date.now() }); };
async function probe(url, init) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch { return null; } finally { clearTimeout(t); }
}
async function xOwnerOf(id) {                                // data-path probe (no auth needed)
  const hit = ownerCached(id); if (hit) return hit;
  const found = await Promise.all(live.map(async (e) =>
    (r => r && r.status !== 404 ? e.endpoint : null)(await probe(`${e.endpoint}/x/${encodeURIComponent(id)}`, { method: "HEAD" }))));
  const ep = found.find(Boolean) || null;
  if (ep) ownerLearn(id, ep);
  return ep;
}
async function v1OwnerOf(id, auth) {                         // control-plane probe (caller's token)
  const hit = ownerCached(id); if (hit) return hit;
  const found = await Promise.all(live.map(async (e) => {
    const r = await probe(`${e.endpoint}/v1/deployments/${encodeURIComponent(id)}`,
                          { headers: auth ? { Authorization: auth, Accept: "application/json" } : { Accept: "application/json" } });
    return r && r.status === 200 ? e.endpoint : null;
  }));
  const ep = found.find(Boolean) || null;
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
    return { status: r.status, contentType: r.headers.get("content-type"), text: await r.text() };
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
function aggregateAvailability() {
  const g = live.filter((e) => e.availability.gpu)
    .sort((a, b) => gpuFreeOf(b.availability) - gpuFreeOf(a.availability))[0]?.availability || null;
  const c = live.slice()
    .sort((a, b) => cpuFreeOf(b.availability) - cpuFreeOf(a.availability))[0]?.availability || null;
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
    // attached model volumes across the fleet (Modelwrap), deduped by name -
    // each carries `enclaves`: which endpoints can mount it (placement matters,
    // a volume only lives where its enclave declares it)
    volumes: fleetVolumes(),
    source: "api-relay", updatedAt,
  };
}

// Union of every live enclave's advertised model volumes, keyed by name, each
// annotated with the endpoints that carry it.
function fleetVolumes() {
  const byName = new Map();
  for (const e of live) {
    for (const v of (e.availability?.volumes || [])) {
      if (!v || !v.name) continue;
      const cur = byName.get(v.name) || { name: v.name, bytes: v.bytes || 0, onnx: !!v.onnx, endpoints: [] };
      cur.bytes = Math.max(cur.bytes, v.bytes || 0);
      cur.onnx = cur.onnx || !!v.onnx;
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
    const owner = dep ? await v1OwnerOf(id, req.headers.authorization) : await xOwnerOf(id);
    if (!owner) return json(res, 404, { error: "not_found", message: `No live enclave has ${id}.`, updatedAt }, req);
    // Tenant data path: generous idle window. A model-serving app's first
    // request can sit silent for the length of a session init (e.g. wasi-nn
    // loading a 100MB+ model onto the GPU under CC); 30s cut those off and
    // the abandoned sync load wedged the tenant's runtime threads.
    return proxyTo(owner, req, res, { idleMs: 180000 });
  }

  if (p === "/v1/claim-hint" && req.method === "POST") {
    // Fan the hint to every live enclave: CPU-only enclaves take CPU work
    // immediately, GPU enclaves skip their CPU-first grace when hinted, and
    // the EnclaveDeployments contract referees any race (the loser's claim tx
    // reverts; gas is cents). Enclaves answer fast - the actual claim runs in
    // their background; deployers watch the ledger for the runner.
    let body; try { body = await readBody(req); } catch (e) { return json(res, 413, { error: "too_large", message: e.message }, req); }
    const results = await Promise.all(live.map(async (e) => {
      try {
        const r = await fetch(e.endpoint + "/v1/claim-hint",
          { method: "POST", headers: { "content-type": "application/json" },
            body, signal: AbortSignal.timeout(15_000) });
        return await r.json();
      } catch { return null; }
    }));
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
// status/network/ssh - only for token holders; enclaves verify), then merge
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
  for (const { e, r } of oks) {
    try { for (const it of JSON.parse(r.text).data || []) { data.push(it); seen.add(String(it.id).toLowerCase()); ownerLearn(it.id, e.endpoint); } } catch {}
  }
  if (addr) {
    try {
      for (const d of await ledgerRows()) {
        if (d.owner.toLowerCase() !== addr || seen.has(d.id.toLowerCase())) continue;
        data.push(ledgerView(d));
      }
    } catch (e) { console.error("[api-relay] ledger read failed:", e.message); }
  }
  return json(res, 200, { data, cursor: null }, req);
}

// Bare record read: for token holders the owning enclave has the live view
// (status transitions, network, ssh) - prefer it; tokenless reads (and any id
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
  // rate limit. (Reached on loopback from Caddy; harmless if hit publicly.)
  if (u.pathname === "/internal/tls-ask") {
    const id = depFromHost(u.searchParams.get("domain") || "");
    if (!id) { res.writeHead(400); return res.end("bad domain"); }
    return deploymentExists(id).then((ok) => { res.writeHead(ok ? 200 : 404); res.end(); });
  }

  // App subdomain: <dep-id>.<APP_DOMAIN> is the deployment's OWN origin. Route it
  // to the OWNING enclave's /x/<id> data path, passing the app's own headers
  // through (it's a distinct origin, so the gateway doesn't impose CORS).
  const depHost = depFromHost(req.headers["x-forwarded-host"] || req.headers.host);
  if (depHost) {
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

await pollRegistry();
await resolveDeployments();
await pollAvailability();
setInterval(pollRegistry, REGISTRY_POLL_SEC * 1000);
setInterval(resolveDeployments, REGISTRY_POLL_SEC * 1000);
setInterval(pollAvailability, AVAIL_POLL_SEC * 1000);

server.listen(PORT, process.env.API_RELAY_BIND || undefined, () => console.log(
  `[api-relay] :${PORT} · ${STATIC_ENCLAVES.length ? `static list (${STATIC_ENCLAVES.length})` : `EnclaveRegistry ${REGISTRY_ADDRESS}`} · ${live.length}/${registry.length} live`));
