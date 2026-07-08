/* ============================================================
   <c-volume-picker> - model volumes the fleet advertises
   (Modelwrap): union across enclaves, each tagged with how many
   enclaves carry it. Assign `.volumes` (list) and `.selected`
   (a live Set the page owns); toggling a row mutates the Set and
   dispatches a bubbling `change`. The picker is a FORM CONTROL
   for the App config JSON's `volumes` key - the page writes the
   ticks into that JSON (and mirrors typed edits back into the
   Set); the config object stays the only carrier.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";

class VolumePicker extends EnclaveElement {
  static properties = { volumes: null, selected: null };
  static templateUrl = new URL("./volume-picker.html", import.meta.url);

  renderedCallback() {
    const list = this.querySelector(".vol-list"); if (!list) return;
    const vols = this.volumes || [], sel = this.selected || new Set();
    list.innerHTML = vols.map(v => {
      const on = sel.has(v.name);
      const gb = v.bytes ? (v.bytes/1073741824).toFixed(v.bytes > 1073741824 ? 1 : 2) + " GB" : "";
      return '<label class="vol-row' + (on ? " on" : "") + '">'
        + '<input type="checkbox" data-vol="' + esc(v.name) + '"' + (on ? " checked" : "") + ' />'
        + '<span class="vol-name">' + esc(v.name) + '</span>'
        + (v.onnx ? '<span class="ap-badge info">onnx</span>' : "")
        + (v.gguf ? '<span class="ap-badge info">gguf</span>' : "")
        + (gb ? '<span class="vol-size dim">' + gb + '</span>' : "")
        + '<span class="vol-where dim">' + v.count + (v.count === 1 ? " enclave" : " enclaves") + '</span>'
        + '</label>';
    }).join("");
    list.querySelectorAll('input[data-vol]').forEach(cb => cb.addEventListener("change", () => {
      if (cb.checked) sel.add(cb.dataset.vol); else sel.delete(cb.dataset.vol);
      cb.closest(".vol-row").classList.toggle("on", cb.checked);
      this.dispatch("change", { selected: sel });
    }));
  }
}
register("c-volume-picker", VolumePicker);
