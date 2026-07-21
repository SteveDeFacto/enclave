/* ============================================================
   Checkout - order-based runtime purchase. Two pay buttons,
   side by side, one order:

     Pay by card  -> POST /billing/orders + /checkout, then a
                     full top-level redirect to Stripe's hosted
                     page (zero crypto exposure, zero Stripe
                     bytes on this origin); Stripe returns the
                     browser to /checkout?order=<id>.
     Pay with USDC-> the same order, paid from the connected
                     wallet through the PaymentRouter (pay.js:
                     permit single-tx, allowance pair for smart
                     wallets), then live status via the poller.

   The spec (shares + app) rides in from the deploy console via
   sessionStorage "enclave_checkout_spec"; without one the page
   offers a plain shares-and-hours picker. Gated by
   ACCOUNTS_ENABLED; ships dark until activation.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/order-status/order-status.js";
import { ACCOUNTS_ENABLED, PAYMENT_ROUTER_ADDRESS } from "../core/config.js";
import { Enclave } from "../core/api.js";
import { $, esc, on, showToast } from "../core/util.js";
import { openAuthModal } from "../core/account.js";
import { payOrderWithUsdc } from "../core/pay.js";
import { connectWallet } from "../core/wallet.js";

const DEFAULT_SPEC = { appRef: "", gpuShare: 0.25, cpuShare: 0.1, appPort: 8080, isPublic: true };

function readHandoff(){
  // the deploy console parks its configured spec here before navigating over
  try {
    const raw = sessionStorage.getItem("enclave_checkout_spec");
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s && s.appRef) ? s : null;
  } catch(e){ return null; }
}

export function boot(){
  const body = $("#coBody"); if (!body) return;
  const gate = $("#coGate");
  if (!ACCOUNTS_ENABLED){
    if (gate){ gate.hidden = false; gate.textContent = "Checkout isn't available yet. Deploy and pay from your wallet on the Apps page instead."; }
    return;
  }

  const params = new URLSearchParams(location.search);
  const orderId = params.get("order");
  if (orderId) return mountStatus(body, orderId, params.get("cancelled") === "1");

  if (!Enclave.accountAuthed()){
    body.innerHTML = '<div class="co-note">' +
      '<p>Sign in to buy runtime. A passkey takes one tap; a wallet works too.</p>' +
      '<button class="btn" id="coSignin" type="button">Sign in to continue</button></div>';
    const b = $("#coSignin");
    if (b) b.addEventListener("click", async () => { try { await openAuthModal(); } catch(e){} });
    on("enclave:account", (d) => { if (d.authed) boot(); });
    return;
  }
  renderForm(body);
}

function renderForm(body){
  const spec = readHandoff() || DEFAULT_SPEC;
  const fromConsole = !!spec.appRef;
  body.innerHTML =
    '<div class="co-form">' +
    (fromConsole
      ? '<div class="co-spec"><span>Deploying</span><code>' + esc(spec.appRef) + '</code>' +
        '<span>Shares</span><b>' + (spec.gpuShare * 100).toFixed(0) + '% GPU · ' + (spec.cpuShare * 100).toFixed(0) + '% CPU</b></div>'
      : '<div class="co-field"><label for="coApp">App reference</label>' +
        '<input class="wp-input" id="coApp" placeholder="catalog://… or ipfs://…" spellcheck="false" />' +
        '<div class="wp-hint">From the Apps page: every app card shows its reference. The deploy console fills this in for you.</div>' +
        '<div class="co-shares"><label>GPU share <input class="wp-input" id="coGpu" inputmode="decimal" value="' + (spec.gpuShare * 100).toFixed(0) + '" /> %</label>' +
        '<label>CPU share <input class="wp-input" id="coCpu" inputmode="decimal" value="' + (spec.cpuShare * 100).toFixed(0) + '" /> %</label></div>') +
    '<div class="co-field"><label for="coHours">Runtime</label>' +
    '<div class="co-shares"><input class="wp-input" id="coHours" inputmode="decimal" value="24" /> <span>hours</span></div></div>' +
    '<div class="co-quote" id="coQuote" role="status"></div>' +
    '<div class="co-err" id="coErr" role="alert" hidden></div>' +
    '<div class="co-pay">' +
      '<button class="btn" id="coCard" type="button">Pay by card</button>' +
      '<button class="btn" id="coUsdc" type="button"' + (PAYMENT_ROUTER_ADDRESS ? "" : " hidden") + '>Pay with USDC</button>' +
    '</div>' +
    '<p class="co-note">Card checkout happens on a Stripe-hosted page; your card details never touch Enclave. USDC goes from your wallet straight to the treasury on Base. Payments are final; runtime starts as soon as the payment settles.</p>' +
    '</div><div id="coStatus"></div>';

  const err = (m) => { const el = $("#coErr"); if (el){ el.hidden = !m; el.textContent = m || ""; } };
  const currentSpec = () => {
    if (fromConsole) return spec;
    return {
      appRef: ($("#coApp")?.value || "").trim(),
      gpuShare: (parseFloat($("#coGpu")?.value) || 0) / 100,
      cpuShare: (parseFloat($("#coCpu")?.value) || 0) / 100,
      appPort: spec.appPort, isPublic: spec.isPublic,
    };
  };
  const hours = () => parseFloat($("#coHours")?.value) || 0;

  async function makeOrder(){
    err("");
    const s = currentSpec();
    if (!s.appRef) { err("Enter the app reference to deploy (the Apps page shows it on every app)."); return null; }
    if (!(hours() > 0)) { err("Enter how many hours of runtime to buy."); return null; }
    try {
      const order = await Enclave.createOrder({ spec: s, seconds: Math.round(hours() * 3600) });
      try { sessionStorage.removeItem("enclave_checkout_spec"); } catch(e){}
      return order;
    } catch(e){ err(e.message || String(e)); return null; }
  }

  const card = $("#coCard");
  if (card) card.addEventListener("click", async () => {
    card.disabled = true;
    const order = await makeOrder();
    if (!order){ card.disabled = false; return; }
    try {
      const { url } = await Enclave.orderCheckout(order.id);
      location.assign(url);   // full top-level redirect to Stripe's hosted checkout
    } catch(e){ err(e.message || String(e)); card.disabled = false; }
  });

  const usdc = $("#coUsdc");
  if (usdc) usdc.addEventListener("click", async () => {
    usdc.disabled = true;
    const order = await makeOrder();
    if (!order){ usdc.disabled = false; return; }
    try {
      if (!Enclave.provider) await connectWallet();
      const pay = await Enclave.orderUsdc(order.id);
      // park the status card first: the payment narrates into the quote line,
      // and the poller takes over the moment the tx is sent
      history.replaceState(null, "", "checkout?order=" + order.id);
      mountStatus($("#coStatus").parentElement ? body : body, order.id, false, { keepForm: false });
      await payOrderWithUsdc(pay, (cls, msg) => showToast(msg));
    } catch(e){
      showToast(e.message || String(e));
      // the order exists and can still be paid - keep showing its status
    }
  });

  // live price preview: quote the order the way the relay will (per-second
  // ledger rate), reusing the public pricing surface
  const paintQuote = async () => {
    const q = $("#coQuote"); if (!q) return;
    const s = currentSpec(), h = hours();
    if (!(h > 0)) { q.textContent = ""; return; }
    try {
      const { rate6Of, depPrices6 } = await import("../core/chain.js");
      const pr = await depPrices6();
      const rate = Number(rate6Of(pr, Math.round(s.gpuShare * 1000), Math.round(s.cpuShare * 1000))) / 1e6;
      q.textContent = "$" + (rate * 3600 * h).toFixed(2) + " for " + h + "h (at $" + (rate * 3600).toFixed(2) + "/hour)";
    } catch(e){ q.textContent = ""; }
  };
  ["coGpu", "coCpu", "coHours", "coApp"].forEach((id) => { const el = $("#" + id); if (el) el.addEventListener("input", paintQuote); });
  paintQuote();
}

function mountStatus(body, orderId, cancelled, opts){
  body.innerHTML =
    (cancelled ? '<p class="co-note">Card checkout was cancelled. The order is still payable below, or start over.</p>' : "") +
    '<c-order-status order-id="' + esc(orderId) + '"></c-order-status>' +
    '<p class="co-note"><a href="checkout">← Start a new order</a></p>';
}
