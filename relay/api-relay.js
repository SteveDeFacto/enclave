// NAN API relay — discovery + placement front door for the fleet. UNTRUSTED
// as a router (it can misroute, not impersonate: enclaves are attested on
// their own origins), but on the /v1 gateway path it IS a TLS terminator and
// sees control-plane traffic — accepted trade for giving browsers one origin.
//
// It reads NanRegistry on Base for live enclaves (slow-moving truth: who
// exists), polls each one's public /availability (fast-moving truth: free
// capacity), and routes each request by what it IS. A deployment lives on ONE
// enclave, sessions are stateless JWTs (HS256 over the enclave SECRET — give
// every enclave the SAME secret or a login only works on the enclave that
// issued it), and only CREATION is a placement decision:
//
//   POST /v1/deployments        -> pick() by the body's resources.{gpuShare,cpuShare}
//                                  (CPU-only work -> CPU enclaves first; GPU work
//                                  -> a GPU enclave with both pools free)
//   GET  /v1/deployments        -> fan out to every live enclave, merge the lists
//   /v1/deployments/:id*, /x/:id* and app subdomains
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
//   REGISTRY_ADDRESS   required*   NanRegistry on Base (chain 8453)
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

const REGISTRY_ADDRESS  = (process.env.REGISTRY_ADDRESS || "").trim();
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
const APP_DOMAIN        = (process.env.APP_DOMAIN || "").toLowerCase().replace(/^\.+|\.+$/g, "");

if (!REGISTRY_ADDRESS && !STATIC_ENCLAVES.length) {
  console.error("fatal: set REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}

// --- registry read (mirrors scripts/nan-discover.mjs) ------------------------
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
async function readRegistry() {
  if (STATIC_ENCLAVES.length)
    return STATIC_ENCLAVES.map((endpoint) => ({ endpoint, repo: null, lastSeen: null }));
  const c = await chain();
  const total = Number(await c.readContract({ address: REGISTRY_ADDRESS, abi: ABI, functionName: "count" }));
  const out = [];
  for (let start = 0; start < total; start += 50)
    out.push(...await c.readContract({ address: REGISTRY_ADDRESS, abi: ABI,
      functionName: "getPage", args: [BigInt(start), 50n] }));
  const now = Math.floor(Date.now() / 1000);
  return out
    .filter((e) => e.active && now - Number(e.lastSeen) <= STALE_AFTER_SEC)
    .map((e) => ({ endpoint: e.endpoint.replace(/\/+$/, ""), repo: e.repo, lastSeen: Number(e.lastSeen) }));
}

// --- availability polling -----------------------------------------------------
async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

let registry = [];                 // [{endpoint, repo, lastSeen}]
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

// Share-based routing — same rule as nan-discover.mjs. Deployments buy two
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
// CORS: the browser page (https://nan.host) talks only to this relay, so WE must
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
// Reverse-proxy `req` to `enclaveOrigin + path`. `setCors`: on the api.nan.host
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
    source: "api-relay", updatedAt,
  };
}

const DEP_PATH_RE = /^\/v1\/deployments\/([A-Za-z0-9_-]+)(?:\/|$)/;
const X_PATH_RE   = /^\/x\/([A-Za-z0-9_-]+)(?:\/|$)/;

async function gateway(u, req, res) {
  if (!live.length) return json(res, 503, { error: "no_capacity", message: "No live enclaves.", updatedAt }, req);
  const p = u.pathname;
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
    // the NanDeployments contract referees any race (the loser's claim tx
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

  if (p === "/v1/deployments" && req.method === "GET") {     // one wallet, one list: merge the fleet
    const rs = await Promise.all(live.map((e) =>
      forward(e.endpoint, req, null).then((r) => ({ e, r })).catch(() => null)));
    const oks = rs.filter((x) => x && x.r.status === 200);
    if (!oks.length) {
      const first = rs.find(Boolean);
      return first ? sendForwarded(res, first.r, req)
                   : json(res, 502, { error: "upstream_error", message: "No enclave answered.", updatedAt }, req);
    }
    const data = [];
    for (const { e, r } of oks) {
      try { for (const it of JSON.parse(r.text).data || []) { data.push(it); ownerLearn(it.id, e.endpoint); } } catch {}
    }
    return json(res, 200, { data, cursor: null }, req);
  }

  const c = sticky();                                        // auth, pricing, version, attestation, ...
  return proxyTo(c.endpoint, req, res);
}

// <label>.<APP_DOMAIN> -> canonical dep_<label>, or null if not an app subdomain.
// The subdomain drops the "dep_" (redundant in this namespace): "abc123" ->
// "dep_abc123". A legacy "dep-abc123" is still accepted.
function depFromHost(host) {
  if (!APP_DOMAIN) return null;
  host = (host || "").toLowerCase().split(":")[0];
  if (!host.endsWith("." + APP_DOMAIN)) return null;
  const label = host.slice(0, -(APP_DOMAIN.length + 1)).replace(/^dep[-_]/, "");   // strip a legacy prefix if present
  // On-chain (NanDeployments) ids are bytes32; a full 64-hex id exceeds DNS's
  // 63-char label limit, so their subdomain is a hex PREFIX of the id (16+
  // chars). Enclaves resolve the prefix to the unique matching deployment.
  // Legacy HTTP ids (dep_ + 9 base36 chars) never reach 16 hex chars, so the
  // two namespaces cannot collide.
  const hex = label.startsWith("0x") ? label.slice(2) : label;
  if (/^[0-9a-f]{16,64}$/.test(hex)) return "0x" + hex;
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
await pollAvailability();
setInterval(pollRegistry, REGISTRY_POLL_SEC * 1000);
setInterval(pollAvailability, AVAIL_POLL_SEC * 1000);

server.listen(PORT, process.env.API_RELAY_BIND || undefined, () => console.log(
  `[api-relay] :${PORT} · ${STATIC_ENCLAVES.length ? `static list (${STATIC_ENCLAVES.length})` : `NanRegistry ${REGISTRY_ADDRESS}`} · ${live.length}/${registry.length} live`));
