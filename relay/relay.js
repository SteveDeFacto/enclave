// NAN public TCP relay — the UNTRUSTED half of the platform's direct-TCP path.
//
//   client ──TLS──> relay (this, any box) ──wss──> enclave shim ──> supervisor ──> app
//            └────────── the TLS key lives only in the enclave ──────────┘
//
// The enclave's sole ingress is the Tinfoil shim (HTTPS/443), so someone has to
// own the raw public port. This daemon does — and nothing else. It peeks the
// SNI hostname from the TLS ClientHello WITHOUT terminating TLS, maps
// <deploymentId>.<RELAY_DOMAIN>:<port> to the enclave's WebSocket bridge at
// /x/<deploymentId>/tls/<logical port>, and splices bytes. The client's TLS
// session terminates INSIDE the attested enclave (the supervisor holds the
// platform cert as an enclave secret), so this box only ever sees ciphertext
// and connection metadata. It is stateless and holds no secrets: run it on a
// $3 VPS, run several behind round-robin DNS, or let strangers run their own.
//
// Config (env):
//   RELAY_DOMAIN            required  SNI suffix, e.g. "tcp.nan.host"
//                                     (point *.tcp.nan.host at this box)
//   ENCLAVE_URL             required  enclave origin, e.g.
//                                     https://enclave1.nan.containers.tinfoil.dev
//   RELAY_PORTS             required  comma list of "public[:logical]" TCP ports,
//                                     e.g. "6667,5432" or "6697:6667" (public 6697
//                                     bridges to the app's declared tcp:6667)
//   RELAY_MAX_CONNS         optional  concurrent client connection cap (1024)
//   RELAY_HELLO_TIMEOUT_MS  optional  ms to wait for a full ClientHello (10000)

import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";

const need = (k) => {
  const v = (process.env[k] || "").trim();
  if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); }
  return v;
};

const DOMAIN    = need("RELAY_DOMAIN").toLowerCase().replace(/^\.+|\.+$/g, "");
const ENCLAVE   = need("ENCLAVE_URL").replace(/\/+$/, "").replace(/^http/, "ws"); // http(s):// -> ws(s)://
const MAX_CONNS = parseInt(process.env.RELAY_MAX_CONNS || "1024", 10);
const HELLO_MS  = parseInt(process.env.RELAY_HELLO_TIMEOUT_MS || "10000", 10);
const PORTS = need("RELAY_PORTS").split(",").map((s) => {
  const m = /^\s*(\d{1,5})(?::(\d{1,5}))?\s*$/.exec(s);
  if (!m) { console.error(`fatal: RELAY_PORTS: bad entry "${s}" (use public[:logical])`); process.exit(1); }
  return { public: +m[1], logical: +(m[2] || m[1]) };
});

// Extract the SNI server_name from a TLS ClientHello.
//   string -> hostname (lowercased)   null -> need more bytes   false -> reject
function sniFromClientHello(buf) {
  if (buf.length < 5) return null;
  if (buf[0] !== 0x16) return false;                   // not a TLS handshake record
  const recLen = buf.readUInt16BE(3);
  if (recLen > 18432) return false;                    // no sane ClientHello is this big
  if (buf.length < 5 + recLen) return null;            // wait for the full record
  const d = buf.subarray(5, 5 + recLen);
  let o = 0;
  const u8  = () => d[o++];
  const u16 = () => { const v = d.readUInt16BE(o); o += 2; return v; };
  try {
    if (u8() !== 0x01) return false;                   // handshake type ClientHello
    o += 3 + 2 + 32;                                   // length, legacy_version, random
    // NB: not `o += u8()` — compound assignment reads the OLD o before the
    // helper advances it, silently losing the length-byte skip.
    const sid = u8(); o += sid;                        // session id
    const cs = u16(); o += cs;                         // cipher suites
    const cm = u8(); o += cm;                          // compression methods
    if (o >= d.length) return false;                   // no extensions -> no SNI
    const extEnd = o + 2 + d.readUInt16BE(o); o += 2;
    while (o + 4 <= extEnd && o + 4 <= d.length) {
      const type = u16(), len = u16();
      if (type === 0x0000) {                           // server_name
        let p = o + 2;                                 // skip server_name_list length
        if (d[p] !== 0x00) return false;               // name_type 0 = host_name
        const nameLen = d.readUInt16BE(p + 1);
        return d.subarray(p + 3, p + 3 + nameLen).toString("ascii").toLowerCase();
      }
      o += len;
    }
    return false;
  } catch { return false; }                            // truncated/garbled -> reject
}

let conns = 0;

function handle(client, logicalPort) {
  if (conns >= MAX_CONNS) { client.destroy(); return; }
  conns++;
  client.once("close", () => conns--);
  client.on("error", () => client.destroy());

  // buffer until the ClientHello is complete, route on its SNI, then splice
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), HELLO_MS);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const sni = sniFromClientHello(buf);
    if (sni === null) { if (buf.length > 20000) { clearTimeout(timer); client.destroy(); } return; }
    client.off("data", onData); clearTimeout(timer);
    if (sni === false || !sni.endsWith("." + DOMAIN)) return client.destroy();
    // Deployment ids are "dep_<base36>", but "_" is not a valid hostname label
    // char - OpenSSL refuses to wildcard-match it, so strict clients (psql,
    // python) would reject the cert. The advertised hostname therefore spells
    // it "dep-<base36>"; map that back to the canonical id here.
    const dep = sni.slice(0, -(DOMAIN.length + 1)).replace(/^dep-/, "dep_");
    if (!/^[a-z0-9_-]{1,64}$/.test(dep)) return client.destroy();
    client.pause();
    splice(client, dep, logicalPort, buf);
  };
  client.on("data", onData);
}

function splice(client, dep, port, hello) {
  const ws = new WebSocket(`${ENCLAVE}/x/${encodeURIComponent(dep)}/tls/${port}`,
                           { perMessageDeflate: false });
  const wsStream = createWebSocketStream(ws);
  const close = () => { client.destroy(); try { ws.terminate(); } catch {} };
  ws.on("unexpected-response", (_req, res) => {
    console.log(`[relay] ${dep} tcp:${port} refused by enclave (HTTP ${res.statusCode})`);
    close();
  });
  client.on("error", close); client.on("close", close);
  wsStream.on("error", close); wsStream.on("close", close);
  ws.on("open", () => {
    wsStream.write(hello);                       // the buffered ClientHello goes first
    client.pipe(wsStream); wsStream.pipe(client);
  });
}

for (const p of PORTS) {
  const srv = net.createServer((c) => handle(c, p.logical));
  srv.on("error", (e) => { console.error(`fatal: listen :${p.public}: ${e.message}`); process.exit(1); });
  srv.listen(p.public, () =>
    console.log(`[relay] :${p.public} -> ${ENCLAVE}/x/<sni>.${DOMAIN}/tls/${p.logical}`));
}
