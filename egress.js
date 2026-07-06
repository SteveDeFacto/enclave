// NAN dedicated-IP EGRESS — the outbound half of the "give me an IP and a port"
// model. Inbound (tcp6-relay/udp-relay) already serves each deployment's
// declared ports on its OWN IPv6; this makes the app's OUTBOUND connections
// LEAVE from that same address, so a deployment has one stable identity in both
// directions (what a VM with a public IP gives you).
//
// Why a proxy and not a route: the deployment's IPv6 lives on the (untrusted)
// relay box's routed /64 — the enclave never holds it, and the CVM runs with
// zero privileges (no netns, no nftables, no source-routing available in here).
// So egress round-trips through the relay, which source-binds the deployment's
// address before dialling out. This module is the enclave-side front door; the
// relay box runs relay/egress-relay.js.
//
//   guest ──SOCKS5──> [supervisor:this] ──OPEN(cid)──> relay (control WS)
//                                        <──data WS /x/egress/<cid>── relay
//   relay ──connect(localAddress = depAddr)──> destination
//
// TWO WAYS IN, ONE FRONT: a guest can opt in explicitly by honouring NAN_EGRESS
// (a SOCKS5h URL with per-deployment credentials), OR — with the phase-2
// wasmtime shim (`-S egress`, wasm/wasmtime-egress.patch) — the platform routes
// the guest's raw wasi:sockets / wasi:http outbound through this SAME front
// automatically, delivering the credential host-side (NAN_EGRESS_CRED,
// guest-invisible) and dropping the guest's ambient `-Sinherit-network` so there
// is no raw path left to bypass it. Either way the source IP is derived
// server-side from the AUTHENTICATED credential, never chosen by the guest or
// the relay: no deployment can egress AS ANOTHER's address.
//
// THREE GUARDRAILS (see the conversation that specced this):
//  1. Tenant isolation on the endpoint — all guests share loopback, so the
//     SOCKS front demands per-deployment credentials (RFC 1929 user/pass; the
//     password is an HMAC of the id under the enclave SECRET). You can only
//     egress as yourself; sourceAddrFor(id) is applied from the AUTHENTICATED
//     id, never from anything the caller supplies.
//  2. SSRF denial — a literal-IP destination in a private/loopback/link-local/
//     ULA/multicast range is refused here (protects the enclave's own control
//     ports); the relay repeats the check AFTER DNS resolution (protects the
//     relay box's localhost + private services). Both ends, because each guards
//     a different network.
//  3. Per-connection scoping — every CONNECT gets an unguessable single-use
//     `cid`; the relay services exactly that cid via its own data WS, and the
//     cid is consumed on first use. A misbehaving relay can't cross-wire one
//     tenant's stream into another's.

import net from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, createWebSocketStream } from "ws";
import { isBlockedHost, parseIp } from "./net-guard.mjs";

const OPEN_TIMEOUT_MS = 15000;   // relay must open the data WS within this
const enc = (s) => Buffer.from(String(s), "utf8");

// Per-deployment SOCKS password: HMAC(SECRET, "nan-egress:"+id). Deterministic
// (no state to store), unforgeable without the enclave SECRET, and scoped to
// exactly one deployment. The supervisor mints this into the guest's NAN_EGRESS
// env; possessing it == being that guest.
export function egressToken(secret, id) {
  return createHmac("sha256", secret).update("nan-egress:" + id).digest("base64url");
}

// SOCKS reply codes (RFC 1928 §6)
const REP = { OK: 0x00, GENERAL: 0x01, DENIED: 0x02, NET_UNREACH: 0x03,
              HOST_UNREACH: 0x04, REFUSED: 0x05 };

// Build a SOCKS5 CONNECT reply. BND.ADDR carries the egress source address (the
// deployment's IPv6) on success, so an app can observe the IP it goes out as.
function socksReply(rep, bndAddr) {
  const ip = bndAddr && parseIp(bndAddr);
  if (rep === REP.OK && ip && ip.family === 6) {
    const b = Buffer.alloc(4 + 16 + 2);
    b[0] = 0x05; b[1] = REP.OK; b[2] = 0x00; b[3] = 0x04;  // ATYP v6
    for (let i = 0; i < 16; i++) b[4 + i] = Number((ip.value >> BigInt((15 - i) * 8)) & 0xffn);
    return b;                                              // BND.PORT 0
  }
  // failures (and the v4/unknown-source success case) use a zero v4 BND.ADDR
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

// createEgress wires the SOCKS front + the relay control/data channels.
//   secret         Uint8Array/Buffer — the enclave signing SECRET
//   socksPort      loopback port the guests' SOCKS clients dial
//   relayToken     shared secret the relay presents on its control/data WS
//   sourceAddrFor  (id) => the deployment's dedicated IPv6 (depAddrFor)
//   isKnown        optional (id) => bool — extra check the id is a live deployment
//   log            (msg) => void
export function createEgress({ secret, socksPort, relayToken, sourceAddrFor, isKnown, log = () => {} }) {
  const relayTokenBuf = enc(relayToken);
  const pending = new Map();          // cid -> { sock, source, host, port, timer }
  const conns = new Set();            // live SOCKS client sockets (for clean shutdown)
  const wss = new WebSocketServer({ noServer: true });
  let controlWs = null;               // the single live relay control socket

  const tokenOk = (id, tok) => {
    const want = enc(egressToken(secret, id)), got = enc(tok || "");
    return want.length === got.length && timingSafeEqual(want, got);
  };
  const relayOk = (tok) => {
    const got = enc(tok || "");
    return relayTokenBuf.length === got.length && timingSafeEqual(relayTokenBuf, got);
  };

  function failPending(cid, rep) {
    const p = pending.get(cid);
    if (!p) return;
    pending.delete(cid);
    clearTimeout(p.timer);
    try { p.sock.write(socksReply(rep)); } catch {}
    try { p.sock.destroy(); } catch {}
  }

  // ---- SOCKS5 (RFC 1928) with user/pass auth (RFC 1929), CONNECT only -------
  const socks = net.createServer((sock) => {
    conns.add(sock); sock.on("close", () => conns.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    let phase = "greet";                 // greet -> auth -> request -> done
    let authedId = null;

    const need = (n) => buf.length >= n;
    const step = () => {
      for (;;) {
        if (phase === "greet") {
          if (!need(2)) return;
          if (buf[0] !== 0x05) return sock.destroy();
          const nm = buf[1];
          if (!need(2 + nm)) return;
          const methods = buf.subarray(2, 2 + nm);
          buf = buf.subarray(2 + nm);
          if (!methods.includes(0x02)) {          // 0x02 = user/pass required
            sock.end(Buffer.from([0x05, 0xff])); return;
          }
          sock.write(Buffer.from([0x05, 0x02]));
          phase = "auth";
        } else if (phase === "auth") {
          if (!need(2)) return;
          if (buf[0] !== 0x01) return sock.destroy();   // auth version
          const ulen = buf[1];
          if (!need(2 + ulen + 1)) return;
          const plen = buf[2 + ulen];
          if (!need(2 + ulen + 1 + plen)) return;
          const uname = buf.subarray(2, 2 + ulen).toString("utf8");
          const passwd = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
          buf = buf.subarray(3 + ulen + plen);
          // GUARDRAIL 1: the id is the SOCKS username, authenticated by the
          // per-deployment token. Everything downstream uses THIS id.
          if (!uname || !tokenOk(uname, passwd) || (isKnown && !isKnown(uname))) {
            sock.end(Buffer.from([0x01, 0x01])); return;   // auth failure
          }
          authedId = uname;
          sock.write(Buffer.from([0x01, 0x00]));           // auth success
          phase = "request";
        } else if (phase === "request") {
          if (!need(4)) return;
          if (buf[0] !== 0x05) return sock.destroy();
          const cmd = buf[1], atyp = buf[3];
          let host, hlen, off;
          if (atyp === 0x01) { hlen = 4;  off = 4; if (!need(off + 4 + 2)) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; off = 8; }
          else if (atyp === 0x04) { if (!need(4 + 16 + 2)) return;
            host = ipv6FromBytes(buf.subarray(4, 20)); off = 20; }
          else if (atyp === 0x03) { hlen = buf[4]; off = 5; if (!need(off + hlen + 2)) return;
            host = buf.subarray(5, 5 + hlen).toString("utf8"); off = 5 + hlen; }
          else return sock.destroy();
          const port = buf.readUInt16BE(off);
          buf = buf.subarray(off + 2);
          phase = "done";
          if (cmd !== 0x01) { sock.end(socksReply(REP.GENERAL)); return; }  // CONNECT only
          beginConnect(sock, authedId, host, port);
          return;
        } else return;
      }
    };
    sock.on("data", (d) => {
      if (phase === "done") return;                 // post-handshake bytes belong to the tunnel
      buf = Buffer.concat([buf, d]);
      if (buf.length > 4096) return sock.destroy();  // handshake is tiny; cap it
      try { step(); } catch { sock.destroy(); }
    });
  });
  socks.on("error", (e) => log(`[egress] socks server: ${e.message}`));

  function beginConnect(sock, id, host, port) {
    // GUARDRAIL 2 (near end): refuse literal-IP destinations in internal ranges
    // before they ever leave the enclave. Hostname targets are re-checked at the
    // relay after DNS. "localhost" is blocked here too.
    if (isBlockedHost(host)) { sock.end(socksReply(REP.DENIED)); return; }
    if (!controlWs) { sock.end(socksReply(REP.NET_UNREACH)); return; }  // no relay attached
    const source = sourceAddrFor(id);
    if (!source) { sock.end(socksReply(REP.NET_UNREACH)); return; }     // dedicated addressing off
    // GUARDRAIL 3: unguessable, single-use connection id.
    const cid = randomBytes(16).toString("hex");
    const timer = setTimeout(() => { log(`[egress] ${id} ${host}:${port} timed out waiting for relay`);
                                     failPending(cid, REP.HOST_UNREACH); }, OPEN_TIMEOUT_MS);
    pending.set(cid, { sock, source, host, port, timer });
    sock.on("close", () => { if (pending.has(cid)) failPending(cid, REP.GENERAL); });
    try {
      controlWs.send(JSON.stringify({ type: "open", cid, host, port, source }));
    } catch (e) { log(`[egress] control send failed: ${e.message}`); failPending(cid, REP.NET_UNREACH); }
  }

  // ---- upgrade dispatch: relay control + per-connection data WS -------------
  // Returns true if it owned the path (so the supervisor's handler can return).
  function handleUpgrade(req, socket, head) {
    const url = req.url || "";
    const auth = (req.headers["authorization"] || "").match(/^Bearer\s+(\S+)$/);
    const qtok = (url.split("?")[1] || "").split("&").map((kv) => kv.split("="))
                    .find(([k]) => k === "t");
    const tok = (auth && auth[1]) || (qtok && decodeURIComponent(qtok[1] || "")) || "";

    if (url.startsWith("/v1/egress-control")) {
      if (!relayOk(tok)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return true; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (controlWs) { try { controlWs.close(); } catch {} }   // one relay at a time; newest wins
        controlWs = ws;
        log("[egress] relay control channel attached");
        ws.on("message", (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m && m.type === "close" && m.cid)                  // relay couldn't dial
            failPending(m.cid, m.reason === "denied" ? REP.DENIED : REP.HOST_UNREACH);
        });
        const drop = () => { if (controlWs === ws) { controlWs = null; log("[egress] relay control channel dropped"); } };
        ws.on("close", drop); ws.on("error", drop);
      });
      return true;
    }

    const dm = url.match(/^\/x\/egress\/([0-9a-f]{32})(?:\?|$)/);
    if (dm) {
      const cid = dm[1];
      if (!relayOk(tok)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return true; }
      const p = pending.get(cid);
      if (!p) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return true; }
      pending.delete(cid);            // GUARDRAIL 3: consume — cid is single-use
      clearTimeout(p.timer);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const wsStream = createWebSocketStream(ws);
        const close = () => { try { ws.close(); } catch {} try { p.sock.destroy(); } catch {} try { wsStream.destroy(); } catch {} };
        p.sock.on("error", close); p.sock.on("close", close);
        wsStream.on("error", close); wsStream.on("close", close);
        // hand the app its CONNECT success, then splice raw bytes end to end
        p.sock.write(socksReply(REP.OK, p.source));
        p.sock.pipe(wsStream); wsStream.pipe(p.sock);
      });
      return true;
    }
    return false;
  }

  return {
    // resolves once the SOCKS front is listening (port 0 -> OS-assigned)
    start() { return new Promise((res) => socks.listen(socksPort, "127.0.0.1", () => {
      log(`[egress] SOCKS5 on 127.0.0.1:${socks.address().port}`); res(); })); },
    stop() { try { socks.close(); } catch {} if (controlWs) { try { controlWs.close(); } catch {} }
      for (const c of wss.clients) { try { c.terminate(); } catch {} }
      for (const s of conns) { try { s.destroy(); } catch {} }
      for (const cid of [...pending.keys()]) failPending(cid, REP.GENERAL); },
    handleUpgrade,
    // the actual listening port (config `socksPort` may be 0)
    socksPort: () => socks.address()?.port ?? socksPort,
    // the NAN_EGRESS value handed to a guest: SOCKS5h so DNS resolves at the
    // relay (remote-side), giving the app the deployment's egress identity.
    envFor(id) { return `socks5h://${id}:${egressToken(secret, id)}@127.0.0.1:${socks.address()?.port ?? socksPort}`; },
    connected: () => !!controlWs,
    _pending: pending,   // test hook
  };
}

function ipv6FromBytes(b) {
  const g = [];
  for (let i = 0; i < 8; i++) g.push(((b[i * 2] << 8) | b[i * 2 + 1]).toString(16));
  return g.join(":");
}
