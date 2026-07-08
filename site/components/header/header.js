/* ============================================================
   <c-header current="overview|apps|develop|dashboard">
   The site's top bar: brand, primary nav, and a composed
   <c-wallet-button> (which owns the wallet lifecycle). The
   Dashboard tab is signed-in chrome: hidden until a wallet
   session exists (on baked pages the wallet-paint script
   unhides it pre-paint from localStorage state).
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import "../wallet-button/wallet-button.js";
import { on } from "../../js/core/util.js";
import { Enclave } from "../../js/core/api.js";

class Header extends EnclaveElement {
  static properties = { current: "" };
  static templateUrl = new URL("./header.html", import.meta.url);

  renderedCallback() {
    // active tab follows the `current` property (template stays static);
    // the soft-nav router (js/boot.js) assigns `current` on every swap.
    // (Speculation-rules prerendering was removed: the router never leaves
    // the document, and it warms the other pages' HTML itself.)
    this.querySelectorAll(".nav-links a").forEach(a =>
      a.classList.toggle("active", a.dataset.view === this.current));
    const d = this.querySelector('a[data-view="dashboard"]');
    if (d) d.hidden = !Enclave.address;
  }
}
register("c-header", Header);

// session edges (connect / restore / sign-out) toggle the Dashboard tab on
// the live header - the same DOM node across all soft navigations
on("enclave:wallet", () => {
  const d = document.querySelector('c-header a[data-view="dashboard"]');
  if (d) d.hidden = !Enclave.address;
});
