/* ============================================================
   <c-toast> — the site-wide toast. Anyone shows one by
   dispatching a `enclave:toast` event (util.showToast does), the
   LWC ShowToastEvent pattern.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class Toast extends EnclaveElement {
  static templateUrl = new URL("./toast.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    document.addEventListener("enclave:toast", (e) => {
      const t = this.querySelector("#toast"); if (!t) return;
      t.textContent = (e.detail && e.detail.message) || "";
      t.classList.add("show");
      clearTimeout(this._t);
      this._t = setTimeout(() => t.classList.remove("show"), 1700);
    });
  }
}
register("c-toast", Toast);
