// NAN API relay — discovery + placement front door for the fleet. UNTRUSTED.
//
//   client ──GET /route──> api-relay ──> { endpoint, repo }   (JSON answer)
//   client ──POST /v1/*──> api-relay ──307──> https://<best-enclave>/v1/*
//
// It reads NanRegistry on Base for live enclaves (slow-moving truth: who
// exists), polls each one's public /availability (fast-moving truth: free
// capacity), and steers new work to the most available enclave that fits.
//
// It stays OUTSIDE the trust boundary the same way the TCP relay does: it
// never terminates a session and never sees a credential. Routing is by JSON
// answer or 307 redirect, so the client always lands on the enclave's own
// attested origin and verifies attestation there (Tinfoil SecureClient with
// the registry's `repo`). A malicious api-relay can pick you a suboptimal
// enclave; it cannot impersonate one — same posture as scripts/nan-discover.mjs
// (whose registry/pick semantics this daemon mirrors), just hosted, so thin
// clients don't need an RPC connection or viem.
//
// Placement only steers NEW deployments. A deployment lives on one enclave:
// after a 307 lands you on enclave N, keep talking to enclave N for that
// deployment (the Location header tells you which). NOTE: fetch()/undici strip
// Authorization on cross-origin redirects — authed callers should GET /route
// and hit the enclave directly; the 307 path suits curl and browsers.
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

// Exact-resource routing — same rule as nan-discover.mjs. Callers name EXACT
// resources on four axes (vramGb + gpuTflops of a card, memMb + cpuTflops of
// the node); each enclave's fit is checked against ITS OWN specs from
// /availability, so heterogeneous hardware routes correctly. GPU work needs a
// GPU enclave whose free card slice covers BOTH GPU axes and whose cpu pool
// covers both CPU axes. CPU-only work prefers CPU-only enclaves; GPU enclaves
// are the FALLBACK, serving it out of leftover cpu pool (a tenant taking a
// whole card + 10% of the RAM leaves 90% of the node rentable). Availability
// fields: gpuShareFree / cpuShareFree (+ cardVramGb / cardTflops / nodeRamGb /
// nodeTflops; maxShare kept as a deprecated fallback for old enclaves).
const gpuFreeOf = (a) => a.gpuShareFree ?? (a.gpu ? a.maxShare ?? 0 : 0);
const cpuFreeOf = (a) => a.cpuShareFree ?? (a.gpu ? 0 : a.maxShare ?? 0);
const vramFreeGbOf    = (a) => gpuFreeOf(a) * (a.cardVramGb || 141);
const gpuTflopsFreeOf = (a) => gpuFreeOf(a) * (a.cardTflops || 989);
const ramFreeMbOf     = (a) => cpuFreeOf(a) * (a.nodeRamGb || 64) * 1024;
const cpuTflopsFreeOf = (a) => cpuFreeOf(a) * (a.nodeTflops || 1);
function pick(want = {}) {
  const { vramGb = 0, gpuTflops = 0, memMb = 0, cpuTflops = 0 } = want;
  const cpuFits = (a) => ramFreeMbOf(a) >= memMb && cpuTflopsFreeOf(a) >= cpuTflops;
  if (vramGb > 0 || gpuTflops > 0) {
    return live
      .filter((e) => e.availability.gpu && vramFreeGbOf(e.availability) >= vramGb
                     && gpuTflopsFreeOf(e.availability) >= gpuTflops && cpuFits(e.availability))
      .sort((a, b) => gpuFreeOf(b.availability) - gpuFreeOf(a.availability))[0] || null;
  }
  const fits = live.filter((e) => cpuFits(e.availability));
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
function proxyTo(origin, req, res, { path = req.url, setCors = true } = {}) {
  const target = new URL(origin.replace(/\/+$/, "") + path);
  const headers = { ...req.headers, host: target.host };
  delete headers["accept-encoding"];                          // let the enclave send identity; simpler passthrough
  const lib = target.protocol === "https:" ? https : http;
  const up = lib.request(
    { hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search, method: req.method, headers, timeout: 30000 },
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

// <label>.<APP_DOMAIN> -> canonical dep_<label>, or null if not an app subdomain.
// The subdomain drops the "dep_" (redundant in this namespace): "abc123" ->
// "dep_abc123". A legacy "dep-abc123" is still accepted.
function depFromHost(host) {
  if (!APP_DOMAIN) return null;
  host = (host || "").toLowerCase().split(":")[0];
  if (!host.endsWith("." + APP_DOMAIN)) return null;
  const label = host.slice(0, -(APP_DOMAIN.length + 1)).replace(/^dep[-_]/, "");   // strip a legacy prefix if present
  const id = "dep_" + label;
  return /^dep_[a-z0-9]+$/.test(id) ? id : null;
}

// Does a deployment exist on the fleet? (unauth probe of /x/<id>: 404 = no,
// anything else = yes/private.) Cached briefly — gates on-demand TLS issuance
// so nobody can burn the CA rate limit with random <junk>.<APP_DOMAIN> names.
const _existCache = new Map();                                // id -> { ok, at(ms) }
async function deploymentExists(id) {
  const hit = _existCache.get(id);
  if (hit && (Date.now() - hit.at) < 60_000) return hit.ok;
  const c = pick(); if (!c) return false;
  let ok = false;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${c.endpoint}/x/${encodeURIComponent(id)}`, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(t); ok = r.status !== 404;
  } catch { ok = false; }
  _existCache.set(id, { ok, at: Date.now() });
  return ok;
}

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
  // to the enclave's /x/<id> data path, passing the app's own headers through
  // (it's a distinct origin, so the gateway doesn't impose CORS).
  const depHost = depFromHost(req.headers["x-forwarded-host"] || req.headers.host);
  if (depHost) {
    const c = pick();
    if (!c) return json(res, 503, { error: "no_capacity", message: "No live enclaves.", updatedAt });
    const rest = req.url === "/" ? "/" : req.url;             // preserve path+query under /x/<id>
    return proxyTo(c.endpoint, req, res, { path: "/x/" + depHost + rest, setCors: false });
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
    // ?vramGb=&gpuTflops=&memMb=&cpuTflops= — the EXACT resources the
    // deployment wants on four axes (shares are calculated per enclave). Both
    // GPU axes 0 = CPU-only (CPU enclaves preferred, GPU leftovers as
    // fallback). Legacy ?gpuShare=/?share= is read as a fraction of a 141 GB
    // card, ?cpuShare= as a fraction of a 64 GB node.
    const want = {
      vramGb: parseFloat(u.searchParams.get("vramGb")
        ?? String((parseFloat(u.searchParams.get("gpuShare") ?? u.searchParams.get("share") ?? "0") || 0) * 141)) || 0,
      gpuTflops: parseFloat(u.searchParams.get("gpuTflops") || "0") || 0,
      memMb: parseFloat(u.searchParams.get("memMb")
        ?? String((parseFloat(u.searchParams.get("cpuShare") || "0") || 0) * 64 * 1024)) || 0,
      cpuTflops: parseFloat(u.searchParams.get("cpuTflops") || "0") || 0,
    };
    const c = pick(want);
    if (!c) return json(res, 503, { error: "no_capacity",
      message: `No live enclave has ${want.vramGb} GB VRAM / ${want.gpuTflops} GPU TFLOPS and ${Math.round(want.memMb)} MB RAM / ${want.cpuTflops} CPU TFLOPS free.`, updatedAt }, req);
    return json(res, 200, { endpoint: c.endpoint, repo: c.repo, availability: c.availability, updatedAt,
                            note: "Verify attestation at the endpoint (Tinfoil SecureClient + repo) before sending anything." }, req);
  }

  // API gateway: proxy control-plane + data-path calls to the live enclave.
  // Single-enclave today: targets the one live enclave. NOTE: control-plane ops
  // on a deployment must hit the enclave that OWNS it — with several enclaves,
  // this needs per-deployment routing (a SIWE token is enclave-specific anyway),
  // so revisit before adding a second enclave.
  if (proxied(u.pathname)) {
    const c = pick();
    if (!c) return json(res, 503, { error: "no_capacity", message: "No live enclaves.", updatedAt }, req);
    return proxyTo(c.endpoint, req, res);
  }

  json(res, 404, { error: "not_found", routes: ["/health", "/enclaves", "/route?vramGb=8&gpuTflops=50&memMb=2048&cpuTflops=0.1", "/v1/* /x/* /availability (proxied to the enclave)"] }, req);
});

await pollRegistry();
await pollAvailability();
setInterval(pollRegistry, REGISTRY_POLL_SEC * 1000);
setInterval(pollAvailability, AVAIL_POLL_SEC * 1000);

server.listen(PORT, process.env.API_RELAY_BIND || undefined, () => console.log(
  `[api-relay] :${PORT} · ${STATIC_ENCLAVES.length ? `static list (${STATIC_ENCLAVES.length})` : `NanRegistry ${REGISTRY_ADDRESS}`} · ${live.length}/${registry.length} live`));
