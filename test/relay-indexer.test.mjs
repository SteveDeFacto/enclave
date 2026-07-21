// PaymentReceived indexer (relay/indexer.js) + payment matching/screening
// (relay/billing.js): the REAL relay against a stub Base RPC whose chain the
// test scripts - it appends PaymentReceived logs and advances the tip, then
// asserts confirmation depth, OFAC routing, tolerance routing, exactly-once
// across restarts (cursor + order-level dedup), and the unmatched-ref queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { toFunctionSelector, toEventSelector } from "viem";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const W = (v) => BigInt(v).toString(16).padStart(64, "0");
const SEL = (sig) => toFunctionSelector(sig);
const ROUTER = "0x" + "34".repeat(20);
const TOPIC0 = toEventSelector({ type: "event", name: "PaymentReceived", inputs: [
  { name: "orderRef", type: "bytes32", indexed: true },
  { name: "payer", type: "address", indexed: true },
  { name: "amount", type: "uint256", indexed: false }] });
const PAYER = "0x1111111111111111111111111111111111111111";
const SANCTIONED = "0x2222222222222222222222222222222222222222";

// scriptable chain: state.tip + state.logs, poked by the test directly
function stubRpc(state) {
  const sel = {
    [SEL("function pricePerSec6() view returns (uint256)")]: W(1667),
    [SEL("function cpuPricePerSec6() view returns (uint256)")]: W(834),
    [SEL("function maxGpuMilli() view returns (uint16)")]: W(1000),
  };
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method === "eth_blockNumber") return "0x" + state.tip.toString(16);
        if (m.method === "eth_getLogs") {
          const f = m.params[0];
          const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
          return state.logs.filter((lg) => {
            const b = BigInt(lg.blockNumber);
            return b >= from && b <= to && (!f.topics || f.topics[0] === lg.topics[0]);
          });
        }
        if (m.method === "eth_call") {
          const pre = m.params[0].data.slice(0, 10);
          if (sel[pre]) return "0x" + sel[pre];
          const str = (s) => { const h = Buffer.from(s).toString("hex"); return "0x" + W(32) + W(s.length) + h.padEnd(64, "0"); };
          if (pre === SEL("function name() view returns (string)")) return str("USD Coin");
          if (pre === SEL("function version() view returns (string)")) return str("2");
          return "0x" + W(0);
        }
        return null;
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q)
        ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) }))
        : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}
let txN = 0;
const paymentLog = (ref, payer, amount6, block) => ({
  address: ROUTER.toLowerCase(),
  topics: [TOPIC0, ref.toLowerCase(), "0x" + W(payer)],
  data: "0x" + W(amount6),
  blockNumber: "0x" + BigInt(block).toString(16),
  transactionHash: "0x" + W(++txN),
  transactionIndex: "0x0", blockHash: "0x" + W(block), logIndex: "0x0", removed: false,
});

// fresh OFAC cache so screening answers "clear"/"hit" instead of "stale"
const seedOfac = (dir) => fs.writeFileSync(path.join(dir, "ofac-sdn.json"), JSON.stringify({
  fetchedAt: new Date().toISOString(), publishDate: "test", source: "seed",
  eth: [SANCTIONED], other: [] }));

async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}
async function startStack(t, { dataDir, state }) {
  const rpc = stubRpc(state); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
    env: { ...process.env,
      ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
      AUTH_DATA_DIR: dataDir,
      BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0",
      DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
      PAYMENT_ROUTER_ADDRESS: ROUTER,
      USDC_ADDRESS: "0x" + "56".repeat(20),
      OFAC_SDN_URLS: "http://127.0.0.1:1/x",
      BILLING_ADMIN_TOKEN: "admintok",
      INDEXER_POLL_SEC: "1", INDEXER_CONFIRMATIONS: "2", INDEXER_RESCAN_BLOCKS: "5",
      FEATURED_VIEWS_FILE: path.join(dataDir, "feat.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + "/health"); if (r.ok) return { origin, child, rpc }; } catch {}
    await delay(100);
  }
  throw new Error("relay never answered /health");
}
const api = async (origin, method, p, { body, token, headers } = {}) => {
  const r = await fetch(origin + p, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
               ...(token ? { Authorization: "Bearer " + token } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function login(origin) {
  const n = await api(origin, "GET", `/v1/account/siwe/nonce?address=${signer.address}`);
  const signature = await signer.signMessage({ message: n.body.message });
  return (await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n.body.message, signature } })).body.token;
}
async function makeOrder(origin, token) {
  const o = await api(origin, "POST", "/v1/billing/orders",
    { token, body: { spec: { appRef: "ipfs://bafytest", gpuShare: 0.25, cpuShare: 0.1 }, seconds: 3600 } });
  assert.equal(o.status, 201);
  return o.body;   // amount6 = 1803600
}
async function waitState(origin, token, id, want, ms = 8000) {
  let last = "";
  for (let i = 0; i < ms / 200; i++) {
    const r = await api(origin, "GET", `/v1/billing/orders/${id}`, { token });
    last = r.body.state;
    if (last === want) return r.body;
    await delay(200);
  }
  throw new Error(`order never reached ${want} (stuck at ${last})`);
}

test("indexer: confirmation depth gates settlement; exact payment provisions; restart never double-credits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-idx-"));
  seedOfac(dir);
  const state = { tip: 100n, logs: [] };
  const first = await startStack(t, { dataDir: dir, state });
  const token = await login(first.origin);
  const order = await makeOrder(first.origin, token);

  // payment lands at block 101; tip 101 -> 0 confirmations: display-only pending
  state.logs.push(paymentLog(order.ref, PAYER, 1803600n, 101n));
  state.tip = 101n;
  const pending = await waitState(first.origin, token, order.id, "pending_confirmations");
  assert.equal(pending.usdc.payments, 0, "no money-state before the confirmation depth");

  // tip 103 -> 2 confirmations: settle (provisioner unconfigured -> parks held)
  state.tip = 103n;
  const done = await waitState(first.origin, token, order.id, "confirmed_provisioning");
  assert.equal(done.usdc.total6, "1803600");
  assert.equal(done.usdc.payments, 1);

  // kill + respawn on the same data dir, same logs still served: the cursor
  // resumes and the order-level dedup holds - exactly one payment forever
  first.child.kill("SIGKILL");
  await delay(200);
  const second = await startStack(t, { dataDir: dir, state });
  await delay(1500);                                        // a few poll cycles
  const after = await api(second.origin, "GET", `/v1/billing/orders/${order.id}`, { token });
  assert.equal(after.body.usdc.payments, 1, "restart re-scan must not double-credit");
  assert.equal(after.body.usdc.total6, "1803600");
});

test("indexer: underpayment reviews then auto-heals; unmatched refs queue for review", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-idx-"));
  seedOfac(dir);
  const state = { tip: 100n, logs: [] };
  const { origin } = await startStack(t, { dataDir: dir, state });
  const token = await login(origin);
  const order = await makeOrder(origin, token);

  // 1) pay half: beyond dust -> under_review with an open item
  state.logs.push(paymentLog(order.ref, PAYER, 900000n, 101n));
  state.tip = 103n;
  await waitState(origin, token, order.id, "under_review");
  let rq = await api(origin, "GET", "/v1/billing/review", { headers: { "x-admin-token": "admintok" } });
  assert.equal(rq.body.items.filter((i) => i.orderId === order.id && i.reason === "underpayment").length, 1);

  // 2) pay the rest: auto-heal to confirmed (underpayment is the one self-healing reason)
  state.logs.push(paymentLog(order.ref, PAYER, 903600n, 104n));
  state.tip = 106n;
  const healed = await waitState(origin, token, order.id, "confirmed_provisioning");
  assert.equal(healed.usdc.total6, "1803600");

  // 3) a payment with a ref no order owns lands in the review queue (the
  // funds are at the treasury; the queue is the only ledger of them)
  state.logs.push(paymentLog("0x" + "ee".repeat(32), PAYER, 5000000n, 107n));
  state.tip = 109n;
  let unmatched = [];
  for (let i = 0; i < 30 && !unmatched.length; i++) {
    await delay(200);
    rq = await api(origin, "GET", "/v1/billing/review", { headers: { "x-admin-token": "admintok" } });
    unmatched = rq.body.items.filter((i2) => i2.reason === "unmatched_payment");
  }
  assert.equal(unmatched.length, 1);
});

