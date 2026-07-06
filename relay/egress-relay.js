// NAN dedicated-IP EGRESS relay — the outbound half of the per-deployment
// address. Mirror of the inbound tcp6-relay: UNTRUSTED, holds no keys, sees
// only whatever the app sends (ciphertext if the app speaks TLS).
//
//   enclave (control WS) ──OPEN{cid,host,port,source}──> here
//   here ──connect(localAddress = source)──> destination
//   here ──data WS /x/egress/<cid>──> enclave ──> guest's SOCKS tunnel
//
// The enclave front (egress.js) authenticates the guest and derives `source`
// (the deployment's own IPv6) from the AUTHENTICATED id — this daemon never
// picks the source, it just binds what it's told. So a deployment can only ever
// egress as its own address. We hold ONE control WS to the enclave (relay-
// initiated, so the shim stays the only ingress); each OPEN gets its own dial +
// data WS, exactly like an inbound connection in reverse.
//
// PREREQUISITE (the box, once): the same AnyIP /64 the tcp6/udp relays use, so
// `localAddress = <a /64 address>` binds. The systemd unit sets it (shared).
//
// GUARDRAIL 2 (SSRF): every address a hostname resolves to is re-checked here
// (net-guard.mjs) before we dial — the enclave only sees literal IPs; DNS
// happens here, so this is the only place a name→private-IP rebind can be
// caught. Refused dials tell the enclave `denied` so the guest gets a clean
// SOCKS failure. This protects the relay box's OWN localhost + private services.
//
// Config (env):
//   ENCLAVE_URL         required   enclave origin (https:// -> wss://)
//   EGRESS_RELAY_TOKEN  required   shared secret; must match the enclave's
//   EGRESS_PREFIX       optional   the routed /64 (systemd AnyIP only; unused here)
//   EGRESS_ALLOW_V4     optional   "1" to also proxy to v4 destinations from the
//                                  box's shared v4 (NO dedicated source there);
//                                  default off — dedicated egress is v6-only.
//   EGRESS_MAX_CONNS    optional   concurrent egress connection cap (default 4096)
//   EGRESS_DIAL_MS      optional   ms to establish a destination dial (default 10000)

import net from "node:net";
import dns from "node:dns/promises";
import WebSocket, { createWebSocketStream } from "ws";
import { isBlockedHost, parseIp } from "./net-guard.mjs";

const need = (k) => { const v = (process.env[k] || "").trim(); if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); } return v; };
const ORIGIN    = need("ENCLAVE_URL").replace(/\/+$/, "");
const ENCLAVE   = ORIGIN.replace(/^http/, "ws");
const TOKEN     = need("EGRESS_RELAY_TOKEN");
const ALLOW_V4  = /^(1|true|on)$/i.test(process.env.EGRESS_ALLOW_V4 || "");
const MAX_CONNS = parseInt(process.env.EGRESS_MAX_CONNS || "4096", 10);
const DIAL_MS   = parseInt(process.env.EGRESS_DIAL_MS || "10000", 10);
const AUTH      = { Authorization: `Bearer ${TOKEN}` };

let connCount = 0;

// Resolve `host` to an address we're ALLOWED to dial, preferring IPv6 (only a
// v6 destination can carry the deployment's dedicated v6 source). Returns
// { addr, family } or throws "denied" (nothing resolved that passes SSRF).
async function pickTarget(host) {
  const lit = parseIp(host);
  let cands;
  if (lit) cands = [{ address: host, family: lit.family }];
  else {
    try { cands = await dns.lookup(host, { all: true }); }
    catch { throw new Error("denied"); }             // unresolvable -> treat as denied (no oracle)
  }
  const ok = cands.filter((c) => !isBlockedHost(c.address));   // GUARDRAIL 2: post-resolution
  const v6 = ok.find((c) => c.family === 6);
  if (v6) return { addr: v6.address, family: 6 };
  const v4 = ok.find((c) => c.family === 4);
  if (v4 && ALLOW_V4) return { addr: v4.address, family: 4 };
  throw new Error("denied");
}

function handleOpen(control, { cid, host, port, source }) {
  if (!cid || !host || !port || !source) return;
  if (connCount >= MAX_CONNS) { control.send(JSON.stringify({ type: "close", cid, reason: "error" })); return; }

  const fail = (reason) => { try { control.send(JSON.stringify({ type: "close", cid, reason })); } catch {} };

  pickTarget(host).then(({ addr, family }) => {
    // v6 destination -> bind the deployment's dedicated source; v4 (opt-in) ->
    // box default source (no per-deployment identity, documented).
    const opts = { host: addr, port, family };
    if (family === 6) opts.localAddress = source;
    const dst = net.connect(opts);
    connCount++;
    let settled = false;
    const dialTimer = setTimeout(() => { if (!settled) { settled = true; try { dst.destroy(); } catch {} connCount--; fail("error"); } }, DIAL_MS);

    dst.once("error", (e) => {
      if (settled) return; settled = true; clearTimeout(dialTimer); connCount--;
      if (e.code === "EADDRNOTAVAIL")
        console.error(`[egress-relay] cannot source-bind [${source}] — is AnyIP set on the /64?`);
      fail("error");
    });

    dst.once("connect", () => {
      if (settled) return; settled = true; clearTimeout(dialTimer);
      dst.pause();                                    // hold banner bytes until the tunnel is spliced
      const ws = new WebSocket(`${ENCLAVE}/x/egress/${cid}`, { headers: AUTH, perMessageDeflate: false });
      const wsStream = createWebSocketStream(ws);
      const hs = setTimeout(() => { try { ws.terminate(); } catch {} }, DIAL_MS);
      const close = () => { clearTimeout(hs); try { dst.destroy(); } catch {} try { ws.terminate(); } catch {} };
      dst.once("close", () => { connCount--; close(); });
      dst.on("error", close);
      wsStream.on("error", close); wsStream.on("close", close);
      ws.on("error", close);
      ws.on("unexpected-response", (_q, res) => { console.error(`[egress-relay] data WS ${cid} refused (HTTP ${res.statusCode})`); close(); });
      ws.on("open", () => { clearTimeout(hs); dst.pipe(wsStream); wsStream.pipe(dst); dst.resume(); });
    });
  }).catch(() => fail("denied"));
}

// The single control channel to the enclave. Relay-initiated (shim stays the
// only ingress); on any drop we back off and reconnect.
function connectControl() {
  const ws = new WebSocket(`${ENCLAVE}/v1/egress-control`, { headers: AUTH, perMessageDeflate: false });
  ws.on("open", () => console.log(`[egress-relay] control channel up -> ${ENCLAVE}`));
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && m.type === "open") handleOpen(ws, m);
  });
  ws.on("unexpected-response", (_q, res) => console.error(`[egress-relay] control refused (HTTP ${res.statusCode}); check EGRESS_RELAY_TOKEN`));
  const retry = () => { console.error("[egress-relay] control channel down; reconnecting in 2s"); setTimeout(connectControl, 2000); };
  ws.on("close", retry); ws.on("error", (e) => console.error("[egress-relay]", e.message));
}

console.log(`[egress-relay] dedicated-IP egress relay -> ${ENCLAVE} (v4 ${ALLOW_V4 ? "allowed (shared source)" : "off"})`);
connectControl();
