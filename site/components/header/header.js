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
    // active tab follows the `current` property (template stays static)
    this.querySelectorAll(".nav-links a").forEach(a =>
      a.classList.toggle("active", a.dataset.view === this.current));

    // Speculation Rules: fetch the other tabs' HTML immediately (a few KB),
    // and fully prerender ANY internal page link the pointer approaches — by
    // the time the click lands the next page is already rendered, so the
    // view transition starts with zero navigation latency.
    // Chromium-only; other engines ignore it and navigate normally.
    if (!this._specRules) {
      this._specRules = true;
      try {
        if (HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")
            && !document.querySelector('script[type="speculationrules"]')) {
          const pages = "a[href^='index.html'],a[href^='deploy.html'],a[href^='apps.html'],a[href^='develop.html']";
          const s = document.createElement("script");
          s.type = "speculationrules";
          s.textContent = JSON.stringify({
            prefetch:  [{ where: { selector_matches: ".nav-links a" }, eagerness: "immediate" }],
            prerender: [{ where: { selector_matches: pages }, eagerness: "moderate" }],
          });
          document.head.appendChild(s);
        }
      } catch (e) {}
    }
  }
}
register("c-header", Header);
