/* ============================================================
   <c-flow> — the "Five calls, start to finish" lifecycle
   stepper. The steps are data here; each HTTP step's detail pane
   (request/response examples) renders live from openapi.json.
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";
import { esc, hlJson, hlCode } from "../../js/core/util.js";
import { loadSpec, getSpec, bodyExample, responseExample } from "../../js/core/spec.js";

const STEPS = [
  { t: "Sign in with your wallet", d: "Prove control of your address, with no email and no password.", method: "POST", path: "/auth/login" },
  { t: "Create a deployment",      d: "One create() tx on Deployments from your wallet: app CID + two shares in 1/1000ths (the app's specs set the minimums). You own the on-chain record; it survives enclave updates.", method: "TX", path: "Deployments.create()" },
  { t: "Fund runtime",             d: "fundWithAuthorization (EIP-3009 USDC) or fundEth on Deployments credits the deployment's on-chain balance; enclaves claim funded work and serve it under leases. Fund again any time to extend.", method: "POST", path: "/claim-hint" },
  { t: "Verify the enclave",       d: "Pull the TDX quote + GPU report and check them yourself.", method: "GET",  path: "/deployments/{id}/attestation" },
  { t: "Stop (or let it expire)",  d: "Tear down and release the share. No held balance to reclaim.", method: "DELETE", path: "/deployments/{id}" }
];

class Flow extends NanElement {
  static templateUrl = new URL("./flow.html", import.meta.url);

  detail(i) {
    const s = STEPS[i], op = (getSpec().paths[s.path] || {})[s.method.toLowerCase()];
    let h = '<div style="padding:15px 18px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;gap:12px;">'
      + '<span class="mtag m-' + s.method.toLowerCase() + '">' + s.method + "</span>"
      + '<span class="op-path">' + esc(s.path) + "</span></div><div style='padding:16px 18px;'>";
    if (!op) {   // on-chain steps aren't HTTP operations, so they have no spec entry
      h += '<div class="block-lbl" style="margin-top:0">On-chain · Base</div>'
        + '<div class="code"><pre style="margin:0;padding:13px 16px"><code>'
        + hlCode('// one wallet transaction - no HTTP call\ncreate(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, sshPubKey, configCid)\n// -> the receipt\'s Created event: topics[1] is your deployment id (bytes32)')
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
    loadSpec().then(() => {
      STEPS.forEach((s, i) => {
        const el = document.createElement("button");
        el.className = "step" + (i === 0 ? " active" : ""); el.type = "button"; el.setAttribute("role", "tab");
        el.innerHTML = '<span class="num">' + (i + 1) + '</span><div><div class="st-t">' + esc(s.t)
          + '</div><div class="st-d">' + esc(s.d) + "</div></div>";
        el.addEventListener("click", () => {
          wrap.querySelectorAll(".step").forEach(x => x.classList.remove("active"));
          el.classList.add("active"); this.detail(i);
        });
        wrap.appendChild(el);
      });
      this.detail(0);
    }, e => console.warn("[c-flow] spec load failed:", e));
  }
}
register("c-flow", Flow);
