/* ============================================================
   <c-toast> — the site-wide toast. Anyone shows one by
   dispatching a `nan:toast` event (util.showToast does), the
   LWC ShowToastEvent pattern.
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";

class Toast extends NanElement {
  static templateUrl = new URL("./toast.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    document.addEventListener("nan:toast", (e) => {
      const t = this.querySelector("#toast"); if (!t) return;
      t.textContent = (e.detail && e.detail.message) || "";
      t.classList.add("show");
      clearTimeout(this._t);
      this._t = setTimeout(() => t.classList.remove("show"), 1700);
    });
  }
}
register("c-toast", Toast);
