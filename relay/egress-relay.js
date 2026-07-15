// Enclave dedicated-IP EGRESS relay — the outbound half of the per-deployment
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
// egress as its own address.
//
// FLEET-AWARE: one relay-initiated control WS PER LIVE ENCLAVE (see fleet.mjs —
// the shim stays each enclave's only ingress); each OPEN gets its own dial +
// data WS back to the enclave that asked, exactly like an inbound connection in
// reverse. Enclaves come and go without touching this daemon's config; set the
// SAME EGRESS_RELAY_TOKEN on every enclave (like the shared SECRET).
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
//   REGISTRY_ADDRESS    required*  EnclaveRegistry on Base: on-chain fleet discovery
//   ENCLAVES            required*  *instead: static comma list of enclave origins
//   ENCLAVE_URL         (legacy)   single-enclave pin, folded into ENCLAVES
//   BASE_RPC / REGISTRY_POLL_SEC / STALE_AFTER_SEC   registry mode knobs (fleet.mjs)
//   EGRESS_RELAY_TOKEN  required   shared secret; must match EVERY enclave's
//   EGRESS_PREFIX       optional   the box's routed /64. Used for the systemd
//                                  AnyIP step AND (when set) to CONSTRAIN the
//                                  source: any OPEN whose `source` falls outside
//                                  this prefix is refused before we dial (fix 9).
//                                  Unset = source unconstrained (today's behavior)
//                                  + a one-time warning.
//   EGRESS_ALLOW_V4     optional   "1" to also proxy to v4 destinations from the
//                                  box's shared v4 (NO dedicated source there);
//                                  default off — dedicated egress is v6-only.
//   EGRESS_MAX_CONNS    optional   concurrent egress connection cap (default 4096)
//   EGRESS_DIAL_MS      optional   ms to establish a destination dial (default 10000)

import net from "node:net";
import dns from "node:dns/promises";
import WebSocket, { createWebSocketStream } from "ws";
import { isBlockedHost, parseIp } from "./net-guard.mjs";
import { createFleet, fleetConfig, installProcessGuards } from "./fleet.mjs";
installProcessGuards("egress-relay");

const need = (k) => { const v = (process.env[k] || "").trim(); if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); } return v; };
const CFG = fleetConfig();
if (!CFG.registryAddress && !CFG.staticList.length) {
  console.error("fatal: set REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}
const fleet     = createFleet(CFG, (m) => console.log("[egress-relay]", m));
const TOKEN     = need("EGRESS_RELAY_TOKEN");
const ALLOW_V4  = /^(1|true|on)$/i.test(process.env.EGRESS_ALLOW_V4 || "");

// SECURITY (fix 9): the control channel supplies the outbound SOURCE address.
// The enclave derives it from the authenticated deployment id, but the relay
// must not blindly source-bind whatever it's told — constrain it to THIS box's
// routed /64 so a compromised/rogue control peer can't source-spoof off-prefix.
const EGRESS_PREFIX = (process.env.EGRESS_PREFIX || "").trim();
let PREFIX_NET = null, PREFIX_MASK = null;
if (EGRESS_PREFIX) {
  const [addr, lenStr] = EGRESS_PREFIX.split("/");
  const len = parseInt(lenStr || "64", 10);
  const p = parseIp((addr || "").trim());
  if (p && p.family === 6 && len >= 0 && len <= 128) {
    PREFIX_MASK = len === 0 ? 0n : (((1n << 128n) - 1n) << BigInt(128 - len)) & ((1n << 128n) - 1n);
    PREFIX_NET = p.value & PREFIX_MASK;
  } else { console.error(`fatal: EGRESS_PREFIX is not a valid IPv6 CIDR: ${EGRESS_PREFIX}`); process.exit(1); }
} else {
  console.error("[egress-relay] EGRESS_PREFIX unset — outbound SOURCE addresses are NOT constrained to this box's /64 (set EGRESS_PREFIX to reject off-prefix sources; see README).");
}
function sourceInPrefix(source) {
  if (PREFIX_NET === null) return true;                 // unconstrained (opt-in), warned at boot
  const s = parseIp(source);
  return !!s && s.family === 6 && (s.value & PREFIX_MASK) === PREFIX_NET;
}
const MAX_CONNS = parseInt(process.env.EGRESS_MAX_CONNS || "4096", 10);
const DIAL_MS   = parseInt(process.env.EGRESS_DIAL_MS || "10000", 10);
const AUTH      = { Authorization: `Bearer ${TOKEN}` };
const RECONCILE_MS = 5000;

const wsOrigin = (origin) => origin.replace(/^http/, "ws");

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

function handleOpen(control, origin, { cid, host, port, source }) {
  if (!cid || !host || !port || !source) return;
  // reject a source outside this box's routed /64 before we ever dial (fix 9)
  if (!sourceInPrefix(source)) { try { control.send(JSON.stringify({ type: "close", cid, reason: "denied" })); } catch {} return; }
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
      const ws = new WebSocket(`${wsOrigin(origin)}/x/egress/${cid}`, { headers: AUTH, perMessageDeflate: false });
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

// One control channel per enclave, relay-initiated (the shim stays each
// enclave's only ingress). Reconnects with backoff while the enclave is in the
// fleet; torn down (and its retry stopped) when the enclave leaves it.
const controls = new Map();   // origin -> { ws, timer, stopped }

function ensureControl(origin) {
  if (controls.has(origin)) return;
  const slot = { ws: null, timer: null, stopped: false };
  controls.set(origin, slot);
  const connect = () => {
    if (slot.stopped) return;
    const ws = new WebSocket(`${wsOrigin(origin)}/v1/egress-control`, { headers: AUTH, perMessageDeflate: false });
    slot.ws = ws;
    ws.on("open", () => console.log(`[egress-relay] control channel up -> ${origin}`));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && m.type === "open") handleOpen(ws, origin, m);
    });
    ws.on("unexpected-response", (_q, res) => console.error(`[egress-relay] control refused by ${origin} (HTTP ${res.statusCode}); check EGRESS_RELAY_TOKEN`));
    ws.on("close", () => {
      if (slot.stopped) return;
      console.error(`[egress-relay] control channel down (${origin}); reconnecting in 2s`);
      slot.timer = setTimeout(connect, 2000);
    });
    ws.on("error", (e) => console.error(`[egress-relay] ${origin}:`, e.message));
  };
  connect();
}

function dropControl(origin) {
  const slot = controls.get(origin); if (!slot) return;
  slot.stopped = true;
  clearTimeout(slot.timer);
  try { slot.ws && slot.ws.close(); } catch {}
  controls.delete(origin);
  console.log(`[egress-relay] enclave left the fleet: ${origin}`);
}

function reconcile() {
  const want = new Set(fleet.origins());
  for (const origin of want) ensureControl(origin);
  for (const origin of [...controls.keys()]) if (!want.has(origin)) dropControl(origin);
}

console.log(`[egress-relay] dedicated-IP egress relay (v4 ${ALLOW_V4 ? "allowed (shared source)" : "off"})`);
await fleet.start();
reconcile();
setInterval(reconcile, RECONCILE_MS);
