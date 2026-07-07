/* ============================================================
   <c-footer> — the shared site footer. The "OpenAPI spec"
   link downloads the same openapi.json the API reference and
   code samples render from.
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";
import { loadSpec } from "../../js/core/spec.js";
import { showToast } from "../../js/core/util.js";

export async function downloadSpec() {
  const spec = await loadSpec();
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "openapi.json"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("openapi.json downloaded");
}

class Footer extends NanElement {
  static templateUrl = new URL("./footer.html", import.meta.url);

  renderedCallback() {
    const d = this.querySelector("#dlSpec2");
    if (d && !d._wired){ d._wired = true; d.addEventListener("click", e => { e.preventDefault(); downloadSpec(); }); }
  }
}
register("c-footer", Footer);
