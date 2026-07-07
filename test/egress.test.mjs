// End-to-end test for dedicated-IP egress (egress.js + net-guard.mjs) and the
// three guardrails. Stands up the enclave-side egress front, a faithful relay
// stub (same net-guard classifier the real relay/egress-relay.js uses), and an
// echo target, then drives it with a real SOCKS5 client.
//
// The PHASE-2 block at the bottom additionally drives a REAL patched wasmtime
// (transparent egress: the -S egress shim) with two unmodified guest components,
// proving an app's raw wasi:sockets / wasi:http outbound is transparently routed
// through this same front — and that the raw bypass is gone. Those tests SKIP
// unless a patched wasmtime is pointed at via $ENCLAVE_EGRESS_WASMTIME, so the pure
// phase-1 suite stays green everywhere.
//
//   run: node --test test/egress.test.mjs
//   run (incl. phase 2): ENCLAVE_EGRESS_WASMTIME=/path/to/wasmtime node --test test/egress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket, { createWebSocketStream } from "ws";
import { createEgress, egressToken } from "../egress.js";
import { isBlockedHost, parseIp } from "../net-guard.mjs";

const SECRET = new TextEncoder().encode("test-enclave-secret");
const RELAY_TOKEN = "relay-shared-token";
const sourceAddrFor = (id) => `fd00::${Buffer.from(id).toString("hex").slice(0, 4)}`;

// ---- helpers ---------------------------------------------------------------
function reader(sock) {
  let buf = Buffer.alloc(0); const waiters = [];
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
  sock.on("close", () => { for (const w of waiters.splice(0)) w.reject(new Error("closed")); });
  function pump() { while (waiters.length && buf.length >= waiters[0].n) {
    const w = waiters.shift(); const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(out); } }
  return (n) => new Promise((resolve, reject) => { waiters.push({ n, resolve, reject }); pump(); });
}

// minimal SOCKS5 client: greet -> user/pass auth -> CONNECT. Returns
// { authOk, reply } and leaves `sock` as a raw tunnel on success.
async function socks({ port, user, pass, atyp, host, dport }) {
  const sock = net.connect(port, "127.0.0.1");
  await once(sock, "connect");
  const read = reader(sock);
  sock.write(Buffer.from([0x05, 0x01, 0x02]));                 // one method: user/pass
  const method = await read(2);
  assert.equal(method[0], 0x05);
  if (method[1] === 0xff) return { sock, authOk: false, reply: null };
  const u = Buffer.from(user), p = Buffer.from(pass);
  sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
  const auth = await read(2);
  if (auth[1] !== 0x00) return { sock, authOk: false, reply: null };
  // request
  let addr;
  if (atyp === 0x01) addr = Buffer.from(host.split(".").map(Number));
  else if (atyp === 0x04) { const ip = parseIp(host); addr = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) addr[i] = Number((ip.value >> BigInt((15 - i) * 8)) & 0xffn); }
  else { const h = Buffer.from(host); addr = Buffer.concat([Buffer.from([h.length]), h]); }
  const pb = Buffer.alloc(2); pb.writeUInt16BE(dport);
  sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addr, pb]));
  // reply length depends on the REPLY's ATYP (success = v6 BND.ADDR), not the
  // request's — read the 4-byte header, then the address+port it announces.
  const head = await read(4);
  const rest = head[3] === 0x04 ? await read(16 + 2)
             : head[3] === 0x03 ? await read((await read(1))[0] + 2)
             : await read(4 + 2);
  return { sock, authOk: true, reply: Buffer.concat([head, rest]) };
}

// stand up: echo server, enclave (egress front), relay stub. Returns teardown +
// the captured OPEN frames the relay saw.
async function harness() {
  const opens = [];
  const echo = net.createServer((s) => s.pipe(s)); echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const echoPort = echo.address().port;

  const egress = createEgress({ secret: SECRET, socksPort: 0, relayToken: RELAY_TOKEN, sourceAddrFor,
                                isKnown: (id) => id.startsWith("dep"), log: () => {} });
  const enclave = http.createServer();
  enclave.on("upgrade", (req, socket, head) => { if (!egress.handleUpgrade(req, socket, head)) socket.destroy(); });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  const enclavePort = enclave.address().port;
  await egress.start();                                     // socksPort 0 -> OS-assigned
  const socksPort = egress.socksPort();

  // relay stub — the same classifier the real daemon uses; dials the echo server
  const handles = [];                                        // everything to tear down
  const control = new WebSocket(`ws://127.0.0.1:${enclavePort}/v1/egress-control`, { headers: { Authorization: `Bearer ${RELAY_TOKEN}` } });
  handles.push(control);
  await once(control, "open");
  control.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "open") return;
    opens.push(m);
    if (isBlockedHost(m.host)) { control.send(JSON.stringify({ type: "close", cid: m.cid, reason: "denied" })); return; }
    const dst = net.connect(echoPort, "127.0.0.1"); handles.push(dst);   // test target (ignores m.host)
    dst.on("error", () => control.send(JSON.stringify({ type: "close", cid: m.cid, reason: "error" })));
    dst.on("connect", () => {
      dst.pause();
      const ws = new WebSocket(`ws://127.0.0.1:${enclavePort}/x/egress/${m.cid}`, { headers: { Authorization: `Bearer ${RELAY_TOKEN}` } });
      handles.push(ws);
      const stream = createWebSocketStream(ws);
      const close = () => { try { ws.terminate(); } catch {} try { dst.destroy(); } catch {} };
      dst.on("close", close); dst.on("error", close); stream.on("error", close); stream.on("close", close); ws.on("error", close);
      ws.on("open", () => { dst.pipe(stream); stream.pipe(dst); dst.resume(); });
    });
  });

  return { socksPort, enclavePort, opens,
    teardown: () => { for (const h of handles) { try { h.terminate ? h.terminate() : h.destroy(); } catch {} }
      echo.close(); enclave.close(); egress.stop(); } };
}

// ---- guardrail 2: SSRF classifier (unit) -----------------------------------
test("net-guard blocks internal ranges, allows global unicast", () => {
  for (const b of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.9.9", "169.254.1.1",
                   "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1",
                   "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
                   "::ffff:127.0.0.1", "::ffff:10.1.2.3", "2001:db8::1", "localhost", "FOO.localhost"])
    assert.equal(isBlockedHost(b), true, `${b} should be blocked`);
  for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111",
                   "2a01:4f9:c013:bdfd::1", "example.com", "api.openai.com"])
    assert.equal(isBlockedHost(a), false, `${a} should be allowed`);
});

// ---- guardrail 1: per-deployment credentials -------------------------------
test("wrong SOCKS password is rejected (tenant isolation)", async () => {
  const h = await harness();
  const { authOk } = await socks({ port: h.socksPort, user: "depA", pass: "not-the-token",
                                   atyp: 0x03, host: "echo.test", dport: 80 });
  assert.equal(authOk, false);
  h.teardown();
});

test("a deployment egresses from ITS OWN derived source, never a chosen one", async () => {
  const h = await harness();
  const { sock, reply, authOk } = await socks({ port: h.socksPort, user: "depA", pass: egressToken(SECRET, "depA"),
                                                atyp: 0x03, host: "echo.test", dport: 80 });
  assert.equal(authOk, true);
  assert.equal(reply[1], 0x00, "CONNECT should succeed");
  // the OPEN frame the relay received carries the source derived from the id
  assert.equal(h.opens.at(-1).source, sourceAddrFor("depA"));
  // and the SOCKS reply BND.ADDR echoes that same v6 back to the app
  assert.equal(reply[3], 0x04, "reply ATYP should be v6");
  const bnd = []; for (let i = 0; i < 8; i++) bnd.push(reply.readUInt16BE(4 + i * 2).toString(16));
  assert.equal(parseIp(bnd.join(":")).value, parseIp(sourceAddrFor("depA")).value);
  sock.destroy(); h.teardown();
});

// ---- happy path: splice integrity ------------------------------------------
test("bytes round-trip through the tunnel both ways", async () => {
  const h = await harness();
  const { sock, reply } = await socks({ port: h.socksPort, user: "depB", pass: egressToken(SECRET, "depB"),
                                        atyp: 0x03, host: "echo.test", dport: 7 });
  assert.equal(reply[1], 0x00);
  const read = reader(sock);
  sock.write(Buffer.from("hello-egress"));
  const got = await read(12);
  assert.equal(got.toString(), "hello-egress");
  sock.destroy(); h.teardown();
});

// ---- guardrail 2: SSRF at the front (literal internal IP) -------------------
test("CONNECT to a loopback literal is denied before leaving the enclave", async () => {
  const h = await harness();
  const { reply } = await socks({ port: h.socksPort, user: "depA", pass: egressToken(SECRET, "depA"),
                                  atyp: 0x01, host: "127.0.0.1", dport: 22 });
  assert.equal(reply[1], 0x02, "REP should be 0x02 (not allowed)");
  assert.equal(h.opens.length, 0, "denied dst must never reach the relay");
  h.teardown();
});

// ---- guardrail 3: cid is single-use ----------------------------------------
test("a used connection id cannot be re-opened by the relay", async () => {
  const h = await harness();
  const { sock, reply } = await socks({ port: h.socksPort, user: "depA", pass: egressToken(SECRET, "depA"),
                                        atyp: 0x03, host: "echo.test", dport: 80 });
  assert.equal(reply[1], 0x00);
  sock.destroy();
  const cid = h.opens.at(-1).cid;
  const ws = new WebSocket(`ws://127.0.0.1:${h.enclavePort}/x/egress/${cid}`, { headers: { Authorization: `Bearer ${RELAY_TOKEN}` } });
  ws.on("error", () => {});                                   // 404 upgrade surfaces as a late error
  const [, res] = await once(ws, "unexpected-response");
  assert.equal(res.statusCode, 404, "second data WS for the same cid must 404");
  res.destroy(); ws.terminate(); await once(ws, "close").catch(() => {}); h.teardown();
});

// ---- relay-channel auth ----------------------------------------------------
test("control channel rejects a bad relay token", async () => {
  const h = await harness();
  const ws = new WebSocket(`ws://127.0.0.1:${h.enclavePort}/v1/egress-control`, { headers: { Authorization: "Bearer wrong" } });
  ws.on("error", () => {});                                   // 401 upgrade surfaces as a late error
  const [, res] = await once(ws, "unexpected-response");
  assert.equal(res.statusCode, 401);
  res.destroy(); ws.terminate(); await once(ws, "close").catch(() => {}); h.teardown();
});

// ===========================================================================
// PHASE 2 — TRANSPARENT EGRESS (real patched wasmtime, unmodified guests)
// ===========================================================================
// These drive an ACTUAL patched wasmtime (`-S egress` shim) so an UNMODIFIED
// app's raw wasi:sockets / wasi:http outbound is transparently routed through
// the SAME front + relay as phase 1 — no ENCLAVE_EGRESS in the guest. They prove:
//   (1) transparent routing carries the deployment's derived source;
//   (2) an internal/loopback destination is refused (SSRF; raw bypass closed);
//   (3) with the network locked down a raw dial reaches nothing directly;
//   (4) the wasi:http outgoing handler is mediated too (socks5h domain path).
// Skipped unless $ENCLAVE_EGRESS_WASMTIME points at a patched binary — the phase-1
// suite above needs no toolchain and stays green everywhere.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WASMTIME = process.env.ENCLAVE_EGRESS_WASMTIME;
const GUEST_TCP = process.env.ENCLAVE_EGRESS_GUEST_TCP || `${HERE}fixtures/egress-guest-tcp.wasm`;
const GUEST_HTTP = process.env.ENCLAVE_EGRESS_GUEST_HTTP || `${HERE}fixtures/egress-guest-http.wasm`;
const GUEST_SOCKS = process.env.ENCLAVE_EGRESS_GUEST_SOCKS || `${HERE}fixtures/egress-guest-socks.wasm`;
const phase2Skip = !WASMTIME ? "set $ENCLAVE_EGRESS_WASMTIME to a patched wasmtime to run phase-2 e2e"
  : ![GUEST_TCP, GUEST_HTTP, GUEST_SOCKS].every((g) => fs.existsSync(g)) ? "guest fixtures missing (test/fixtures/*.wasm)"
  : false;

// A harness whose mock relay dials `dialTarget` for every ALLOWED open (it
// ignores the guest's requested host, exactly like test/egress.test.mjs's echo
// relay) and records the OPEN frames. Reused by the TCP + HTTP guests.
async function phase2Harness(dialTarget) {
  const opens = [];
  const egress = createEgress({ secret: SECRET, socksPort: 0, relayToken: RELAY_TOKEN, sourceAddrFor,
                                isKnown: (id) => id.startsWith("dep"), log: () => {} });
  const enclave = http.createServer();
  enclave.on("upgrade", (req, s, head) => { if (!egress.handleUpgrade(req, s, head)) s.destroy(); });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  const enclavePort = enclave.address().port;
  await egress.start();
  const socksPort = egress.socksPort();
  const handles = [];
  const control = new WebSocket(`ws://127.0.0.1:${enclavePort}/v1/egress-control`, { headers: { Authorization: `Bearer ${RELAY_TOKEN}` } });
  handles.push(control); await once(control, "open");
  control.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "open") return;
    opens.push(m);
    if (isBlockedHost(m.host)) { control.send(JSON.stringify({ type: "close", cid: m.cid, reason: "denied" })); return; }
    const dst = net.connect(dialTarget.port, dialTarget.host); handles.push(dst);
    dst.on("error", () => control.send(JSON.stringify({ type: "close", cid: m.cid, reason: "error" })));
    dst.on("connect", () => {
      dst.pause();
      const ws = new WebSocket(`ws://127.0.0.1:${enclavePort}/x/egress/${m.cid}`, { headers: { Authorization: `Bearer ${RELAY_TOKEN}` } });
      handles.push(ws);
      const stream = createWebSocketStream(ws);
      const close = () => { try { ws.terminate(); } catch {} try { dst.destroy(); } catch {} };
      dst.on("close", close); dst.on("error", close); stream.on("error", close); stream.on("close", close); ws.on("error", close);
      ws.on("open", () => { dst.pipe(stream); stream.pipe(dst); dst.resume(); });
    });
  });
  return { socksPort, opens,
    teardown: () => { for (const h of handles) { try { h.terminate ? h.terminate() : h.destroy(); } catch {} } enclave.close(); egress.stop(); } };
}

// Spawn `wasmtime run` on a command guest with the given TARGET; capture stdout.
// egressOn injects `-S egress` + the host-side ENCLAVE_EGRESS_CRED (guest-invisible);
// inheritNetwork adds -Sinherit-network (the phase-1 raw path, for the negative);
// enclaveEgress exports the guest-visible ENCLAVE_EGRESS url (the phase-1 explicit path).
function runTcpGuest({ socksPort, id, target, egressOn = true, inheritNetwork = false,
                       guest = GUEST_TCP, enclaveEgress = false }) {
  const args = ["run", "-Scli", "-Sp3", "-Stcp", "-Sudp", "-Sallow-ip-name-lookup"];
  if (inheritNetwork) args.push("-Sinherit-network");
  if (egressOn) args.push("-S", `egress=127.0.0.1:${socksPort}`);
  if (enclaveEgress) args.push("--env", `ENCLAVE_EGRESS=socks5h://${id}:${egressToken(SECRET, id)}@127.0.0.1:${socksPort}`);
  args.push("--env", `TARGET=${target}`, guest);
  const env = { ...process.env };
  if (egressOn) env.ENCLAVE_EGRESS_CRED = `${id}:${egressToken(SECRET, id)}`;
  return new Promise((resolve) => {
    const p = spawn(WASMTIME, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 20000);
    p.on("close", () => { clearTimeout(kill); resolve({ out: out.trim(), err: err.trim() }); });
  });
}

test("phase2: transparent egress routes an UNMODIFIED guest's raw wasi:sockets outbound",
  { skip: phase2Skip }, async () => {
  const echo = net.createServer((s) => s.on("data", (d) => s.write(d)));
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: echo.address().port });
  // public literal dest passes SSRF at the front; the mock relay dials the echo
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: "93.184.216.34:80" });
  assert.match(r.out, /^OK ping-egress/, `guest out=${JSON.stringify(r.out)} err=${r.err.slice(0, 200)}`);
  const open = h.opens.at(-1);
  // GUARDRAIL 1: source derived server-side from the authenticated id
  assert.equal(open.source, sourceAddrFor("depX"), "egress must carry the deployment's derived source");
  // and it dialed the guest's actual intended destination
  assert.equal(open.host, "93.184.216.34"); assert.equal(open.port, 80);
  echo.close(); h.teardown();
});

test("phase2: a locked-down guest dialing a loopback literal is refused (SSRF; raw bypass closed)",
  { skip: phase2Skip }, async () => {
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });   // never dialed (front denies first)
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: "127.0.0.1:22" });
  assert.match(r.out, /^CONNERR/, `expected a connect error, got ${JSON.stringify(r.out)}`);
  assert.equal(h.opens.filter((o) => o.host === "127.0.0.1").length, 0, "a denied loopback dial must never reach the relay");
  h.teardown();
});

test("phase2: phase-1 explicit SOCKS (ENCLAVE_EGRESS) still works under the lockdown (front pass-through)",
  { skip: phase2Skip }, async () => {
  const echo = net.createServer((s) => s.on("data", (d) => s.write(d)));
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: echo.address().port });
  // The guest dials the loopback FRONT itself and speaks SOCKS5 explicitly —
  // the shim must pass that one destination through (everything else stays
  // mediated), or ENCLAVE_EGRESS would be dead on phase-2 toolchains.
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depS",
                                target: "egress-fixture.test:80", guest: GUEST_SOCKS, enclaveEgress: true });
  const m = r.out.match(/^OK (\S+) (.*)$/);
  assert.ok(m, `expected OK <bnd> <reply>, got out=${JSON.stringify(r.out)} err=${r.err.slice(0, 300)}`);
  // BND.ADDR carries the deployment's derived source (guardrail 1, phase-1 semantics)
  assert.equal(m[1], sourceAddrFor("depS"));
  assert.equal(m[2], "ping-egress");
  // and the CONNECT reached the relay as a DOMAIN (socks5h — resolved there)
  const open = h.opens.at(-1);
  assert.equal(open.host, "egress-fixture.test");
  assert.equal(open.source, sourceAddrFor("depS"));
  echo.close(); h.teardown();
});

test("phase2: with egress lockdown and no inherit-network, a raw connect reaches nothing",
  { skip: phase2Skip }, async () => {
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  // egress OFF and inherit-network OFF == the phase-2 run-mode network posture
  // with no egress front reachable: the default socket check denies every dial.
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: "93.184.216.34:80",
                                egressOn: false, inheritNetwork: false });
  assert.match(r.out, /^CONNERR/, `raw dial should be denied, got ${JSON.stringify(r.out)}`);
  assert.equal(h.opens.length, 0, "nothing should reach the relay");
  h.teardown();
});

test("phase2: the wasi:http outgoing handler is mediated too (serve mode, socks5h domain)",
  { skip: phase2Skip }, async () => {
  const target = http.createServer((_req, res) => { res.writeHead(200); res.end("hello-from-target"); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: target.address().port });
  const servePort = 34000 + Math.floor((Date.now() % 1000));
  const id = "depH";
  const env = { ...process.env, ENCLAVE_EGRESS_CRED: `${id}:${egressToken(SECRET, id)}` };
  // a DOMAIN target exercises the socks5h path (relay-side DNS): the front sends
  // the name, so hyper never resolves it locally.
  const p = spawn(WASMTIME, ["serve", "-Scli", "-Shttp", "-Sp3", "-O", "pooling-allocator=n",
    "-S", `egress=127.0.0.1:${h.socksPort}`, "--env", "TARGET=example.test:80",
    "--addr", `127.0.0.1:${servePort}`, GUEST_HTTP], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serr = ""; p.stderr.on("data", (d) => (serr += d));
  const up = await waitForPort(servePort, 10000);
  let body = "", status = 0;
  if (up) {
    await new Promise((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port: servePort, path: "/", method: "GET" }, (res) => {
        status = res.statusCode; res.on("data", (d) => (body += d)); res.on("end", resolve);
      });
      rq.on("error", () => resolve()); rq.end();
    });
  }
  try { p.kill("SIGKILL"); } catch {}
  target.close(); h.teardown();
  assert.ok(up && status === 200, `serve did not respond (up=${up} status=${status} stderr=${serr.slice(0, 200)})`);
  assert.match(body, /hello-from-target/, "wasi:http response must be proxied through egress");
  const open = h.opens.at(-1);
  assert.equal(open.source, sourceAddrFor(id), "wasi:http egress must carry the deployment's derived source");
  assert.equal(open.host, "example.test", "host must reach the front as a socks5h DOMAIN (remote DNS)");
  assert.equal(open.port, 80);
});

function waitForPort(port, ms) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => { s.destroy(); Date.now() - t0 > ms ? resolve(false) : setTimeout(tick, 100); });
    };
    tick();
  });
}
