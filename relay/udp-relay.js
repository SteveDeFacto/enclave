// NAN public UDP relay — gives service apps' declared udp:N ports a reachable
// public endpoint. UNTRUSTED, like the other relays.
//
//   client ──UDP──> [<per-deployment IPv6>]:N ──WS(1 msg=1 datagram)──> enclave
//                                                    /x/<id>/udp/N ──UDP──> app
//
// UDP carries no SNI, so a shared port can't tell tenants apart. Instead every
// deployment gets its OWN IPv6 out of the box's routed /64 (the supervisor
// derives it from the deployment id; see /v1/udp-map), and this relay routes by
// destination ADDRESS. It binds each live deployment's address:port, and tunnels
// datagrams to the enclave over the same WSS bridge the TCP relay uses.
//
// PREREQUISITE (the box, once): AnyIP so the whole /64 is bind-able without
// configuring 2^64 addresses —
//     ip -6 route add local <prefix>/64 dev lo
// The systemd unit does this in ExecStartPre.
//
// TRUST: unlike the TCP path, a stock UDP client sends cleartext, so this relay
// sees plaintext (it can drop, not usefully forge — it holds no keys, no state
// beyond live flows). Apps needing confidentiality must speak their own
// encryption (e.g. DTLS). Documented in relay/README.md.
//
// Config (env):
//   ENCLAVE_URL        required   enclave origin (https:// -> wss://)
//   UDP_POLL_SEC       optional   /v1/udp-map poll cadence (default 5)
//   UDP_IDLE_MS        optional   idle flow teardown (default 120000)
//   UDP_MAX_FLOWS      optional   concurrent client-flow cap (default 4096)

import dgram from "node:dgram";
import WebSocket from "ws";

const need = (k) => { const v = (process.env[k] || "").trim(); if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); } return v; };
const ENCLAVE   = need("ENCLAVE_URL").replace(/\/+$/, "").replace(/^http/, "ws");
const MAP_URL   = need("ENCLAVE_URL").replace(/\/+$/, "") + "/v1/udp-map";
const POLL_MS   = parseInt(process.env.UDP_POLL_SEC || "5", 10) * 1000;
const IDLE_MS   = parseInt(process.env.UDP_IDLE_MS || "120000", 10);
const MAX_FLOWS = parseInt(process.env.UDP_MAX_FLOWS || "4096", 10);

// one bound listener per (deployment, address, logical port); it fans many
// client flows, each with its own WS to the enclave so replies route back.
const listeners = new Map();   // `${id}|${address}|${port}` -> { sock, id, address, port, flows: Map }
let flowCount = 0;

function flowKey(caddr, cport) { return caddr + "|" + cport; }

function openListener(id, address, port) {
  const key = `${id}|${address}|${port}`;
  if (listeners.has(key)) return;
  const sock = dgram.createSocket({ type: "udp6", reuseAddr: true });
  const L = { sock, id, address, port, flows: new Map() };
  listeners.set(key, L);

  sock.on("error", (e) => {
    if (e.code === "EADDRNOTAVAIL")
      console.error(`[udp-relay] cannot bind [${address}]:${port} — is AnyIP set? (ip -6 route add local <prefix>/64 dev lo)`);
    else console.error(`[udp-relay] [${address}]:${port}: ${e.message}`);
    try { sock.close(); } catch {} listeners.delete(key);
  });

  sock.on("message", (data, rinfo) => {
    const fk = flowKey(rinfo.address, rinfo.port);
    let f = L.flows.get(fk);
    if (!f) {
      if (flowCount >= MAX_FLOWS) return;                 // shed load rather than sprawl
      f = { ws: null, buf: [], caddr: rinfo.address, cport: rinfo.port, timer: null };
      L.flows.set(fk, f); flowCount++;
      const ws = new WebSocket(`${ENCLAVE}/x/${encodeURIComponent(id)}/udp/${port}`, { perMessageDeflate: false });
      f.ws = ws;
      ws.on("open", () => { for (const d of f.buf) ws.send(d); f.buf = []; });
      ws.on("message", (d, isBinary) => { if (isBinary || d.length) { try { sock.send(d, f.cport, f.caddr); } catch {} bump(L, fk, f); } });
      ws.on("close", () => dropFlow(L, fk));
      ws.on("error", () => dropFlow(L, fk));
    }
    if (f.ws.readyState === WebSocket.OPEN) f.ws.send(data); else f.buf.push(data);
    bump(L, fk, f);
  });

  sock.bind(port, address, () => console.log(`[udp-relay] [${address}]:${port} -> ${ENCLAVE}/x/${id}/udp/${port}`));
}

function bump(L, fk, f) { clearTimeout(f.timer); f.timer = setTimeout(() => dropFlow(L, fk), IDLE_MS); }
function dropFlow(L, fk) {
  const f = L.flows.get(fk); if (!f) return;
  clearTimeout(f.timer); try { f.ws && f.ws.terminate(); } catch {}
  L.flows.delete(fk); flowCount--;
}
function closeListener(key) {
  const L = listeners.get(key); if (!L) return;
  for (const fk of [...L.flows.keys()]) dropFlow(L, fk);
  try { L.sock.close(); } catch {} listeners.delete(key);
}

async function poll() {
  let map;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(MAP_URL, { signal: ctrl.signal }); clearTimeout(t);
    if (!r.ok) throw new Error("HTTP " + r.status);
    map = await r.json();
  } catch (e) { console.error("[udp-relay] udp-map poll failed:", e.message); return; }
  if (!map.enabled) { if (listeners.size) console.log("[udp-relay] udp addressing disabled at enclave; unbinding"); for (const k of [...listeners.keys()]) closeListener(k); return; }

  const want = new Set();
  for (const d of map.deployments || [])
    for (const port of d.ports || []) { if (!d.address) continue; want.add(`${d.id}|${d.address}|${port}`); openListener(d.id, d.address, port); }
  for (const k of [...listeners.keys()]) if (!want.has(k)) closeListener(k);   // deployment gone → stop binding
}

await poll();
setInterval(poll, POLL_MS);
console.log(`[udp-relay] polling ${MAP_URL} every ${POLL_MS / 1000}s`);
