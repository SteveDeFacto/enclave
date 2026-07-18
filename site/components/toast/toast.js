/* ============================================================
   <c-toast> - the site-wide toast. Anyone shows one by
   dispatching a `enclave:toast` event (util.showToast does), the
   LWC ShowToastEvent pattern.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class Toast extends EnclaveElement {
  static templateUrl = new URL("./toast.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const t = this.querySelector("#toast"); if (!t) return;
    const hide = () => { t.classList.remove("show"); t.removeAttribute("tabindex"); t.textContent = ""; };
    // long messages get READ, not flashed: the clock scales with length
    // (~22 chars/s plus settle time, capped); hover or keyboard focus pauses
    // it, and click / Escape / Enter dismisses. The element is a polite live
    // region, so the full text reaches screen readers regardless of the clock.
    const pause = () => {
      clearTimeout(this._t);
      this._left = Math.max(0, this._left - (Date.now() - this._at));
    };
    const resume = () => {
      this._at = Date.now();
      this._t = setTimeout(hide, Math.max(1000, this._left));
    };
    document.addEventListener("enclave:toast", (e) => {
      const msg = (e.detail && e.detail.message) || "";
      t.textContent = msg;
      t.classList.add("show");
      t.setAttribute("tabindex", "0");
      clearTimeout(this._t);
      this._left = Math.min(12000, Math.max(2200, 1200 + msg.length * 45));
      this._at = Date.now();
      this._t = setTimeout(hide, this._left);
    });
    t.addEventListener("mouseenter", pause);
    t.addEventListener("mouseleave", resume);
    t.addEventListener("focus", pause);
    t.addEventListener("blur", resume);
    t.addEventListener("click", () => { clearTimeout(this._t); hide(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && t.classList.contains("show")) { clearTimeout(this._t); hide(); }
      else if ((e.key === "Enter" || e.key === " ") && e.target === t) { e.preventDefault(); clearTimeout(this._t); hide(); }
    });
  }
}
register("c-toast", Toast);
