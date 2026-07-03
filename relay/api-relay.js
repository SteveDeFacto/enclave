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

const REGISTRY_ADDRESS  = (process.env.REGISTRY_ADDRESS || "").trim();
const BASE_RPC          = process.env.BASE_RPC || "https://mainnet.base.org";
const STATIC_ENCLAVES   = (process.env.ENCLAVES || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const PORT              = parseInt(process.env.API_RELAY_PORT || "8100", 10);
const AVAIL_POLL_SEC    = parseInt(process.env.AVAIL_POLL_SEC || "10", 10);
const REGISTRY_POLL_SEC = parseInt(process.env.REGISTRY_POLL_SEC || "300", 10);
const STALE_AFTER_SEC   = parseInt(process.env.STALE_AFTER_SEC || "3600", 10);

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

// most free share that still fits the request — same rule as nan-discover.mjs
function pick(wantShare = 0) {
  return live
    .filter((e) => (e.availability.maxShare ?? 0) >= wantShare)
    .sort((a, b) => (b.availability.maxShare ?? 0) - (a.availability.maxShare ?? 0))[0] || null;
}

// --- http ----------------------------------------------------------------------
const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",          // public, read-only data
                        "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");

  if (u.pathname === "/health")
    return json(res, 200, { ok: true, enclaves: live.length, of: registry.length, updatedAt });

  if (u.pathname === "/enclaves") {
    const agg = {
      enclaves: live.length,
      totalFreeShare: Math.round(live.reduce((s, e) => s + (e.availability.maxShare || 0), 0) * 1000) / 1000,
      totalVramFreeGb: Math.round(live.reduce((s, e) => s + (e.availability.vramFreeGb || 0), 0) * 10) / 10,
    };
    return json(res, 200, { updatedAt, aggregate: agg, enclaves: live });
  }

  if (u.pathname === "/route") {
    const want = parseFloat(u.searchParams.get("share") || "0") || 0;
    const c = pick(want);
    if (!c) return json(res, 503, { error: "no_capacity", message: `No live enclave has >= ${want} free share.`, updatedAt });
    return json(res, 200, { endpoint: c.endpoint, repo: c.repo, availability: c.availability, updatedAt,
                            note: "Verify attestation at the endpoint (Tinfoil SecureClient + repo) before sending anything." });
  }

  // convenience: bounce API calls to the current best enclave. 307 keeps the
  // method and body; the client lands on the enclave's own attested origin.
  // Deliberately NOT /x/* — a deployment lives on ONE enclave, and "best
  // available" is the wrong router for it; use the enclave you deployed to.
  if (u.pathname.startsWith("/v1/") || u.pathname === "/availability") {
    const c = pick(0);
    if (!c) return json(res, 503, { error: "no_capacity", message: "No live enclaves.", updatedAt });
    res.writeHead(307, { Location: c.endpoint + req.url, "Access-Control-Allow-Origin": "*",
                         "Cache-Control": "no-store" });
    return res.end();
  }

  json(res, 404, { error: "not_found", routes: ["/health", "/enclaves", "/route?share=0.05", "/v1/* (307 to best enclave)"] });
});

await pollRegistry();
await pollAvailability();
setInterval(pollRegistry, REGISTRY_POLL_SEC * 1000);
setInterval(pollAvailability, AVAIL_POLL_SEC * 1000);

server.listen(PORT, process.env.API_RELAY_BIND || undefined, () => console.log(
  `[api-relay] :${PORT} · ${STATIC_ENCLAVES.length ? `static list (${STATIC_ENCLAVES.length})` : `NanRegistry ${REGISTRY_ADDRESS}`} · ${live.length}/${registry.length} live`));
