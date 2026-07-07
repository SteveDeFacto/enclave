/* ============================================================
   <c-header current="overview|deploy|apps|develop">
   The site's top bar: brand, primary nav, and a composed
   <c-wallet-button> (which owns the wallet lifecycle).
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";
import "../wallet-button/wallet-button.js";

class Header extends NanElement {
  static properties = { current: "" };
  static templateUrl = new URL("./header.html", import.meta.url);

  renderedCallback() {
    // active tab follows the `current` property (template stays static);
    // the soft-nav router (js/boot.js) assigns `current` on every swap.
    // (Speculation-rules prerendering was removed: the router never leaves
    // the document, and it warms the other pages' HTML itself.)
    this.querySelectorAll(".nav-links a").forEach(a =>
      a.classList.toggle("active", a.dataset.view === this.current));
  }
}
register("c-header", Header);
