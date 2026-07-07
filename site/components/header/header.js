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

    // Prerender the other tabs on hover (Speculation Rules): by the time the
    // click lands the next page is already loaded, so navigation — combined
    // with the view transition — feels like the header never reloads.
    // Chromium-only; other engines ignore it and navigate normally.
    if (!this._specRules) {
      this._specRules = true;
      try {
        if (HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")
            && !document.querySelector('script[type="speculationrules"]')) {
          const s = document.createElement("script");
          s.type = "speculationrules";
          s.textContent = JSON.stringify({ prerender: [{ where: { selector_matches: ".nav-links a" }, eagerness: "moderate" }] });
          document.head.appendChild(s);
        }
      } catch (e) {}
    }
  }
}
register("c-header", Header);
