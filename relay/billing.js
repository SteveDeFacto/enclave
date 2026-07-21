// Order service + hybrid billing: USD-quoted orders paid EITHER by card
// (hosted Stripe Checkout - the customer never touches crypto) OR by USDC on
// Base from the customer's own wallet through the immutable PaymentRouter
// (payer -> treasury in one tx; the indexer matches PaymentReceived logs to
// orders by orderRef). Either way, provisioning is the company's provisioner
// wallet performing create()+fund() on EnclaveDeployments - the on-chain
// ledger stays the source of truth and the enclaves never learn any of this.
//
// HARD INVARIANTS (custody/legal - do not relax):
//   - money flows IN only: nothing here ever sends crypto to a customer
//   - no customer-attributable balances: usdc.total6 on an order is an AUDIT
//     record of what arrived, never a spendable credit; overpayment funds the
//     order's quoted runtime and not a cent more
//   - refunds are a manual, finance-approved ops process (see
//     docs/billing-runbook.md); nothing self-serve exists here
//   - every USDC payer is OFAC-screened before provisioning; hits and stale
//     screening data go to the manual review queue, never auto-provision
//
// Order states (setOrderState is the only writer; history records every hop):
//   awaiting_payment       created; Stripe session or USDC instructions live
//   pending_confirmations  display-only: unconfirmed router log seen
//   confirmed_provisioning payment settled + screened; provisioner working
//   complete               deployment created + funded on-chain
//   under_review           needs a human: underpaid beyond dust, OFAC hit,
//                          stale screening, paid after expiry
//   expired                order TTL passed with no payment (terminal)
//   rejected               reviewer refused it (terminal; refunds are manual)
//
// Stripe is called with plain fetch (two REST calls) - no SDK; the webhook
// signature is an HMAC we verify on the RAW body. Idempotent by event id.

import { JsonStore, dataDir, dataFile, makeRateLimiter, rid, rpcPool } from "./store.js";
import { verifyAccountSession, accountsEnabled } from "./auth.js";
import { initOfac, screenAddress } from "./ofac.js";
import { startIndexer } from "./indexer.js";
import { initProvisioner, enqueueProvision, recoverProvisioning } from "./provisioner.js";
import { publisherFee6 } from "./mcp.js";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
const SITE_ORIGIN = (process.env.SITE_ORIGIN || "https://enclave.host").replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.BILLING_ADMIN_TOKEN || "").trim();
const ALERT_URL = (process.env.ALERT_WEBHOOK_URL || "").trim();

const ORDER_TTL_SEC = parseInt(process.env.ORDER_TTL_SEC || "86400", 10);
const ORDER_SWEEP_SEC = parseInt(process.env.ORDER_SWEEP_SEC || "60", 10);   // expiry sweep cadence (tests shorten it)
const MIN_SECONDS = parseInt(process.env.ORDER_MIN_SECONDS || "3600", 10);
const MAX_SECONDS = parseInt(process.env.ORDER_MAX_SECONDS || "7776000", 10);   // 90 days
// tolerance policy (see docs/billing-runbook.md): dust underpayment provisions,
// larger underpayment reviews (and auto-heals if later payments top it up);
// ANY overpayment provisions - the excess is income, recorded for audit and
// refundable only through the manual runbook - but a LARGE overpayment also
// opens a review item so a human sees it.
const UNDERPAY_DUST_6 = BigInt(process.env.ORDER_UNDERPAY_DUST_6 || "50000");        // $0.05
const UNDERPAY_DUST_BP = BigInt(process.env.ORDER_UNDERPAY_DUST_BP || "50");         // 0.5%
const OVERPAY_FLAG_6 = BigInt(process.env.ORDER_OVERPAY_FLAG_6 || "10000000");       // $10
const OVERPAY_FLAG_BP = BigInt(process.env.ORDER_OVERPAY_FLAG_BP || "1000");         // 10%

const USDC_DEFAULT = { base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                       "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
const NETWORK = (process.env.BILLING_NETWORK || "base").trim();
const USDC = (process.env.USDC_ADDRESS || USDC_DEFAULT[NETWORK] || USDC_DEFAULT.base).trim();
const CHAIN_ID = NETWORK === "base-sepolia" ? 84532 : 8453;
const BOOK = (process.env.ADDRESS_BOOK_ADDRESS || "").trim();
// "paymentRouter" ascii right-padded to bytes32 (the book's key convention)
const BOOK_KEY_ROUTER = "0x" + Buffer.from("paymentRouter").toString("hex").padEnd(64, "0");

let enabled = false;
let orders = null;        // JsonStore { orders, byRef }
let stripeEvents = null;  // JsonStore { events }
let reviews = null;       // JsonStore { items }
let routerAddress = (process.env.PAYMENT_ROUTER_ADDRESS || "").trim();
let ctxRef = null;
const rlOrders = makeRateLimiter({ capacity: 10, refillPerSec: 10 / 3600 });

// --- init -----------------------------------------------------------------------
export async function initBilling(ctx) {
  ctxRef = ctx;
  const dir = dataDir();
  if (!dir) { console.log("[billing] no data dir - billing disabled"); return { enabled: false }; }
  if (!accountsEnabled()) { console.log("[billing] accounts disabled - billing disabled (orders need account sessions)"); return { enabled: false }; }

  orders = new JsonStore(dataFile(dir, "orders.json"), { orders: {}, byRef: {} }, { durable: true });
  stripeEvents = new JsonStore(dataFile(dir, "stripe-events.json"), { events: {} }, { durable: true });
  reviews = new JsonStore(dataFile(dir, "review-queue.json"), { items: {} }, { durable: true });
  enabled = true;

  initOfac(dir);
  await resolveRouter();
  setInterval(resolveRouter, 300_000).unref?.();

  startIndexer({
    dir,
    getRouter: () => routerAddress,
    onPayment: handleConfirmedPayment,
    onPending: handlePendingPayment,
  });

  await initProvisioner({
    dir,
    orders,
    usdc: USDC,
    getDeploymentsAddress: ctx.deploymentsAddress,
    setOrderState,
    alert,
  });
  recoverProvisioning();

  setInterval(expirySweep, ORDER_SWEEP_SEC * 1000).unref?.();
  // prune settled stripe events after 30 days (idempotency only needs recency)
  setInterval(() => {
    const cutoff = Date.now() - 30 * 86400_000;
    for (const [id, e] of Object.entries(stripeEvents.data.events))
      if (Date.parse(e.at) < cutoff) { delete stripeEvents.data.events[id]; stripeEvents.saveSoon(); }
  }, 3600_000).unref?.();

  console.log(`[billing] enabled - network ${NETWORK}, usdc ${USDC}, router ${routerAddress || "(unset: USDC checkout dark)"}, stripe ${STRIPE_KEY ? "configured" : "OFF"}`);
  return { enabled: true };
}

async function resolveRouter() {
  if (!BOOK) return;
  try {
    const pub = await rpcPool();
    const a = await pub.readContract({ address: BOOK,
      abi: [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }],
      functionName: "addr", args: [BOOK_KEY_ROUTER] });
    if (a && !/^0x0{40}$/i.test(a) && a.toLowerCase() !== routerAddress.toLowerCase()) {
      console.log(`[billing] address book: paymentRouter ${routerAddress || "(unset)"} -> ${a}`);
      routerAddress = a;
    }
  } catch { /* keep current; next poll retries */ }
}

function alert(kind, detail) {
  console.error(`[billing] ALERT ${kind}: ${JSON.stringify(detail)}`);
  if (ALERT_URL) fetch(ALERT_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, ...detail, at: new Date().toISOString() }) }).catch(() => {});
}

// --- order state machine --------------------------------------------------------
const TERMINAL = new Set(["complete", "expired", "rejected"]);
export function setOrderState(order, to, via, note) {
  if (order.state === to) return;
  // terminal states never move, with ONE exception: a payment landing on an
  // already-expired order pulls it to under_review (a human decides whether
  // to provision anyway or refund through the manual runbook)
  if (TERMINAL.has(order.state) && !(order.state === "expired" && to === "under_review")) return;
  order.history.push({ at: new Date().toISOString(), from: order.state, to, via, ...(note ? { note } : {}) });
  order.state = to;
  orders.saveSoon();
}

function openReview(order, reason, detail) {
  const id = rid("rev_");
  reviews.data.items[id] = { id, orderId: order.id, reason, detail: detail || "",
    openedAt: new Date().toISOString(), resolvedAt: null, resolution: null };
  reviews.saveSoon();
  if (!order.review) order.review = { itemId: id };
  if (!order.flags.includes(reason)) order.flags.push(reason);
  orders.saveSoon();
  alert("review_opened", { orderId: order.id, reason, detail });
  return id;
}

// Tolerance policy on the CONFIRMED total. Pure - unit tested directly.
// -> { action: "provision" | "review", reason?, flags: [] }
export function evaluatePayment(amount6, total6) {
  amount6 = BigInt(amount6); total6 = BigInt(total6);
  const flags = [];
  if (total6 <= 0n) return { action: "review", reason: "no_payment", flags };
  const dust = (a) => { const pct = (a * UNDERPAY_DUST_BP) / 10000n; return pct > UNDERPAY_DUST_6 ? pct : UNDERPAY_DUST_6; };
  const overflag = (a) => { const pct = (a * OVERPAY_FLAG_BP) / 10000n; return pct > OVERPAY_FLAG_6 ? pct : OVERPAY_FLAG_6; };
  if (amount6 - total6 > dust(amount6)) return { action: "review", reason: "underpayment", flags };
  if (total6 - amount6 > overflag(amount6)) flags.push("large_overpayment");
  return { action: "provision", flags };
}

// --- payment handlers (indexer callbacks) ---------------------------------------
async function handleConfirmedPayment({ orderRef, payer, amount, txHash, logIndex, block }) {
  const ref = String(orderRef).toLowerCase();
  const orderId = orders.data.byRef[ref];
  if (!orderId) {
    // funds are already at the treasury (the contract is dumb by design);
    // the review queue is the only ledger of unattributed payments
    const id = rid("rev_");
    reviews.data.items[id] = { id, orderId: null, reason: "unmatched_payment",
      detail: `ref ${ref} payer ${payer} amount ${amount} tx ${txHash}`,
      openedAt: new Date().toISOString(), resolvedAt: null, resolution: null };
    reviews.saveSoon();
    alert("unmatched_payment", { ref, payer: String(payer), amount: String(amount), txHash });
    return;
  }
  const order = orders.data.orders[orderId];
  // restart-safe: the indexer's in-memory dedup dies with the process, the
  // order's payment list does not
  if (order.usdc.payments.some((pp) => pp.txHash === txHash && pp.logIndex === logIndex)) return;
  order.usdc.payments.push({ txHash, logIndex, payer: String(payer).toLowerCase(),
    amount6: String(amount), block, at: new Date().toISOString() });
  order.usdc.total6 = String(order.usdc.payments.reduce((s, pp) => s + BigInt(pp.amount6), 0n));
  orders.saveSoon();

  if (order.state === "complete" || order.state === "rejected") {
    // money arrived with nowhere to go - record it for the reviewer/refund
    // runbook, never touch the state
    openReview(order, "payment_after_settlement", `payment ${txHash} (${amount}) arrived on a ${order.state} order`);
    return;
  }

  // OFAC screen BEFORE any provisioning decision - fail closed to review
  const screen = screenAddress(payer);
  order.screening[String(payer).toLowerCase()] = { result: screen.result, at: new Date().toISOString() };
  orders.saveSoon();
  if (screen.result === "hit") { setOrderState(order, "under_review", "indexer", "ofac_hit"); openReview(order, "ofac_hit", `payer ${payer} matched the SDN list (tx ${txHash})`); return; }
  if (screen.result === "stale") { setOrderState(order, "under_review", "indexer", "screening_stale"); openReview(order, "screening_stale", `SDN data unavailable/stale while screening ${payer}`); return; }

  if (order.state === "expired" || Date.parse(order.expiresAt) < Date.now() - 300_000) {
    // paid after expiry: a human decides (provision anyway vs manual refund)
    setOrderState(order, "under_review", "indexer", "payment_after_expiry");
    openReview(order, "payment_after_expiry", `payment ${txHash} arrived after the order expired`);
    return;
  }

  const verdict = evaluatePayment(order.quote.amount6, order.usdc.total6);
  for (const f of verdict.flags) if (!order.flags.includes(f)) order.flags.push(f);
  // reasons only a human may clear: a clean later payment must NOT auto-
  // provision past them (underpayment is the one auto-healing reason)
  const HUMAN_ONLY = ["ofac_hit", "screening_stale", "payment_after_expiry", "partial_payment_expired"];
  if (verdict.action === "provision") {
    if (order.state === "under_review" && order.flags.some((f) => HUMAN_ONLY.includes(f))) return;
    if (verdict.flags.includes("large_overpayment"))
      openReview(order, "large_overpayment", `paid ${order.usdc.total6} vs quoted ${order.quote.amount6} (order still provisions; excess is income, manual refund possible)`);
    setOrderState(order, "confirmed_provisioning", "indexer",
      order.flags.includes("underpayment") ? "underpayment_healed" : undefined);
    enqueueProvision(order.id);
  } else if (order.state !== "under_review") {
    setOrderState(order, "under_review", "indexer", verdict.reason);
    openReview(order, verdict.reason, `paid ${order.usdc.total6} of ${order.quote.amount6} (later payments auto-heal within tolerance)`);
  }
}

async function handlePendingPayment({ orderRef }) {
  const orderId = orders.data.byRef[String(orderRef).toLowerCase()];
  const order = orderId && orders.data.orders[orderId];
  if (order && order.state === "awaiting_payment")
    setOrderState(order, "pending_confirmations", "indexer");   // display-only
}

function expirySweep() {
  const now = Date.now();
  for (const order of Object.values(orders.data.orders)) {
    if (!["awaiting_payment", "pending_confirmations"].includes(order.state)) continue;
    if (Date.parse(order.expiresAt) > now) continue;
    if (order.usdc.payments.length || order.stripe?.lastEventId) {
      setOrderState(order, "under_review", "expiry", "partial_payment_expired");
      openReview(order, "partial_payment_expired", `order expired holding partial/unsettled payment`);
    } else {
      setOrderState(order, "expired", "expiry");
    }
  }
}

// --- quoting --------------------------------------------------------------------
let _rates = { at: 0, pricePerSec6: 0n, cpuPricePerSec6: 0n, maxGpuMilli: 1000 };
async function ledgerRates() {
  if (Date.now() - _rates.at < 600_000) return _rates;
  const dep = ctxRef.deploymentsAddress();
  if (!dep) throw new Error("deployments ledger address unknown");
  const pub = await rpcPool();
  const U = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
  const [p, c, m] = await Promise.all([
    pub.readContract({ address: dep, abi: U("pricePerSec6"), functionName: "pricePerSec6" }),
    pub.readContract({ address: dep, abi: U("cpuPricePerSec6"), functionName: "cpuPricePerSec6" }),
    pub.readContract({ address: dep,
      abi: [{ type: "function", name: "maxGpuMilli", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }],
      functionName: "maxGpuMilli" }).then(Number).catch(() => 1000),
  ]);
  _rates = { at: Date.now(), pricePerSec6: p, cpuPricePerSec6: c, maxGpuMilli: m };
  return _rates;
}
// the ledger's own ceil formula (EnclaveDeployments._initScalars) - the quote
// IS what the deployment will burn per second
const rate6For = (r, gpuMilli, cpuMilli) =>
  (r.pricePerSec6 * BigInt(gpuMilli) + r.cpuPricePerSec6 * BigInt(cpuMilli) + 999n) / 1000n;

// --- Stripe ---------------------------------------------------------------------
function stripeForm(params, out = {}, prefix = "") {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object") stripeForm(v, out, key);
    else out[key] = String(v);
  }
  return out;
}
async function stripeApi(path, params, idemKey) {
  const r = await fetch(STRIPE_API + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
    },
    body: new URLSearchParams(stripeForm(params)).toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `Stripe ${path} failed (${r.status})`);
  return body;
}
// Stripe-Signature: t=<unix>,v1=<hmac>. HMAC-SHA256(secret, `${t}.${rawBody}`),
// constant-time compare, 5-minute tolerance. Exported for tests.
export function verifyStripeSignature(rawBody, header, secret, nowMs = Date.now()) {
  const parts = Object.fromEntries(String(header || "").split(",").map((s) => s.split("=", 2)));
  const t = parseInt(parts.t, 10);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const given = String(parts.v1 || "");
  if (given.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex")); } catch { return false; }
}

// --- order views ----------------------------------------------------------------
function orderView(order) {
  return {
    id: order.id, ref: order.ref, state: order.state, flags: order.flags,
    createdAt: order.createdAt, expiresAt: order.expiresAt,
    spec: order.spec, seconds: order.seconds,
    amountUsd: (Number(order.quote.amount6) / 1e6).toFixed(2),
    amount6: order.quote.amount6,
    ratePerSec6: order.quote.rate6,
    usdc: { total6: order.usdc.total6, payments: order.usdc.payments.length },
    ...(order.stripe?.sessionId ? { stripe: { sessionId: order.stripe.sessionId } } : {}),
    ...(order.provision?.deploymentId ? { deploymentId: order.provision.deploymentId } : {}),
  };
}

// --- dispatch -------------------------------------------------------------------
const err = (ctx, res, req, code, error, message) => ctx.json(res, code, { error, message }, req);

export async function handleBilling(req, res, u, ctx) {
  if (!enabled) return err(ctx, res, req, 503, "billing_disabled", "Billing is not configured on this relay.");
  const p = u.pathname;

  // -- Stripe webhook (no session auth; authenticated by signature) --------------
  if (p === "/v1/billing/stripe/webhook" && req.method === "POST") {
    if (!STRIPE_WEBHOOK_SECRET) return err(ctx, res, req, 503, "stripe_disabled", "Stripe webhooks are not configured.");
    let raw; try { raw = await ctx.readBody(req, 1_048_576); } catch (e) { return err(ctx, res, req, 413, "too_large", e.message); }
    if (!verifyStripeSignature(raw.toString("utf8"), req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET))
      return err(ctx, res, req, 400, "bad_signature", "Stripe signature verification failed.");
    let evt; try { evt = JSON.parse(raw.toString("utf8")); } catch { return err(ctx, res, req, 400, "bad_json", "Body must be JSON."); }
    if (stripeEvents.data.events[evt.id])
      return ctx.json(res, 200, { received: true, duplicate: true }, req);
    stripeEvents.data.events[evt.id] = { at: new Date().toISOString() };
    stripeEvents.saveSoon();

    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(evt.type)) {
      const sess = evt.data?.object || {};
      const orderId = sess.client_reference_id || sess.metadata?.order_id;
      const order = orderId && orders.data.orders[orderId];
      if (order && sess.payment_status === "paid" && !TERMINAL.has(order.state)) {
        order.stripe = { ...(order.stripe || {}), sessionId: sess.id,
          paymentIntentId: sess.payment_intent || null, lastEventId: evt.id };
        stripeEvents.data.events[evt.id].orderId = order.id;
        stripeEvents.saveSoon();
        setOrderState(order, "confirmed_provisioning", "stripe_webhook");
        enqueueProvision(order.id);
      } else if (!order) {
        alert("stripe_unmatched_event", { eventId: evt.id, sessionId: sess.id });
      }
    } else if (evt.type === "checkout.session.async_payment_failed") {
      const sess = evt.data?.object || {};
      const orderId = sess.client_reference_id || sess.metadata?.order_id;
      const order = orderId && orders.data.orders[orderId];
      if (order && order.state === "awaiting_payment")
        setOrderState(order, "awaiting_payment", "stripe_webhook", "async_payment_failed");
    }
    return ctx.json(res, 200, { received: true }, req);   // always 200 fast; work is async
  }

  // -- review queue (operator; x-admin-token) ------------------------------------
  if (p === "/v1/billing/review" && req.method === "GET") {
    if (!ADMIN_TOKEN) return err(ctx, res, req, 503, "review_disabled", "BILLING_ADMIN_TOKEN is not set.");
    if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return err(ctx, res, req, 401, "unauthorized", "Bad admin token.");
    const all = u.searchParams.get("all") === "1";
    const items = Object.values(reviews.data.items).filter((i) => all || !i.resolvedAt);
    return ctx.json(res, 200, { items }, req);
  }
  const rev = p.match(/^\/v1\/billing\/review\/(rev_[a-z0-9]+)\/resolve$/);
  if (rev && req.method === "POST") {
    if (!ADMIN_TOKEN) return err(ctx, res, req, 503, "review_disabled", "BILLING_ADMIN_TOKEN is not set.");
    if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return err(ctx, res, req, 401, "unauthorized", "Bad admin token.");
    const item = reviews.data.items[rev[1]];
    if (!item) return err(ctx, res, req, 404, "not_found", "No such review item.");
    if (item.resolvedAt) return err(ctx, res, req, 409, "already_resolved", "This item is already resolved.");
    let b; try { b = JSON.parse((await ctx.readBody(req, 65536)).toString() || "{}"); } catch { return err(ctx, res, req, 400, "bad_json", "Body must be JSON."); }
    const action = String(b.action || "");
    if (!["approve", "reject"].includes(action)) return err(ctx, res, req, 422, "bad_action", 'action must be "approve" or "reject".');
    item.resolvedAt = new Date().toISOString();
    item.resolution = { action, note: String(b.note || "").slice(0, 500) };
    reviews.saveSoon();
    const order = item.orderId && orders.data.orders[item.orderId];
    if (order && order.state === "under_review") {
      if (action === "approve") { setOrderState(order, "confirmed_provisioning", "reviewer", item.reason); enqueueProvision(order.id); }
      else setOrderState(order, "rejected", "reviewer", item.reason);
    }
    return ctx.json(res, 200, { ok: true, item }, req);
  }

  // -- everything below needs an account session ---------------------------------
  const sess = await verifyAccountSession(req.headers.authorization);
  if (!sess) return err(ctx, res, req, 401, "unauthorized", "Sign in first.");

  if (p === "/v1/billing/orders" && req.method === "POST") {
    if (!rlOrders(sess.accountId)) return err(ctx, res, req, 429, "rate_limited", "Too many orders; retry later.");
    let b; try { b = JSON.parse((await ctx.readBody(req, 65536)).toString() || "{}"); } catch { return err(ctx, res, req, 400, "bad_json", "Body must be JSON."); }
    const spec = b.spec || {};
    const seconds = Math.round(Number(b.seconds ?? Number(b.hours) * 3600));
    const gpuMilli = Math.round(Number(spec.gpuShare != null ? Number(spec.gpuShare) * 1000 : spec.gpuMilli) || 0);
    const cpuMilli = Math.round(Number(spec.cpuShare != null ? Number(spec.cpuShare) * 1000 : spec.cpuMilli) || 0);
    const appRef = String(spec.appRef || "");
    const appPort = Math.round(Number(spec.appPort)) || 8080;
    const ports = String(spec.ports || "");
    const configCid = String(spec.configCid || "");
    // mirror the ledger's own create() gates so a paid order can never be
    // unconvertible (EnclaveDeployments.sol create requires)
    let rates;
    try { rates = await ledgerRates(); } catch (e) { return err(ctx, res, req, 503, "quote_unavailable", `Cannot quote right now: ${e.message}`); }
    if (!appRef || appRef.length > 100) return err(ctx, res, req, 422, "bad_app_ref", "spec.appRef is required (catalog://... or ipfs://...), max 100 chars.");
    if (!(cpuMilli >= 1 && cpuMilli <= 1000)) return err(ctx, res, req, 422, "bad_cpu", "cpuShare must be within (0, 1].");
    if (!(gpuMilli >= 0 && gpuMilli <= rates.maxGpuMilli)) return err(ctx, res, req, 422, "bad_gpu", `gpuShare must be within [0, ${rates.maxGpuMilli / 1000}].`);
    if (gpuMilli > 0 && gpuMilli < cpuMilli) return err(ctx, res, req, 422, "bad_shares", "gpuShare must be at least cpuShare (ledger rule).");
    if (!(appPort > 0 && appPort < 65536)) return err(ctx, res, req, 422, "bad_port", "appPort must be a valid port.");
    if (ports.length > 96 || configCid.length > 100) return err(ctx, res, req, 422, "bad_spec", "ports/configCid exceed the ledger's limits.");
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS)
      return err(ctx, res, req, 422, "bad_duration", `seconds must be within [${MIN_SECONDS}, ${MAX_SECONDS}].`);
    // publisher-fee gate: the provisioner's company wallet never forwards a
    // fee cut to a third-party publisher (business/legal decision pending)
    let fee6 = 0n;
    try { fee6 = await publisherFee6(appRef); } catch { /* catalog unreadable: fee unknown */ }
    if (fee6 > 0n)
      return err(ctx, res, req, 422, "publisher_fee_unsupported",
        "This app charges a publisher fee, which order-based checkout does not support yet. Deploy it directly from your wallet instead.");

    const rate6 = rate6For(rates, gpuMilli, cpuMilli);
    const amount6 = rate6 * BigInt(seconds);
    const now = new Date();
    const order = {
      id: rid("ord_"), ref: "0x" + randomBytes(32).toString("hex"),
      accountId: sess.accountId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ORDER_TTL_SEC * 1000).toISOString(),
      state: "awaiting_payment", flags: [],
      spec: { appRef, gpuMilli, cpuMilli, appPort, ports, isPublic: spec.isPublic !== false, configCid },
      seconds,
      quote: { rate6: rate6.toString(), amount6: amount6.toString(), quotedAt: now.toISOString() },
      stripe: null,
      usdc: { payments: [], total6: "0" },
      screening: {},
      provision: null,
      review: null,
      history: [],
    };
    orders.data.orders[order.id] = order;
    orders.data.byRef[order.ref.toLowerCase()] = order.id;
    orders.saveSoon();
    return ctx.json(res, 201, orderView(order), req);
  }

  if (p === "/v1/billing/orders" && req.method === "GET") {
    const mine = Object.values(orders.data.orders)
      .filter((o) => o.accountId === sess.accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
    return ctx.json(res, 200, { orders: mine.map(orderView) }, req);
  }

  const one = p.match(/^\/v1\/billing\/orders\/(ord_[a-z0-9]+)$/);
  if (one && req.method === "GET") {
    const order = orders.data.orders[one[1]];
    if (!order || order.accountId !== sess.accountId) return err(ctx, res, req, 404, "not_found", "No such order.");
    return ctx.json(res, 200, orderView(order), req);
  }

  const co = p.match(/^\/v1\/billing\/orders\/(ord_[a-z0-9]+)\/checkout$/);
  if (co && req.method === "POST") {
    if (!STRIPE_KEY) return err(ctx, res, req, 503, "stripe_disabled", "Card checkout is not configured; pay with USDC instead.");
    const order = orders.data.orders[co[1]];
    if (!order || order.accountId !== sess.accountId) return err(ctx, res, req, 404, "not_found", "No such order.");
    if (order.state !== "awaiting_payment") return err(ctx, res, req, 409, "not_payable", `Order is ${order.state}.`);
    const cents = Math.ceil(Number(order.quote.amount6) / 10000);
    if (cents < 50) return err(ctx, res, req, 422, "below_card_minimum", "Card payments need a total of at least $0.50; pay with USDC instead.");
    const hours = Math.round(order.seconds / 360) / 10;
    let sessData;
    try {
      sessData = await stripeApi("/v1/checkout/sessions", {
        mode: "payment",
        client_reference_id: order.id,
        "metadata[order_id]": order.id,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": cents,
        "line_items[0][price_data][product_data][name]": `Enclave runtime - ${hours}h`,
        success_url: `${SITE_ORIGIN}/checkout?order=${order.id}`,
        cancel_url: `${SITE_ORIGIN}/checkout?order=${order.id}&cancelled=1`,
        expires_at: Math.min(Math.floor(Date.parse(order.expiresAt) / 1000), Math.floor(Date.now() / 1000) + 86400),
      }, order.id);
    } catch (e) { return err(ctx, res, req, 502, "stripe_error", e.message); }
    order.stripe = { ...(order.stripe || {}), sessionId: sessData.id };
    orders.saveSoon();
    return ctx.json(res, 200, { url: sessData.url, sessionId: sessData.id }, req);
  }

  const usdc = p.match(/^\/v1\/billing\/orders\/(ord_[a-z0-9]+)\/usdc$/);
  if (usdc && req.method === "GET") {
    const order = orders.data.orders[usdc[1]];
    if (!order || order.accountId !== sess.accountId) return err(ctx, res, req, 404, "not_found", "No such order.");
    if (!routerAddress) return err(ctx, res, req, 503, "usdc_disabled", "USDC checkout is not live yet (no PaymentRouter deployed).");
    return ctx.json(res, 200, {
      chainId: CHAIN_ID, usdc: USDC, router: routerAddress,
      amount6: order.quote.amount6, orderRef: order.ref, expiresAt: order.expiresAt,
      usdcDomain: await usdcDomain(),
      methods: ["payWithPermit", "pay"],
      note: "Any wallet may pay; the orderRef attributes the payment to this order. Funds go straight to the treasury; the router holds nothing.",
    }, req);
  }

  if (p === "/v1/billing/deployments" && req.method === "GET") {
    // account-scoped visibility: join the account's provisioned orders onto
    // the public on-chain ledger rows (zero new chain code - ctx.ledgerRows
    // is the relay's existing cached reader)
    const mine = Object.values(orders.data.orders)
      .filter((o) => o.accountId === sess.accountId && o.provision?.deploymentId);
    let rows = [];
    try { rows = await ctxRef.ledgerRows(); }
    catch (e) { console.error("[billing] ledger read failed for the deployments join:", (e && (e.shortMessage || e.message)) || e); }
    const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
    return ctx.json(res, 200, { deployments: mine.map((o) => {
      const row = byId.get(String(o.provision.deploymentId).toLowerCase());
      return { orderId: o.id, deploymentId: o.provision.deploymentId,
               ...(row ? ctxRef.ledgerView(row) : { status: "unknown" }) };
    }) }, req);
  }

  return err(ctx, res, req, 404, "not_found", "No such billing endpoint.");
}

// the EIP-712 domain the permit signs over - read from the token once (name/
// version views), defaulting to Base USDC's well-known values
let _domain = null;
async function usdcDomain() {
  if (_domain) return _domain;
  try {
    const pub = await rpcPool();
    const S = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }];
    const [name, version] = await Promise.all([
      pub.readContract({ address: USDC, abi: S("name"), functionName: "name" }),
      pub.readContract({ address: USDC, abi: S("version"), functionName: "version" }).catch(() => "2"),
    ]);
    _domain = { name, version, chainId: CHAIN_ID, verifyingContract: USDC };
  } catch {
    return { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
  }
  return _domain;
}
