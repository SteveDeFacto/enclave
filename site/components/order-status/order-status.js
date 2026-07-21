/* ============================================================
   <c-order-status> - live status card for one billing order.
   Polls GET /v1/billing/orders/:id every 3s while mounted and
   narrates the relay's state machine in plain words. Terminal
   states stop the poll and dispatch `settled` {status}.

   States (the relay's contract, relay/billing.js):
     awaiting_payment / pending_confirmations -> waiting
     confirmed_provisioning -> setting up on-chain
     complete | under_review | expired | rejected -> terminal
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { Enclave } from "../../js/core/api.js";
import { esc } from "../../js/core/util.js";

const COPY = {
  awaiting_payment:       { cls: "pend", head: "Waiting for payment",
    body: "Complete the payment to start this order. This page updates by itself." },
  pending_confirmations:  { cls: "pend", head: "Payment seen on Base",
    body: "Waiting for your payment to confirm on Base. Usually well under a minute." },
  confirmed_provisioning: { cls: "pend", head: "Payment confirmed",
    body: "Setting up your runtime on-chain. Nothing else to do." },
  complete:               { cls: "ok", head: "All set",
    body: "Your runtime is live on the ledger and the fleet picks it up from here.", link: true },
  under_review:           { cls: "warn", head: "Being checked by a person",
    body: "This payment needs a manual check. It usually clears quickly and your place is kept; there is nothing else to do." },
  expired:                { cls: "err", head: "Order expired",
    body: "This order expired before payment arrived. No funds were taken. Start a new order when you are ready." },
  rejected:               { cls: "err", head: "Payment not accepted",
    body: "This payment could not be accepted. If funds left your wallet, contact support@enclave.host - refunds are handled by a person." },
};
const TERMINAL = ["complete", "expired", "rejected"];

class OrderStatus extends EnclaveElement {
  static properties = { "order-id": "" };
  static templateUrl = new URL("./order-status.html", import.meta.url);

  connectedCallback(){
    super.connectedCallback && super.connectedCallback();
    this._poll = setInterval(() => this.refresh(), 3000);
    this.refresh();
  }
  disconnectedCallback(){
    clearInterval(this._poll);
    super.disconnectedCallback && super.disconnectedCallback();
  }
  async refresh(){
    const id = this["order-id"]; if (!id) return;
    let order;
    try { order = await Enclave.getOrder(id); }
    catch(e){
      const el = this.querySelector(".os-card"); if (!el) return;
      if (e && e.status === 401){ el.innerHTML = '<div class="os-head err">Signed out</div><p class="os-body">Sign in again to see this order.</p>'; clearInterval(this._poll); }
      return;   // transient fetch errors: keep the last good paint, keep polling
    }
    this.paint(order);
    if (TERMINAL.includes(order.state)){
      clearInterval(this._poll);
      this.dispatch("settled", { status: order.state, order });
    }
  }
  // NOT render(): that name is EnclaveElement's template hook (called with
  // no args for the template string) - shadowing it left the card empty
  paint(order){
    const el = this.querySelector(".os-card"); if (!el) return;
    const c = COPY[order.state] || COPY.awaiting_payment;
    const changed = this._last !== order.state; this._last = order.state;
    el.innerHTML =
      '<div class="os-head ' + c.cls + '">' + (TERMINAL.includes(order.state) ? "" : '<span class="os-spin" aria-hidden="true"></span>') + esc(c.head) + '</div>' +
      '<p class="os-body">' + esc(c.body) + '</p>' +
      '<div class="os-meta"><span>Order</span><code>' + esc(order.id) + '</code>' +
      '<span>Total</span><b>$' + esc(order.amountUsd) + '</b>' +
      (order.deploymentId ? '<span>Deployment</span><code>' + esc(String(order.deploymentId).slice(0, 10)) + '…</code>' : "") + '</div>' +
      (c.link ? '<a class="btn btn-sm os-go" href="dashboard">Go to your dashboard →</a>' : "") +
      (order.state === "expired" ? '<a class="btn btn-sm os-go" href="checkout">Start a new order →</a>' : "");
    // the live region announces STATE CHANGES, not every poll repaint
    const live = this.querySelector(".os-live");
    if (live && changed) live.textContent = c.head + ". " + c.body;
  }
}
register("c-order-status", OrderStatus);
