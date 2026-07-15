// Enclave dedicated-IP TCP relay — serves each deployment's declared tcp:N ports on
// its OWN IPv6, at the real (logical) port. UNTRUSTED, like the other relays.
//
//   client ──TCP──> [<per-deployment IPv6>]:N ──WSS──> enclave
//                                                 /x/<id>/tcp/N ──TCP──> app
//
// Unlike the SNI relay (relay.js), which multiplexes every deployment onto
// shared public ports and demuxes by the TLS ClientHello's SNI, this relay
// routes purely by DESTINATION ADDRESS: every deployment gets its own IPv6 out
// of the box's routed /64 (the supervisor derives it from the id; see
// /v1/net-map), so the client needs no SNI and no TLS at all - ANY tcp protocol
// works (databases, game servers, plaintext, or the app's own TLS), at the port
// the app declared. Bytes are spliced raw to the enclave's /tcp/ bridge (the
// app owns its port end to end); the relay holds no keys and no state beyond
// live connections.
//
// FLEET-AWARE: serves every enclave the fleet source lists (see fleet.mjs) —
// each poll merges every live enclave's /v1/net-map, and each listener
// remembers which enclave owns its deployment. Enclaves come and go without
// touching this daemon's config. Deployment ids are unique fleet-wide (on-chain
// bytes32), so derived addresses never collide across enclaves.
//
// PREREQUISITE (the box, once): AnyIP so the whole /64 is bind-able without
// configuring 2^64 addresses —
//     ip -6 route add local <prefix>/64 dev lo
// The systemd unit does this in ExecStartPre. CAP_NET_BIND_SERVICE lets it
// serve privileged logical ports (tcp:443, tcp:80) on the dedicated address.
// Every enclave with dedicated addressing on must set DEP_ADDR_PREFIX to THIS
// box's /64 (their derived addresses are all bound here).
//
// TRUST: the relay sees ciphertext only if the app speaks TLS; a plaintext app
// is visible to the relay (it can drop, not usefully forge - no keys, no state).
// Apps needing confidentiality terminate their own TLS. Documented in README.md.
//
// Config (env):
//   REGISTRY_ADDRESS   required*   EnclaveRegistry on Base: on-chain fleet discovery
//   ENCLAVES           required*   *instead: static comma list of enclave origins
//   ENCLAVE_URL        (legacy)    single-enclave pin, folded into ENCLAVES
//   BASE_RPC / REGISTRY_POLL_SEC / STALE_AFTER_SEC   registry mode knobs (fleet.mjs)
//   NET_POLL_SEC       optional   /v1/net-map poll cadence (default 5)
//   TCP6_MAX_CONNS     optional   concurrent client-connection cap (default 4096)
//   TCP6_HANDSHAKE_MS  optional   ms to establish the enclave WS before giving up (10000)

import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";
import { createFleet, fleetConfig, fetchJson, installProcessGuards } from "./fleet.mjs";
installProcessGuards("tcp6-relay");

const CFG = fleetConfig();
if (!CFG.registryAddress && !CFG.staticList.length) {
  console.error("fatal: set REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}
const fleet     = createFleet(CFG, (m) => console.log("[tcp6-relay]", m));
const POLL_MS   = parseInt(process.env.NET_POLL_SEC || "5", 10) * 1000;
const MAX_CONNS = parseInt(process.env.TCP6_MAX_CONNS || "4096", 10);
const HS_MS     = parseInt(process.env.TCP6_HANDSHAKE_MS || "10000", 10);

const wsOrigin = (origin) => origin.replace(/^http/, "ws");

// one listener per (deployment, address, logical port); each accepts many client
// connections, each getting its own WS to the owning enclave so streams stay
// separate. `origin` is refreshed each poll (a deployment stays keyed the same
// even if it reappears on another enclave).
const listeners = new Map();   // `${id}|${address}|${port}` -> { srv, origin, id, address, port }
let connCount = 0;

function openListener(origin, id, address, port) {
  const key = `${id}|${address}|${port}`;
  const have = listeners.get(key);
  if (have) { have.origin = origin; return; }
  const srv = net.createServer((client) => splice(client, L));
  const L = { srv, origin, id, address, port };
  listeners.set(key, L);
  srv.on("error", (e) => {
    if (e.code === "EADDRNOTAVAIL")
      console.error(`[tcp6-relay] cannot bind [${address}]:${port} — is AnyIP set? (ip -6 route add local <prefix>/64 dev lo)`);
    else if (e.code === "EACCES")
      console.error(`[tcp6-relay] cannot bind [${address}]:${port} — privileged port needs CAP_NET_BIND_SERVICE`);
    else if (e.code !== "EADDRINUSE")
      console.error(`[tcp6-relay] [${address}]:${port}: ${e.message}`);
    try { srv.close(); } catch {} listeners.delete(key);
  });
  srv.listen(port, address, () => console.log(`[tcp6-relay] [${address}]:${port} -> ${L.origin}/x/${id}/tcp/${port}`));
}

function splice(client, L) {
  if (connCount >= MAX_CONNS) { client.destroy(); return; }
  connCount++;
  client.once("close", () => connCount--);
  client.on("error", () => client.destroy());
  client.pause();

  const ws = new WebSocket(`${wsOrigin(L.origin)}/x/${encodeURIComponent(L.id)}/tcp/${L.port}`, { perMessageDeflate: false });
  const wsStream = createWebSocketStream(ws);
  const hsTimer = setTimeout(() => { try { ws.terminate(); } catch {} client.destroy(); }, HS_MS);
  const close = () => { clearTimeout(hsTimer); client.destroy(); try { ws.terminate(); } catch {} };
  ws.on("unexpected-response", (_req, res) => {
    console.log(`[tcp6-relay] ${L.id} tcp:${L.port} refused by enclave (HTTP ${res.statusCode})`);
    close();
  });
  client.on("close", close);
  wsStream.on("error", close); wsStream.on("close", close);
  ws.on("error", close);
  ws.on("open", () => {
    clearTimeout(hsTimer);
    client.pipe(wsStream); wsStream.pipe(client);
    client.resume();
  });
}

function closeListener(key) {
  const L = listeners.get(key); if (!L) return;
  try { L.srv.close(); } catch {} listeners.delete(key);   // in-flight connections keep their own sockets/WS
}

async function poll() {
  const origins = fleet.origins();
  const results = await Promise.all(origins.map(async (origin) =>
    ({ origin, map: await fetchJson(origin + "/v1/net-map") })));

  const desired = new Map();       // key -> owning origin
  const failed  = new Set();       // unreachable this round — keep their bindings
  for (const { origin, map } of results) {
    if (!map) { failed.add(origin); console.error(`[tcp6-relay] net-map poll failed: ${origin}`); continue; }
    if (!map.enabled) continue;    // dedicated addressing off there — nothing to bind
    for (const d of map.deployments || []) {
      if (!d.address) continue;
      for (const port of d.tcp || []) {
        const key = `${d.id}|${d.address}|${port}`;
        if (!desired.has(key)) desired.set(key, origin);
      }
    }
  }

  for (const [key, origin] of desired) {
    const [id, address, port] = key.split("|");
    openListener(origin, id, address, parseInt(port, 10));
  }
  // deployment gone (or its enclave left the fleet / disabled addressing) →
  // stop binding; an enclave that merely failed this poll keeps its listeners.
  for (const [key, L] of [...listeners])
    if (!desired.has(key) && !failed.has(L.origin)) closeListener(key);
}

await fleet.start();
await poll();
setInterval(poll, POLL_MS);
console.log(`[tcp6-relay] polling /v1/net-map across the fleet every ${POLL_MS / 1000}s`);
