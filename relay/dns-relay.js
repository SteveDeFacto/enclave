// Enclave authoritative DNS — serves the platform's two synthesized zones from
// live state. UNTRUSTED, like the other relays: no keys, no zone files, nothing
// to reload; every answer is computed from the fleet poll, env, or the
// challenge store.
//
//   <hex-prefix>.IP_ZONE                  AAAA  the deployment's dedicated IPv6
//   _minecraft._tcp.<hex-prefix>.IP_ZONE  SRV   first declared tcp port
//   <anything>.APP_ZONE                   A/AAAA  today's wildcard (from env)
//   _acme-challenge.<name>.APP_ZONE       TXT   pushed by enclaves (HTTP API)
//
// ZONE 1 (ip): per-deployment dedicated-IPv6 hostnames. Addresses come from the
// same fleet-wide /v1/net-map poll the tcp6/udp relays run (fleet.mjs), so a
// name resolves exactly when its listener exists — no registration step. A
// label is a unique hex prefix of the deployment id (8-64 chars; a leading
// "dep-"/"dep_" is tolerated); unknown or AMBIGUOUS prefixes are NXDOMAIN.
// v6-only by design: A queries on these names get an empty NOERROR.
//
// ZONE 2 (app): the current wildcard, replicated (A/AAAA straight from env) so
// the zone can be delegated here without behavior change — plus
// _acme-challenge TXT records the enclaves push over the authenticated HTTP
// API below, which is what makes DNS-01 issuance for app names possible.
// Entries expire on their own; the store is memory-only (a restart loses at
// most an in-flight order, which retries).
//
// The wire protocol is implemented by hand (UDP + TCP with the 2-byte length
// prefix, one question, the six record types we serve, minimal EDNS echo, TC
// on oversize, names written uncompressed — fine at our sizes). Anything
// outside the two zones is REFUSED: this is an authoritative server, not a
// resolver. Malformed packets are dropped silently.
//
// Config (env):
//   IP_ZONE           required   zone 1 apex, e.g. ip.enclave.host
//   APP_ZONE          required   zone 2 apex, e.g. app.enclave.host
//   NS_NAME           required   this server's own name (SOA mname + NS target)
//   APP_A / APP_AAAA  optional   wildcard answers for zone 2 (unset -> NODATA)
//   DNS_PORT          optional   DNS udp+tcp port (default 53)
//   DNS_API_PORT      optional   challenge-push HTTP API port (default 8153)
//   DNS_API_BIND      optional   API bind address (default all)
//   SECRET            optional   the fleet's shared secret; HMAC auth for the
//                                API (unset -> API answers 503)
//   TXT_TTL_SEC       optional   challenge lifetime cap, seconds (default 600)
//   REGISTRY_ADDRESS  required*  EnclaveRegistry on Base: on-chain fleet discovery
//   ENCLAVES          required*  *instead: static comma list of enclave origins
//   BASE_RPC / REGISTRY_POLL_SEC / STALE_AFTER_SEC   registry mode knobs (fleet.mjs)
//   NET_POLL_SEC      optional   /v1/net-map poll cadence (default 15)

import dgram from "node:dgram";
import net from "node:net";
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createFleet, fleetConfig, fetchJson } from "./fleet.mjs";

const need = (k) => { const v = (process.env[k] || "").trim(); if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); } return v; };
const fqdn = (s) => s.trim().toLowerCase().replace(/\.+$/, "");

const CFG = fleetConfig();
if (!CFG.registryAddress && !CFG.staticList.length) {
  console.error("fatal: set REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}
const fleet     = createFleet(CFG, (m) => console.log("[dns-relay]", m));
const IP_ZONE   = fqdn(need("IP_ZONE"));
const APP_ZONE  = fqdn(need("APP_ZONE"));
const NS_NAME   = fqdn(need("NS_NAME"));
// hostmaster at the NS name's parent (ns1.enclave.host -> hostmaster.enclave.host)
const RNAME     = "hostmaster." + (NS_NAME.includes(".") ? NS_NAME.slice(NS_NAME.indexOf(".") + 1) : NS_NAME);
const DNS_PORT  = parseInt(process.env.DNS_PORT || "53", 10);
const API_PORT  = parseInt(process.env.DNS_API_PORT || "8153", 10);
const API_BIND  = process.env.DNS_API_BIND || undefined;
const SECRET    = (process.env.SECRET || "").trim();
const TXT_TTL_S = parseInt(process.env.TXT_TTL_SEC || "600", 10);
const POLL_MS   = parseInt(process.env.NET_POLL_SEC || "15", 10) * 1000;
const SERIAL    = Math.floor(Date.now() / 1000);   // SOA serial: process start
const NEG_TTL   = 60;      // SOA MINIMUM = negative-cache TTL (RFC 2308)
const UDP_MAX   = 1232;    // the EDNS-era safe UDP payload; beyond it -> TC

// ---- address parsing (text -> RDATA bytes) ---------------------------------

function ipv4Bytes(s) {
  const p = s.split(".");
  if (p.length !== 4) return null;
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(p[i]) || +p[i] > 255) return null;
    b[i] = +p[i];
  }
  return b;
}

function ipv6Bytes(s) {
  s = s.split("%")[0];
  // embedded v4 tail (::ffff:1.2.3.4) -> two trailing hex groups
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const v4 = ipv4Bytes(m[2]);
    if (!v4) return null;
    s = m[1] + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    b.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return b;
}

const APP_A = process.env.APP_A ? ipv4Bytes(process.env.APP_A.trim()) : null;
if (process.env.APP_A && !APP_A) { console.error("fatal: APP_A is not a valid IPv4 address"); process.exit(1); }
const APP_AAAA = process.env.APP_AAAA ? ipv6Bytes(process.env.APP_AAAA.trim()) : null;
if (process.env.APP_AAAA && !APP_AAAA) { console.error("fatal: APP_AAAA is not a valid IPv6 address"); process.exit(1); }

// ---- fleet state (zone 1's data) -------------------------------------------

// per-origin rows from each enclave's last GOOD /v1/net-map read; a failed poll
// keeps the previous answer set (same rule as tcp6-relay: a flaky enclave must
// not blank its names), an origin that leaves the fleet drops its rows.
const perOrigin = new Map();   // origin -> [{ hex, address, tcp }]
let deployments = [];          // flattened fleet view the resolver reads

async function poll() {
  const origins = fleet.origins();
  const results = await Promise.all(origins.map(async (origin) =>
    ({ origin, map: await fetchJson(origin + "/v1/net-map") })));
  for (const { origin, map } of results) {
    if (!map) { console.error(`[dns-relay] net-map poll failed: ${origin}`); continue; }
    const rows = [];
    if (map.enabled) for (const d of map.deployments || []) {
      if (!d.address || !/^0x[0-9a-fA-F]{64}$/.test(d.id || "")) continue;
      rows.push({ hex: d.id.slice(2).toLowerCase(), address: d.address,
                  tcp: (d.tcp || []).map((p) => parseInt(p, 10)).filter((p) => p > 0 && p < 65536) });
    }
    perOrigin.set(origin, rows);
  }
  for (const origin of [...perOrigin.keys()]) if (!origins.includes(origin)) perOrigin.delete(origin);
  const byId = new Map();   // ids are unique fleet-wide (on-chain bytes32)
  for (const rows of perOrigin.values()) for (const r of rows) if (!byId.has(r.hex)) byId.set(r.hex, r);
  deployments = [...byId.values()];
}

// ---- challenge store (zone 2's TXT) ----------------------------------------

const txtStore = new Map();   // name -> Map(value -> expiresAtMs); several values = concurrent orders

function txtValues(name) {
  const vals = txtStore.get(name);
  if (!vals) return [];
  const now = Date.now();
  for (const [v, exp] of vals) if (exp <= now) vals.delete(v);
  if (!vals.size) { txtStore.delete(name); return []; }
  return [...vals.keys()];
}

setInterval(() => { for (const name of [...txtStore.keys()]) txtValues(name); }, 30_000);

// ---- DNS wire encoding ------------------------------------------------------

const T  = { A: 1, NS: 2, SOA: 6, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, ANY: 255 };
const RC = { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function encodeName(name) {
  const out = [];
  for (const label of name.split(".").filter(Boolean)) {
    const b = Buffer.from(label, "latin1");
    if (b.length > 63) throw new Error("label too long");
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

const rr = (name, type, ttl, rdata) =>
  Buffer.concat([encodeName(name), u16(type), u16(1 /* IN */), u32(ttl), u16(rdata.length), rdata]);

const soaRR = (zone) => rr(zone, T.SOA, NEG_TTL, Buffer.concat([
  encodeName(NS_NAME), encodeName(RNAME),
  u32(SERIAL), u32(3600), u32(600), u32(604800), u32(NEG_TTL)]));
const nsRR  = (zone) => rr(zone, T.NS, 300, encodeName(NS_NAME));
const srvRR = (name, port, target) =>
  rr(name, T.SRV, 60, Buffer.concat([u16(0), u16(0), u16(port), encodeName(target)]));

function txtRR(name, value) {
  const data = Buffer.from(value, "utf8");
  const parts = [];   // TXT rdata = character-strings, each <= 255 bytes
  for (let i = 0; i === 0 || i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  return rr(name, T.TXT, 30, Buffer.concat(parts));
}

// minimal EDNS echo: root name, type OPT, class = our max UDP payload
const OPT_RR = Buffer.concat([Buffer.from([0]), u16(T.OPT), u16(UDP_MAX), u32(0), u16(0)]);

// ---- resolution -------------------------------------------------------------

// answer shape: { rcode, aa, an, au, ad } — arrays of pre-encoded RRs. NODATA
// and NXDOMAIN carry the zone SOA in AUTHORITY so resolvers can cache negatives.
const HIT    = (an, ad = []) => ({ rcode: RC.NOERROR,  aa: true, an, au: [], ad });
const NODATA = (zone) => ({ rcode: RC.NOERROR,  aa: true, an: [], au: [soaRR(zone)], ad: [] });
const NXDOM  = (zone) => ({ rcode: RC.NXDOMAIN, aa: true, an: [], au: [soaRR(zone)], ad: [] });
const EMPTY  = (rcode) => ({ rcode, aa: false, an: [], au: [], ad: [] });

function apex(zone, qtype) {
  const an = [];
  if (qtype === T.SOA || qtype === T.ANY) an.push(soaRR(zone));
  if (qtype === T.NS  || qtype === T.ANY) an.push(nsRR(zone));
  return an.length ? HIT(an) : NODATA(zone);
}

function resolveIp(qname, qtype) {
  if (qname === IP_ZONE) return apex(IP_ZONE, qtype);
  const sub = qname.slice(0, -(IP_ZONE.length + 1));
  const m = /^(?:_minecraft\._tcp\.)?([^.]+)$/.exec(sub);
  if (!m) return NXDOM(IP_ZONE);
  const wantSrv = sub !== m[1];
  const hex = m[1].replace(/^dep[-_]/, "");
  if (!/^[0-9a-f]{8,64}$/.test(hex)) return NXDOM(IP_ZONE);
  const hits = deployments.filter((d) => d.hex.startsWith(hex));
  if (hits.length !== 1) return NXDOM(IP_ZONE);   // unknown or ambiguous prefix
  const d = hits[0];
  const v6 = ipv6Bytes(d.address);
  if (wantSrv) {
    if ((qtype !== T.SRV && qtype !== T.ANY) || !d.tcp.length) return NODATA(IP_ZONE);
    const target = m[1] + "." + IP_ZONE;
    return HIT([srvRR(qname, d.tcp[0], target)], v6 ? [rr(target, T.AAAA, 60, v6)] : []);
  }
  if (qtype === T.AAAA || qtype === T.ANY)
    return v6 ? HIT([rr(qname, T.AAAA, 60, v6)]) : NODATA(IP_ZONE);
  return NODATA(IP_ZONE);   // A and everything else: the name exists, but v6-only
}

function resolveApp(qname, qtype) {
  if (qname === APP_ZONE) return apex(APP_ZONE, qtype);
  const an = [];
  if ((qtype === T.A    || qtype === T.ANY) && APP_A)    an.push(rr(qname, T.A,    300, APP_A));
  if ((qtype === T.AAAA || qtype === T.ANY) && APP_AAAA) an.push(rr(qname, T.AAAA, 300, APP_AAAA));
  if ((qtype === T.TXT  || qtype === T.ANY) && qname.startsWith("_acme-challenge."))
    for (const value of txtValues(qname)) an.push(txtRR(qname, value));
  return an.length ? HIT(an) : NODATA(APP_ZONE);   // wildcard zone: every name exists
}

function answer(q) {
  if (q.opcode !== 0) return EMPTY(RC.NOTIMP);
  if (q.qclass !== 1 && q.qclass !== T.ANY) return EMPTY(RC.REFUSED);
  if (q.qname === IP_ZONE  || q.qname.endsWith("." + IP_ZONE))  return resolveIp(q.qname, q.qtype);
  if (q.qname === APP_ZONE || q.qname.endsWith("." + APP_ZONE)) return resolveApp(q.qname, q.qtype);
  return EMPTY(RC.REFUSED);   // not our zone — we're authoritative, not a resolver
}

// ---- DNS wire parsing / response assembly -----------------------------------

// -> { id, opcode, rd, qname, qtype, qclass, questionRaw, hadOpt } or null.
// questionRaw is the question section verbatim, echoed back so the client's
// case survives; qname is lowercased for matching.
function parseQuery(msg) {
  if (msg.length < 12) return null;
  const flags = msg.readUInt16BE(2);
  if (flags & 0x8000) return null;                   // a response, not a query
  if (msg.readUInt16BE(4) !== 1) return null;        // exactly one question
  const counts = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let off = 12;
  const labels = [];
  for (;;) {                                          // QNAME: plain labels only
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) { off++; break; }
    if (len & 0xc0) return null;                     // no compression in a question
    if (off + 1 + len > msg.length || labels.length > 63) return null;
    labels.push(msg.toString("latin1", off + 1, off + 1 + len));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  const qtype = msg.readUInt16BE(off);
  const qclass = msg.readUInt16BE(off + 2);
  off += 4;
  const questionRaw = msg.subarray(12, off);
  // walk the remaining records only to spot an EDNS OPT (its content is ignored)
  let hadOpt = false, p = off;
  for (let i = 0; i < counts && p < msg.length; i++) {
    for (;;) {                                        // skip the owner name
      if (p >= msg.length) break;
      const l = msg[p];
      if (l === 0) { p++; break; }
      if (l & 0xc0) { p += 2; break; }
      p += 1 + l;
    }
    if (p + 10 > msg.length) break;
    if (msg.readUInt16BE(p) === T.OPT) hadOpt = true;
    p += 10 + msg.readUInt16BE(p + 8);
  }
  return { id: msg.readUInt16BE(0), opcode: (flags >> 11) & 0xf, rd: !!(flags & 0x100),
           qname: labels.join(".").toLowerCase(), qtype, qclass, questionRaw, hadOpt };
}

function header(q, r, tc, an, au, ad) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(q.id, 0);
  b.writeUInt16BE(0x8000 | ((q.opcode & 0xf) << 11) | (r.aa ? 0x0400 : 0)
    | (tc ? 0x0200 : 0) | (q.rd ? 0x0100 : 0) | (r.rcode & 0xf), 2);
  b.writeUInt16BE(1, 4);                              // the echoed question
  b.writeUInt16BE(an, 6); b.writeUInt16BE(au, 8); b.writeUInt16BE(ad, 10);
  return b;
}

// build the response; `limit` (UDP only) trips TC: records are dropped, the
// client retries over TCP and gets the whole thing there.
function buildResponse(q, r, limit) {
  const ad = q.hadOpt ? [...r.ad, OPT_RR] : r.ad;
  const msg = Buffer.concat([header(q, r, false, r.an.length, r.au.length, ad.length),
                             q.questionRaw, ...r.an, ...r.au, ...ad]);
  if (!limit || msg.length <= limit) return msg;
  const keep = q.hadOpt ? [OPT_RR] : [];
  return Buffer.concat([header(q, r, true, 0, 0, keep.length), q.questionRaw, ...keep]);
}

// one query in, one response (or null to stay silent) — never throws.
function handle(msg, limit) {
  let q;
  try { q = parseQuery(msg); } catch { return null; }
  if (!q) return null;
  let r;
  try { r = answer(q); } catch { r = EMPTY(RC.SERVFAIL); }
  try { return buildResponse(q, r, limit); } catch { return null; }
}

// ---- transports: UDP + TCP on DNS_PORT ---------------------------------------

const udp = dgram.createSocket({ type: "udp6", ipv6Only: false });   // dual-stack
let udpUp = false;
udp.on("error", (e) => { console.error("[dns-relay] udp:", e.message); if (!udpUp) process.exit(1); });
udp.on("message", (msg, rinfo) => {
  const out = handle(msg, UDP_MAX);
  if (out) udp.send(out, rinfo.port, rinfo.address, () => {});
});
udp.bind(DNS_PORT, () => { udpUp = true; console.log(`[dns-relay] udp+tcp :${DNS_PORT}`); });

const tcp = net.createServer((sock) => {
  sock.setTimeout(15_000, () => sock.destroy());
  sock.on("error", () => sock.destroy());
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {                                        // 2-byte length framing; may carry several queries
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) return;
      const out = handle(buf.subarray(2, 2 + len), 0);
      buf = buf.subarray(2 + len);
      if (out) sock.write(Buffer.concat([u16(out.length), out]));
    }
  });
});
tcp.on("error", (e) => { console.error("[dns-relay] tcp:", e.message); process.exit(1); });
tcp.listen(DNS_PORT);

// ---- challenge-push HTTP API --------------------------------------------------

if (!SECRET) console.error("[dns-relay] SECRET unset — the challenge-push API will answer 503");

// hex HMAC-SHA256 over the RAW body with the fleet's shared SECRET, constant-time
function checkSig(sig, raw) {
  if (typeof sig !== "string" || !/^[0-9a-fA-F]{64}$/.test(sig)) return false;
  const want = createHmac("sha256", SECRET).update(raw).digest();
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(want, got);
}

const api = http.createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const u = new URL(req.url, "http://x");

  if (req.method === "GET" && u.pathname === "/health") {
    let txtRecords = 0;
    for (const name of [...txtStore.keys()]) txtRecords += txtValues(name).length;
    return json(200, { ok: true, zones: { ip: IP_ZONE, app: APP_ZONE },
                       deployments: deployments.length, txtRecords });
  }
  if (u.pathname !== "/v1/txt" || (req.method !== "POST" && req.method !== "DELETE"))
    return json(404, { error: "not_found", routes: ["GET /health", "POST /v1/txt", "DELETE /v1/txt"] });
  if (!SECRET) return json(503, { error: "no_secret", message: "SECRET is not configured on this relay." });

  const chunks = []; let size = 0;
  req.on("data", (d) => { size += d.length; if (size > 65536) req.destroy(); else chunks.push(d); });
  req.on("error", () => {});
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (!checkSig(req.headers["x-relay-sig"], raw)) return json(401, { error: "bad_signature" });
    let body; try { body = JSON.parse(raw.toString("utf8")); } catch { return json(400, { error: "bad_json" }); }
    const name = typeof body?.name === "string" ? fqdn(body.name) : "";
    const value = typeof body?.value === "string" ? body.value : "";
    if (!name.startsWith("_acme-challenge.") || !name.endsWith("." + APP_ZONE) || name.length > 253)
      return json(400, { error: "bad_name", message: "name must be _acme-challenge.<name>." + APP_ZONE });
    if (!value || value.length > 1024) return json(400, { error: "bad_value" });

    if (req.method === "POST") {
      let ttl = TXT_TTL_S;   // body ttlSec can only SHORTEN the cap, never extend it
      if (Number.isFinite(body.ttlSec) && body.ttlSec > 0) ttl = Math.min(ttl, body.ttlSec);
      const vals = txtStore.get(name) || new Map();
      vals.set(value, Date.now() + ttl * 1000);
      txtStore.set(name, vals);
      console.log(`[dns-relay] txt set ${name} (${vals.size} value${vals.size === 1 ? "" : "s"}, ttl ${ttl}s)`);
      return json(200, { ok: true, name, values: vals.size, ttlSec: ttl });
    }
    const vals = txtStore.get(name);
    if (vals) { vals.delete(value); if (!vals.size) txtStore.delete(name); }
    return json(200, { ok: true, name, values: vals ? vals.size : 0 });
  });
});
api.on("error", (e) => { console.error("[dns-relay] api:", e.message); process.exit(1); });
api.listen(API_PORT, API_BIND, () => console.log(`[dns-relay] challenge-push api :${API_PORT}`));

// ---- boot ---------------------------------------------------------------------

await fleet.start();
await poll();
setInterval(poll, POLL_MS);
console.log(`[dns-relay] authoritative for ${IP_ZONE} + ${APP_ZONE} (ns ${NS_NAME}, serial ${SERIAL}); ` +
            `polling /v1/net-map across the fleet every ${POLL_MS / 1000}s`);
