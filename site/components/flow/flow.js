/* ============================================================
   <c-flow> - the "Five calls, start to finish" lifecycle
   stepper. The step buttons live in the TEMPLATE (prerendered at
   build time); this class holds each step's method+path and
   renders the detail pane live from openapi.json on hydration.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, hlJson, hlCode } from "../../js/core/util.js";
import { loadSpec, getSpec, bodyExample, responseExample } from "../../js/core/spec.js";

/* method+path per step button, in template order */
const STEPS = [
  { method: "POST",   path: "/auth/login" },
  { method: "TX",     path: "EnclaveDeployments.create()" },
  { method: "POST",   path: "/claim-hint" },
  { method: "GET",    path: "/deployments/{id}/attestation" },
  { method: "DELETE", path: "/deployments/{id}" },
];

class Flow extends EnclaveElement {
  static templateUrl = new URL("./flow.html", import.meta.url);

  detail(i) {
    const s = STEPS[i], op = (getSpec().paths[s.path] || {})[s.method.toLowerCase()];
    let h = '<div style="padding:15px 18px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;gap:12px;">'
      + '<span class="mtag m-' + s.method.toLowerCase() + '">' + s.method + "</span>"
      + '<span class="op-path">' + esc(s.path) + "</span></div><div style='padding:16px 18px;'>";
    if (!op) {   // on-chain steps aren't HTTP operations, so they have no spec entry
      h += '<div class="block-lbl" style="margin-top:0">On-chain · Base</div>'
        + '<div class="code"><pre style="margin:0;padding:13px 16px"><code>'
        + hlCode('// one wallet transaction - no HTTP call\ncreate(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, configCid)\n// appRef = catalog://<appId>/<versionIndex> (the version record; configCid stays "")\n// -> the receipt\'s Created event: topics[1] is your deployment id (bytes32)')
        + "</code></pre></div></div>";
      this.querySelector(".flow-detail").innerHTML = h;
      return;
    }
    const be = bodyExample(op);
    if (be) h += '<div class="block-lbl" style="margin-top:0">Request</div>'
      + '<div class="code" style="margin-bottom:14px"><pre style="margin:0;padding:13px 16px"><code>' + hlJson(be) + "</code></pre></div>";
    const codes = Object.keys(op.responses), ok = codes.find(c => c[0] === "2") || codes[0];
    const re = responseExample(op.responses[ok]);
    h += '<div class="block-lbl"' + (be ? "" : ' style="margin-top:0"') + ">Response · " + esc(ok) + "</div>"
      + '<div class="code"><pre style="margin:0;padding:13px 16px"><code>'
      + (re !== null ? hlJson(re) : esc(op.responses[ok].description || "")) + "</code></pre></div></div>";
    this.querySelector(".flow-detail").innerHTML = h;
  }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const wrap = this.querySelector(".steps");
    wrap.querySelectorAll(".step").forEach((el, i) => {
      el.addEventListener("click", () => {
        wrap.querySelectorAll(".step").forEach(x => x.classList.remove("active"));
        el.classList.add("active"); this.detail(i);
      });
    });
    loadSpec().then(() => this.detail(0), e => console.warn("[c-flow] spec load failed:", e));
  }
}
register("c-flow", Flow);
