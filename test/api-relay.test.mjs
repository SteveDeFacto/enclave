// api-relay ledger-backed deployments — the public API must return EVERY
// on-chain deployment a wallet owns, hosted by an enclave or not. Drives the
// REAL relay as a child process against a stub Base JSON-RPC (serving
// ABI-encoded EnclaveDeployments pages) and fake/dead in-test "enclaves":
// fleet-down list/get answer from the ledger alone; fleet-up merges hosted
// rows (which win by id) with ledger-only rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ABI fixtures: EnclaveDeployments.count()/getPage() --------------
// The stub plays a schema rev-2 ledger (17-field Deployment, no sshPubKey).
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function tupleOf(d) {
  const strs = [d.appRef, d.ports ?? "", d.configCid ?? ""].map((s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    return { body: W(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) };
  });
  let off = 17 * 32;
  const strHeads = strs.map((s) => { const h = W(off); off += s.words * 32; return h; });
  return [
    W(d.id), W(d.owner), strHeads[0], strHeads[1], strHeads[2],
    W(d.gpuMilli ?? 0), W(d.cpuMilli ?? 10), W(d.appPort ?? 8080), W(d.isPublic ? 1 : 0), W(d.active ? 1 : 0),
    W(d.createdAt ?? 1700000000), W(d.rate ?? 3), W(d.balance6 ?? 0), W(d.spent6 ?? 0),
    W(d.runner ?? "0x" + "0".repeat(64)), W(d.runnerOperator ?? "0x" + "0".repeat(40)), W(d.leaseUntil ?? 0),
  ].join("") + strs.map((s) => s.body).join("");
}
function encPage(rows) {
  const tuples = rows.map(tupleOf);
  let off = rows.length * 32;
  const heads = tuples.map((t) => { const h = W(off); off += t.length / 2; return h; });
  return "0x" + W(32) + W(rows.length) + heads.join("") + tuples.join("");
}

// ---------- the ledger under test -------------------------------------------
const OWNER   = "0x" + "aa".repeat(20);
const OTHER   = "0x" + "bb".repeat(20);
const RUNNER  = "0x" + "22".repeat(32);
const FUTURE  = Math.floor(Date.now() / 1000) + 3600;
const ID = (b) => "0x" + b.repeat(32);
const LEDGER = [
  { id: ID("11"), owner: OWNER, appRef: "ipfs://queued", active: true,  balance6: 5_000_000, spent6: 0 },                                   // funded, unclaimed
  { id: ID("22"), owner: OWNER, appRef: "ipfs://stopped", active: false, balance6: 1_000_000, spent6: 500_000 },                            // owner-stopped
  { id: ID("33"), owner: OWNER, appRef: "ipfs://claimed", active: true,  balance6: 2_000_000, spent6: 100_000, runner: RUNNER, leaseUntil: FUTURE }, // lease live, runner silent
  { id: ID("44"), owner: OWNER, appRef: "ipfs://unpaid", active: true, balance6: 0, spent6: 0 },                                            // created, never funded
  { id: ID("55"), owner: OTHER, appRef: "ipfs://foreign", active: true,  balance6: 9_000_000, spent6: 0 },                                  // someone else's
  { id: ID("88"), owner: OWNER, appRef: "ipfs://drained", active: true,  balance6: 2, spent6: 4_999_998, runner: RUNNER, leaseUntil: 1700000500 }, // ran, lease over, balance < rate
];

// ---------- harness ----------------------------------------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub, exp = Math.floor(Date.now() / 1000) + 3600) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub, exp })}.x`;

async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}
function stubRpc(ledger = LEDGER) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W(2);                        // deploymentsSchema() -> rev 2
        if (data.startsWith("0x06661abd")) return "0x" + W(ledger.length);            // count()
        const start = Number(BigInt("0x" + data.slice(10, 74)));
        const n = Number(BigInt("0x" + data.slice(74, 138)));
        return encPage(ledger.slice(start, start + n));                               // getPage(start, n)
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q)
        ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) }))
        : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}
async function startRelay(t, { enclaves, ledger }) {
  const rpc = stubRpc(ledger); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
    env: { ...process.env, ENCLAVES: enclaves, API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
           BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write("[relay] " + d));
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {                     // relay boots after its first polls
    try { const r = await fetch(origin + "/health"); if (r.ok) return origin; } catch {}
    await delay(100);
  }
  throw new Error("relay never answered /health");
}
const getJson = async (origin, p, tok) => {
  const r = await fetch(origin + p, { headers: tok ? { Authorization: "Bearer " + tok } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------- fleet DOWN: the ledger alone answers -----------------------------
test("api-relay: zero live enclaves — list returns every on-chain deployment the wallet owns", async (t) => {
  const origin = await startRelay(t, { enclaves: "http://127.0.0.1:1" });   // dead enclave -> live=[]

  const { status, body } = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(status, 200);
  const rows = body.data;
  assert.equal(rows.length, 5, "all five of the owner's ledger records, none of the foreign one");
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by[ID("11")].status, "queued");
  assert.equal(by[ID("22")].status, "stopped");
  assert.equal(by[ID("33")].status, "claimed");
  assert.equal(by[ID("44")].status, "awaiting_payment");
  assert.equal(by[ID("88")].status, "unfunded", "drained work (balance < rate) must not read as queued: nothing will claim it");
  assert.ok(rows.every((r) => r.ledger === true), "rows are marked as ledger-synthesized");
  assert.equal(by[ID("11")].image.reference, "ipfs://queued");
  assert.equal(by[ID("11")].paidUsdc, "5.00");
  assert.equal(by[ID("22")].paidUsdc, "1.50", "paid = balance + spent");
  assert.ok(by[ID("33")].onchain.leaseUntil, "live lease surfaces its expiry");
  // remaining runtime counts the PREPAID lease tail, not just the balance:
  // 2_000_000 balance / rate 3 = 666_666s funded + up to 3600s of live lease
  assert.ok(by[ID("33")].timeRemainingSec > 666_666, "a live lease adds its prepaid tail to timeRemainingSec");
  assert.ok(by[ID("33")].timeRemainingSec <= 666_666 + 3600, "…but no more than the lease that was bought");
  assert.equal(by[ID("88")].timeRemainingSec, 0, "drained + expired lease = nothing left");

  // TOKENLESS listing: a connected wallet's address is enough (?owner= scopes
  // the public ledger rows - no SIWE popup needed just to see your fleet)
  const noTok = await getJson(origin, "/v1/deployments?owner=" + OWNER);
  assert.equal(noTok.status, 200);
  assert.equal(noTok.body.data.length, 5, "owner param scopes the same 5 rows without any token");
  assert.ok(noTok.body.data.every((r) => r.ledger === true));
  // scoping is NOT authentication: ledger rows are public on-chain data
  const foreign = await getJson(origin, "/v1/deployments?owner=" + OTHER);
  assert.equal(foreign.body.data.length, 1, "any address's public rows are listable");
  // neither token nor owner -> 401 (nothing to scope the list by)
  assert.equal((await getJson(origin, "/v1/deployments")).status, 401);
  // expired token and no owner -> 401 too
  assert.equal((await getJson(origin, "/v1/deployments", jwt(OWNER, 1))).status, 401);
  // tokenless bare read: ?owner= scopes, and even unscoped reads resolve
  // (records are public); prefixes disambiguate within the scope
  const noTokOne = await getJson(origin, "/v1/deployments/" + ID("11") + "?owner=" + OWNER);
  assert.equal(noTokOne.status, 200);
  assert.equal(noTokOne.body.status, "queued");

  // bare record read: full id and unique prefix both resolve from the ledger
  const one = await getJson(origin, "/v1/deployments/" + ID("11"), jwt(OWNER));
  assert.equal(one.status, 200);
  assert.equal(one.body.status, "queued");
  const pre = await getJson(origin, "/v1/deployments/0x2222", jwt(OWNER));
  assert.equal(pre.status, 200, "prefix resolves");
  assert.equal(pre.body.id, ID("22"));
  // someone else's record and unknown ids stay invisible
  assert.equal((await getJson(origin, "/v1/deployments/" + ID("55"), jwt(OWNER))).status, 404);
  assert.equal((await getJson(origin, "/v1/deployments/" + ID("99"), jwt(OWNER))).status, 404);
  // subpaths (logs/attestation) still need a live enclave
  assert.equal((await getJson(origin, "/v1/deployments/" + ID("11") + "/logs", jwt(OWNER))).status, 503);

  // fleet-down honesty: the API front door is UP (health says so instead of
  // crying no_capacity), and auth failures explain what is actually down
  const health = await getJson(origin, "/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.enclaves, 0);
  const nonce = await getJson(origin, "/v1/auth/nonce?address=" + OWNER);
  assert.equal(nonce.status, 503);
  assert.equal(nonce.body.error, "auth_unavailable", "sign-in failures name the real cause, not generic no_capacity");
  assert.match(nonce.body.message, /enclave-issued/);
});

// ---------- fleet UP: hosted rows win, ledger fills the gaps -----------------
test("api-relay: live enclave rows merge with ledger-only rows, deduped by id", async (t) => {
  const hosted = { id: ID("33"), status: "running", owner: OWNER, image: { reference: "ipfs://claimed" },
                   resources: { gpuShare: 0, cpuShare: 0.01 } };
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    if (req.url === "/v1/deployments" && req.method === "GET") return res.end(JSON.stringify({ data: [hosted], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${enclave.address().port}` });
  const { status, body } = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(status, 200);
  const by = Object.fromEntries(body.data.map((r) => [r.id, r]));
  assert.equal(body.data.length, 5, "hosted row + the 4 ledger-only rows, no duplicate for the hosted id");
  assert.equal(by[ID("33")].status, "running", "the enclave's live row wins over the ledger view");
  assert.equal(by[ID("33")].ledger, undefined);
  assert.equal(by[ID("11")].status, "queued");
  assert.ok(by[ID("11")].ledger, "unhosted work still comes from the ledger");

  // a TOKENLESS bare read of a HOSTED id must not proxy (the enclave would
  // 401 it) - the ledger view answers instead
  const bare = await getJson(origin, "/v1/deployments/" + ID("33"));
  assert.equal(bare.status, 200);
  assert.equal(bare.body.status, "claimed", "tokenless hosted read serves the ledger view, not a proxied 401");
  assert.ok(bare.body.ledger);
});

// ---------- lease + live runner: the ledger view says "running" --------------
// The dashboard's tokenless list is built purely from ledger rows; a deployment
// whose lease-holder is a live, answering enclave must read "running", not sit
// on "claimed" forever. The match is the registry's id rule: keccak256(endpoint).
test("api-relay: a leased deployment whose runner is live reads as running, even tokenless", async (t) => {
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5 }));
    res.statusCode = 404; res.end("{}");
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());
  const endpoint = `http://127.0.0.1:${enclave.address().port}`;
  const { keccak256, stringToBytes } = await import("viem");
  const ledger = [
    { id: ID("66"), owner: OWNER, appRef: "ipfs://hosted", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: keccak256(stringToBytes(endpoint)), leaseUntil: FUTURE },     // lease live, runner IS the live enclave
    { id: ID("77"), owner: OWNER, appRef: "ipfs://orphaned", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: RUNNER, leaseUntil: FUTURE },                                 // lease live, runner unknown/absent
  ];

  const origin = await startRelay(t, { enclaves: endpoint, ledger });
  const { status, body } = await getJson(origin, "/v1/deployments?owner=" + OWNER);
  assert.equal(status, 200);
  const by = Object.fromEntries(body.data.map((r) => [r.id, r]));
  assert.equal(by[ID("66")].status, "running", "lease live + runner answering = running, no session needed");
  assert.equal(by[ID("77")].status, "claimed", "lease live but runner silent stays claimed");
  const bare = await getJson(origin, "/v1/deployments/" + ID("66"));
  assert.equal(bare.status, 200);
  assert.equal(bare.body.status, "running", "the tokenless bare read agrees");
});

// ---------- fleet refuses the token: surface the 401, don't mask it ----------
test("api-relay: a fleet-wide 401 propagates instead of falling back to ledger rows", async (t) => {
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5 }));
    res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized", message: "bad token" }));
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${enclave.address().port}` });
  const r = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(r.status, 401, "the enclaves' refusal is the answer; public ledger rows must not mask a dead session");
});
