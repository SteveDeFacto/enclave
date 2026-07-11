// Enclave public TCP relay — the UNTRUSTED half of the platform's direct-TCP path.
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
//   RELAY_DOMAIN            required  SNI suffix, e.g. "tcp.enclave.host"
//                                     (point *.tcp.enclave.host at this box)
//   APP_DOMAIN              optional  app-subdomain SNI suffix(es), e.g.
//                                     "app.enclave.host". Port 443 connections
//                                     whose SNI ends here route to the owner
//                                     enclave's /x/<label>/https - the
//                                     IN-ENCLAVE browser-TLS path (ACME cert
//                                     minted in the CVM), so this box never
//                                     holds app-site keys either. Unset = off
//                                     (today's Caddy termination keeps serving
//                                     until the *.app DNS is repointed here).
//   REGISTRY_ADDRESS        required* EnclaveRegistry on Base: FLEET discovery — the
//                                     relay routes each SNI'd deployment to the
//                                     enclave that OWNS it (learned from every
//                                     enclave's /v1/net-map), so it follows an
//                                     arbitrary, changing set of enclaves.
//   ENCLAVES                required* *instead: static comma list of enclave
//                                     origins (ENCLAVE_URL = legacy one-entry alias)
//   BASE_RPC / REGISTRY_POLL_SEC / STALE_AFTER_SEC   registry-mode knobs (fleet.mjs)
//   NET_POLL_SEC            optional  /v1/net-map poll cadence (default 5)
//   RELAY_PORTS             required  comma list of "public[:logical]" ports and
//                                     "lo-hi" ranges (range = pass-through, public
//                                     == logical). "1-19999" serves every logical
//                                     port the platform allows — the box needs no
//                                     firewall, and a tenant's new tcp:N works with
//                                     no relay config change. e.g.:
//                                       RELAY_PORTS=1-19999            all apps
//                                       RELAY_PORTS=6667,6697:6667     just IRC
//   RELAY_EXCLUDE           optional  ports never bound (default "22"; sshd)
//   RELAY_BIND              optional  comma list of LOCAL addresses to listen on
//                                     (default: wildcard/dual-stack — all
//                                     interfaces). Set SPECIFIC addresses when
//                                     this box ALSO runs the dedicated-IP relay
//                                     (tcp6-relay), which binds
//                                     [<per-deployment IPv6>]:port out of a
//                                     routed /64: a wildcard listener here would
//                                     grab [::]:port across that whole /64 and
//                                     block those binds. `RELAY_BIND=0.0.0.0`
//                                     serves all IPv4 (this relay's v4-fallback
//                                     role) without touching the v6 /64; add the
//                                     box's own main v6 to also serve v6 SNI.
//   RELAY_MAX_CONNS         optional  concurrent client connection cap (1024)
//   RELAY_HELLO_TIMEOUT_MS  optional  ms to wait for a full ClientHello (10000)

import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";
import { createFleet, fleetConfig, fetchJson } from "./fleet.mjs";

const need = (k) => {
  const v = (process.env[k] || "").trim();
  if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); }
  return v;
};

// Comma-separated: during a domain cutover both the new and the old SNI suffix
// route (e.g. "tcp.enclave.host,tcp.nan.host"); the first entry is primary.
const DOMAINS   = need("RELAY_DOMAIN").toLowerCase().split(",")
  .map(s => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);
const DOMAIN    = DOMAINS[0];
// App-subdomain suffixes (in-enclave browser TLS). Optional; empty = feature off.
const APP_DOMAINS = (process.env.APP_DOMAIN || "").toLowerCase().split(",")
  .map(s => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);
// FLEET discovery (REGISTRY_ADDRESS / ENCLAVES / legacy ENCLAVE_URL): the relay
// learns which enclave owns each deployment from their /v1/net-map, so one box
// serves the whole fleet and follows enclaves as they come and go.
const CFG = fleetConfig();
if (!CFG.registryAddress && !CFG.staticList.length) {
  console.error("fatal: set REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}
const fleet    = createFleet(CFG, (m) => console.log("[relay]", m));
const POLL_MS  = parseInt(process.env.NET_POLL_SEC || "5", 10) * 1000;
const wsOrigin = (o) => o.replace(/^http/, "ws");
const MAX_CONNS = parseInt(process.env.RELAY_MAX_CONNS || "1024", 10);
const HELLO_MS  = parseInt(process.env.RELAY_HELLO_TIMEOUT_MS || "10000", 10);
const EXCLUDE = new Set((process.env.RELAY_EXCLUDE || "22").split(",").map((s) => +s.trim()).filter(Boolean));
// Local addresses to listen on. Empty (default) -> one wildcard/dual-stack
// listener per port (all interfaces). A list -> one listener per (address,
// port), so this relay can share a box with the dedicated-IP relay without its
// wildcard v6 bind swallowing the routed /64 (see RELAY_BIND above).
const BIND_ADDRS = (process.env.RELAY_BIND || "").split(",").map((s) => s.trim()).filter(Boolean);
const LISTEN_ON = BIND_ADDRS.length ? BIND_ADDRS : [null];   // null = wildcard
const PORTS = [];
for (const s of need("RELAY_PORTS").split(",")) {
  const range = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(s);
  const single = /^\s*(\d{1,5})(?::(\d{1,5}))?\s*$/.exec(s);
  if (range) {
    for (let p = +range[1]; p <= +range[2]; p++) if (!EXCLUDE.has(p)) PORTS.push({ public: p, logical: p, quiet: true });
  } else if (single) {
    PORTS.push({ public: +single[1], logical: +(single[2] || single[1]) });
  } else {
    console.error(`fatal: RELAY_PORTS: bad entry "${s}" (use public[:logical] or lo-hi)`); process.exit(1);
  }
}

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

// --- fleet index: which enclave OWNS each deployment --------------------------
// Poll every live enclave's /v1/net-map (the public tcp/udp deployments each
// serves) and remember origin -> {full ids}. A SNI label (which for on-chain
// ids is a hex PREFIX, or a legacy "dep_<base36>") resolves to the owning
// origin + the canonical full id. An enclave that fails a poll keeps its last
// set (a flaky RPC/enclave must not drop live routes); one that leaves the
// fleet is dropped.
const originDeps = new Map();          // origin -> Set<full deployment id>

async function poll() {
  const origins = fleet.origins();
  const live = new Set(origins);
  const results = await Promise.all(origins.map(async (o) =>
    ({ o, map: await fetchJson(o + "/v1/net-map") })));
  for (const { o, map } of results) {
    if (!map) continue;                                    // unreachable -> keep last-known
    if (!map.enabled) { originDeps.set(o, new Set()); continue; }
    originDeps.set(o, new Set((map.deployments || []).map((d) => d.id)));
  }
  for (const o of [...originDeps.keys()]) if (!live.has(o)) originDeps.delete(o);
}

// Resolve a SNI label to { origin, id }. Matches an exact id, or (for on-chain
// bytes32 ids) a unique hex prefix; ambiguous prefixes are refused.
function resolve(label) {
  const l = label.toLowerCase().replace(/^dep[_-]/, "").replace(/^0x/, "");
  let hit = null;
  for (const [origin, deps] of originDeps) {
    for (const id of deps) {
      const n = id.toLowerCase().replace(/^0x/, "");
      if (id.toLowerCase() === label.toLowerCase() || n === l || ("dep_" + l) === id.toLowerCase()
          || (l.length >= 6 && n.startsWith(l))) {
        if (hit && hit.id !== id) return null;             // ambiguous -> refuse
        hit = { origin, id };
      }
    }
  }
  return hit;
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
    // App-subdomain names ride the same passthrough but land on the enclave's
    // /x/<label>/https path (in-enclave ACME cert + the app's normal HTTP
    // serving) instead of a tenant TCP port. Browsers only: 443.
    const appDom = (sni !== false) && APP_DOMAINS.find(d => sni.endsWith("." + d));
    if (appDom) {
      if (logicalPort !== 443) return client.destroy();
      const label = sni.slice(0, -(appDom.length + 1));
      if (!/^[a-z0-9-]{1,64}$/.test(label)) return client.destroy();
      // the subdomain label spells hex ids WITHOUT the 0x (DNS-friendly), but
      // the supervisor resolves 0x-prefixed ids - restore it (depFromHost does
      // the same on the api-relay). Legacy dep- labels map back to dep_.
      const dep = /^[0-9a-f]{8,64}$/.test(label) ? "0x" + label : label.replace(/^dep-/, "dep_");
      client.pause();
      appOwnerOf(dep).then((origin) => {
        if (!origin || client.destroyed) return client.destroy();
        splice(client, origin, dep, `/x/${encodeURIComponent(dep)}/https`, buf);
      });
      return;
    }
    const dom = (sni !== false) && DOMAINS.find(d => sni.endsWith("." + d));
    if (!dom) return client.destroy();
    // Deployment ids are "dep_<base36>", but "_" is not a valid hostname label
    // char - OpenSSL refuses to wildcard-match it, so strict clients (psql,
    // python) would reject the cert. The advertised hostname therefore spells
    // it "dep-<base36>"; map that back to the canonical id here.
    const label = sni.slice(0, -(dom.length + 1)).replace(/^dep-/, "dep_");
    if (!/^[a-z0-9_-]{1,64}$/.test(label)) return client.destroy();
    // route to the enclave that owns this deployment (learned from net-map)
    const r = resolve(label);
    if (!r) return client.destroy();                       // unknown / not-public / ambiguous
    client.pause();
    splice(client, r.origin, r.id, `/x/${encodeURIComponent(r.id)}/tls/${logicalPort}`, buf);
  };
  client.on("data", onData);
}

// Which enclave owns an app-subdomain label. HTTP-mode apps never appear in
// /v1/net-map (they declare no tcp/udp ports), so the tcp-zone index above
// can't answer - probe /x/<label> on each origin instead (the supervisor's
// HTTP path resolves hex prefixes; any non-404 = "lives here") and cache.
const APP_OWNER = new Map();                               // label -> { origin, at }
const APP_OWNER_TTL_MS = 5 * 60_000;
async function appOwnerOf(label) {
  const hit = APP_OWNER.get(label);
  if (hit && Date.now() - hit.at < APP_OWNER_TTL_MS && fleet.origins().includes(hit.origin)) return hit.origin;
  const found = await Promise.all(fleet.origins().map(async (o) => {
    try {
      const r = await fetch(`${o}/x/${encodeURIComponent(label)}`,
                            { method: "HEAD", signal: AbortSignal.timeout(4000) });
      return r.status !== 404 ? o : null;
    } catch { return null; }
  }));
  const origin = found.find(Boolean) || null;
  if (origin) APP_OWNER.set(label, { origin, at: Date.now() });
  return origin;
}

function splice(client, origin, dep, path, hello) {
  const ws = new WebSocket(wsOrigin(origin) + path, { perMessageDeflate: false });
  const wsStream = createWebSocketStream(ws);
  const close = () => { client.destroy(); try { ws.terminate(); } catch {} };
  ws.on("unexpected-response", (_req, res) => {
    console.log(`[relay] ${dep} ${path} refused by enclave (HTTP ${res.statusCode})`);
    close();
  });
  client.on("error", close); client.on("close", close);
  wsStream.on("error", close); wsStream.on("close", close);
  ws.on("open", () => {
    wsStream.write(hello);                       // the buffered ClientHello goes first
    client.pipe(wsStream); wsStream.pipe(client);
  });
}

// Learn the fleet + the dep->enclave index BEFORE accepting, so the first
// connections can route; then keep both fresh.
await fleet.start();
await poll();
setInterval(poll, POLL_MS);

// Range entries skip ports that are busy or privileged-and-denied (a box that
// also runs sshd etc. keeps working); explicitly listed ports stay fatal so a
// typo'd config can't silently serve nothing.
let bound = 0, skipped = 0, pending = PORTS.length * LISTEN_ON.length;
const on = BIND_ADDRS.length ? ` on ${BIND_ADDRS.join(", ")}` : "";
const summary = () => console.log(
  `[relay] listening on ${bound} socket(s)${on} (${skipped} skipped); routing <sni>.${DOMAIN}/tls/<port> to the owning enclave (${originDeps.size} live)`);
for (const p of PORTS) {
  for (const addr of LISTEN_ON) {
    const at = addr ? `[${addr}]:${p.public}` : `:${p.public}`;
    const srv = net.createServer((c) => handle(c, p.logical));
    srv.on("error", (e) => {
      if (!p.quiet) { console.error(`fatal: listen ${at}: ${e.message}`); process.exit(1); }
      skipped++; if (--pending === 0) summary();
    });
    const cb = () => {
      if (!p.quiet) console.log(`[relay] ${at} -> <sni>.${DOMAIN}/tls/${p.logical}`);
      bound++; if (--pending === 0) summary();
    };
    if (addr) srv.listen(p.public, addr, cb); else srv.listen(p.public, cb);
  }
}
