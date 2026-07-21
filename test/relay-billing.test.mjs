// Order service + Stripe (relay/billing.js): tolerance policy and webhook
// signature units, then the REAL relay against a stub Base RPC (serving the
// ledger's price views) and a stub Stripe API. The provisioner is deliberately
// UNCONFIGURED here, so paid orders park in confirmed_provisioning - which is
// exactly the promised held-safe behavior.
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
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { toFunctionSelector } from "viem";
import { evaluatePayment, verifyStripeSignature } from "../relay/billing.js";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const W = (v) => BigInt(v).toString(16).padStart(64, "0");
const SEL = (sig) => toFunctionSelector(sig);

// ---------- pure units: tolerance policy -------------------------------------
test("evaluatePayment: dust under provisions, real under reviews, overpay provisions (large flagged)", () => {
  const amount = 10_000_000n;                                   // $10 quote
  assert.equal(evaluatePayment(amount, 0n).action, "review");   // nothing paid
  assert.equal(evaluatePayment(amount, amount).action, "provision");
  // dust = max($0.05, 0.5%) = $0.05 on a $10 order
  assert.equal(evaluatePayment(amount, amount - 50_000n).action, "provision");   // exactly at dust
  assert.equal(evaluatePayment(amount, amount - 50_001n).action, "review");      // one micro-cent beyond
  assert.equal(evaluatePayment(amount, amount - 50_001n).reason, "underpayment");
  // percentage dust wins on big orders: 0.5% of $100k = $500
  const big = 100_000_000_000n;
  assert.equal(evaluatePayment(big, big - 400_000_000n).action, "provision");
  // overpay always provisions; large overpay (> max($10, 10%)) is flagged
  assert.deepEqual(evaluatePayment(amount, amount + 1_000_000n).flags, []);      // +$1: quiet
  const flagged = evaluatePayment(amount, amount + 20_000_000n);                 // +$20 on $10
  assert.equal(flagged.action, "provision");
  assert.deepEqual(flagged.flags, ["large_overpayment"]);
  // auto-heal shape: an underpaid total that a second payment completes
  assert.equal(evaluatePayment(amount, 4_000_000n).action, "review");
  assert.equal(evaluatePayment(amount, 4_000_000n + 6_000_000n).action, "provision");
});

test("verifyStripeSignature: HMAC, timestamp window, constant-time", () => {
  const secret = "whsec_test_abc", body = '{"id":"evt_1","type":"x"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = (ts, sec = secret) => `t=${ts},v1=${createHmac("sha256", sec).update(`${ts}.${body}`).digest("hex")}`;
  assert.equal(verifyStripeSignature(body, sig(t), secret), true);
  assert.equal(verifyStripeSignature(body, sig(t, "whsec_wrong"), secret), false);
  assert.equal(verifyStripeSignature(body + " ", sig(t), secret), false);        // body tampered
  assert.equal(verifyStripeSignature(body, sig(t - 301), secret), false);        // outside the 5-min window
  assert.equal(verifyStripeSignature(body, "garbage", secret), false);
  assert.equal(verifyStripeSignature(body, "", secret), false);
});

// ---------- harness ----------------------------------------------------------
async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}
// stub Base RPC: the ledger's price views + a quiet chain for the indexer
function stubRpc() {
  const sel = {
    [SEL("function pricePerSec6() view returns (uint256)")]: W(1667),
    [SEL("function cpuPricePerSec6() view returns (uint256)")]: W(834),
    [SEL("function maxGpuMilli() view returns (uint16)")]: W(1000),
    [SEL("function deploymentsSchema() view returns (uint256)")]: W(3),
  };
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method === "eth_blockNumber") return "0x100";
        if (m.method === "eth_getLogs") return [];
        if (m.method === "eth_chainId") return "0x2105";
        if (m.method === "eth_call") {
          const pre = m.params[0].data.slice(0, 10);
          if (sel[pre]) return "0x" + sel[pre];
          // string views (usdc name/version) -> abi-encoded "USD Coin"/"2"
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
// stub Stripe: records checkout-session creates, returns a hosted url
function stubStripe(calls) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ path: req.url, body: new URLSearchParams(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" }));
    });
  });
}

const WHSEC = "whsec_test_secret";
async function startStack(t, { dataDir }) {
  const rpc = stubRpc(); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  const stripeCalls = [];
  const stripe = stubStripe(stripeCalls); stripe.listen(0, "127.0.0.1"); await once(stripe, "listening");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
    env: { ...process.env,
      ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
      AUTH_DATA_DIR: dataDir,
      BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0",
      DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
      PAYMENT_ROUTER_ADDRESS: "0x" + "34".repeat(20),
      USDC_ADDRESS: "0x" + "56".repeat(20),
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: WHSEC,
      STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`,
      SITE_ORIGIN: "https://enclave.host",
      OFAC_SDN_URLS: "http://127.0.0.1:1/x",
      BILLING_ADMIN_TOKEN: "admintok",
      INDEXER_POLL_SEC: "3600",                               // quiet; the indexer test drives its own
      FEATURED_VIEWS_FILE: path.join(dataDir, "feat.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); stripe.close(); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + "/health"); if (r.ok) return { origin, stripeCalls }; } catch {}
    await delay(100);
  }
  throw new Error("relay never answered /health");
}
const api = async (origin, method, p, { body, token, headers, raw } = {}) => {
  const r = await fetch(origin + p, {
    method,
    headers: { ...(body || raw ? { "content-type": "application/json" } : {}),
               ...(token ? { Authorization: "Bearer " + token } : {}), ...(headers || {}) },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function login(origin) {
  const n = await api(origin, "GET", `/v1/account/siwe/nonce?address=${signer.address}`);
  const signature = await signer.signMessage({ message: n.body.message });
  const l = await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n.body.message, signature } });
  assert.equal(l.status, 200);
  return l.body.token;
}
const SPEC = { appRef: "ipfs://bafytestapp", gpuShare: 0.25, cpuShare: 0.1, appPort: 8080, isPublic: true };
const stripeSig = (payload) => {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${createHmac("sha256", WHSEC).update(`${ts}.${payload}`).digest("hex")}`;
};

// ---------- order lifecycle ---------------------------------------------------
test("billing: quote matches the ledger's ceil formula; spec gates mirror create()", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bill-"));
  const { origin } = await startStack(t, { dataDir: dir });
  const token = await login(origin);

  const o = await api(origin, "POST", "/v1/billing/orders", { token, body: { spec: SPEC, seconds: 3600 } });
  assert.equal(o.status, 201);
  // (1667*250 + 834*100 + 999)/1000 = 501; * 3600s = $1.803600
  assert.equal(o.body.ratePerSec6, "501");
  assert.equal(o.body.amount6, "1803600");
  assert.equal(o.body.state, "awaiting_payment");
  assert.match(o.body.ref, /^0x[0-9a-f]{64}$/);

  // gates that mirror the ledger's own requires
  const bad = async (patch, dur) => (await api(origin, "POST", "/v1/billing/orders",
    { token, body: { spec: { ...SPEC, ...patch }, seconds: dur ?? 3600 } })).status;
  assert.equal(await bad({ gpuShare: 0.05, cpuShare: 0.1 }), 422);   // gpu < cpu
  assert.equal(await bad({ cpuShare: 0 }), 422);
  assert.equal(await bad({ appRef: "" }), 422);
  assert.equal(await bad({}, 60), 422);                              // under ORDER_MIN_SECONDS
  assert.equal((await api(origin, "POST", "/v1/billing/orders", { body: { spec: SPEC, seconds: 3600 } })).status, 401);

  // USDC instructions carry everything the wallet needs
  const u = await api(origin, "GET", `/v1/billing/orders/${o.body.id}/usdc`, { token });
  assert.equal(u.status, 200);
  assert.equal(u.body.router.toLowerCase(), ("0x" + "34".repeat(20)).toLowerCase());
  assert.equal(u.body.amount6, "1803600");
  assert.equal(u.body.orderRef, o.body.ref);
  assert.equal(u.body.usdcDomain.name, "USD Coin");
  assert.deepEqual(u.body.methods, ["payWithPermit", "pay"]);
});

test("billing: Stripe checkout -> signed webhook provisions once; duplicates are no-ops; bad sig rejected", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bill-"));
  const { origin, stripeCalls } = await startStack(t, { dataDir: dir });
  const token = await login(origin);
  const o = await api(origin, "POST", "/v1/billing/orders", { token, body: { spec: SPEC, seconds: 3600 } });

  const co = await api(origin, "POST", `/v1/billing/orders/${o.body.id}/checkout`, { token, body: {} });
  assert.equal(co.status, 200);
  assert.equal(co.body.url, "https://checkout.stripe.test/pay/cs_test_1");
  assert.equal(stripeCalls.length, 1);
  const form = stripeCalls[0].body;
  assert.equal(form.get("client_reference_id"), o.body.id);
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "181");       // ceil(1803600/1e4) cents
  assert.match(form.get("success_url"), /\/checkout\?order=ord_/);

  const evt = JSON.stringify({ id: "evt_1", type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", client_reference_id: o.body.id, payment_status: "paid" } } });

  // bad signature: rejected, order untouched
  const badSig = await api(origin, "POST", "/v1/billing/stripe/webhook",
    { raw: evt, headers: { "stripe-signature": "t=1,v1=deadbeef" } });
  assert.equal(badSig.status, 400);

  // good signature: order settles (provisioner unconfigured -> parks in confirmed_provisioning)
  const ok = await api(origin, "POST", "/v1/billing/stripe/webhook",
    { raw: evt, headers: { "stripe-signature": stripeSig(evt) } });
  assert.equal(ok.status, 200);
  const after = await api(origin, "GET", `/v1/billing/orders/${o.body.id}`, { token });
  assert.equal(after.body.state, "confirmed_provisioning");

  // same event id again: acknowledged, no double-processing
  const dup = await api(origin, "POST", "/v1/billing/stripe/webhook",
    { raw: evt, headers: { "stripe-signature": stripeSig(evt) } });
  assert.equal(dup.body.duplicate, true);
  const still = await api(origin, "GET", `/v1/billing/orders/${o.body.id}`, { token });
  assert.equal(still.body.state, "confirmed_provisioning");

  // checkout on a settled order is refused
  assert.equal((await api(origin, "POST", `/v1/billing/orders/${o.body.id}/checkout`, { token, body: {} })).status, 409);
});

test("billing: orders are account-scoped; review queue needs the admin token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bill-"));
  const { origin } = await startStack(t, { dataDir: dir });
  const token = await login(origin);
  const o = await api(origin, "POST", "/v1/billing/orders", { token, body: { spec: SPEC, seconds: 3600 } });

  const other = privateKeyToAccount("0x" + "07".repeat(32));
  const n = await api(origin, "GET", `/v1/account/siwe/nonce?address=${other.address}`);
  const sig = await other.signMessage({ message: n.body.message });
  const otherTok = (await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n.body.message, signature: sig } })).body.token;
  assert.equal((await api(origin, "GET", `/v1/billing/orders/${o.body.id}`, { token: otherTok })).status, 404);
  assert.equal((await api(origin, "GET", "/v1/billing/orders", { token: otherTok })).body.orders.length, 0);

  assert.equal((await api(origin, "GET", "/v1/billing/review")).status, 401);
  const rq = await api(origin, "GET", "/v1/billing/review", { headers: { "x-admin-token": "admintok" } });
  assert.equal(rq.status, 200);
  assert.deepEqual(rq.body.items, []);
});
