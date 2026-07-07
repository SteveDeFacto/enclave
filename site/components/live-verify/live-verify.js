/* ============================================================
   <c-live-verify> — the "run the check now" widget: performs
   the full client-side enclave verification (core/verify.js) and
   renders each step's outcome + the verdict.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";
import { Enclave } from "../../js/core/api.js";
import { vspecOf, verifyEnclaveInBrowser } from "../../js/core/verify.js";

const LV_STEP_ORDER = ["fetchDigest", "verifyEnclave", "verifyCode", "compareMeasurements", "verifyCertificate"];
const LV_LABELS = {
  fetchDigest:         "fetch attestation, signed release digest + Sigstore bundle",
  verifyEnclave:       "verify AMD SEV-SNP report (VCEK chain → AMD root of trust)",
  verifyCode:          "verify release provenance (Sigstore: Fulcio + Rekor)",
  compareMeasurements: "compare signed code measurement to live enclave measurement",
  verifyCertificate:   "bind the served certificate to the attested report",
};

class LiveVerify extends EnclaveElement {
  static templateUrl = new URL("./live-verify.html", import.meta.url);

  renderedCallback() {
    const btn = this.querySelector(".lv-run");
    if (btn && !btn._wired){ btn._wired = true; btn.addEventListener("click", () => this.verify(btn)); }
  }

  async verify(btn) {
    const body = this.querySelector(".lv-body"), steps = this.querySelector(".lv-steps");
    const verdict = this.querySelector(".lv-verdict"), meta = this.querySelector(".lv-meta");
    body.hidden = false; btn.disabled = true;
    steps.innerHTML = ""; meta.innerHTML = "";
    const status = (t) => { verdict.className = "lv-verdict"; verdict.textContent = t; };
    try {
      status("fetching " + Enclave.base + "/attestation …");
      const att = await Enclave._req("GET", "/attestation");
      const vspec = vspecOf(att);
      if (!vspec) throw new Error("attestation is missing the verification block");
      status("verifying in your browser … (fetches AMD + Sigstore material, takes a few seconds)");
      const r = await verifyEnclaveInBrowser(vspec);
      const cliEl = this.querySelector(".lv-cli"); if (cliEl) cliEl.textContent = "tinfoil attestation verify -e " + r.host + " -r " + r.repo;
      const doc = r.doc;
      LV_STEP_ORDER.forEach((k) => {
        const st = doc && doc.steps && doc.steps[k];
        const cls = !st || st.status === "pending" ? "" : st.status === "success" ? "ok" : "bad";
        const li = document.createElement("li");
        li.className = cls;
        li.innerHTML = '<span class="st">' + (cls === "ok" ? "✓" : cls === "bad" ? "✗" : "·") + '</span><span>'
          + esc(LV_LABELS[k]) + (st && st.error ? ': <span class="err">' + esc(st.error) + "</span>" : "") + "</span>";
        steps.appendChild(li);
      });
      if (r.ok) {
        verdict.className = "lv-verdict ok";
        verdict.textContent = "✓ VERIFIED: this enclave is running the exact code signed on " + r.repo + "'s latest release";
        const apiFp = String(att.tlsKeyFingerprint || "").replace(/^sha256:/, "");
        meta.innerHTML = [
          "measurement   " + doc.enclaveFingerprint,
          "release       sha256:" + doc.releaseDigest,
          "tls key       sha256:" + doc.tlsPublicKey + (apiFp ? (apiFp === doc.tlsPublicKey ? "  (matches the API's copy)" : "  ⚠ API reported sha256:" + apiFp) : ""),
        ].map((x) => "<span>" + esc(x) + "</span>").join("");
      } else {
        verdict.className = "lv-verdict bad";
        verdict.textContent = "✗ NOT VERIFIED: " + (r.error || "verification incomplete");
      }
    } catch (e) {
      verdict.className = "lv-verdict bad";
      verdict.textContent = "✗ could not run verification: " + (e && e.message ? e.message : e);
    } finally { btn.disabled = false; }
  }
}
register("c-live-verify", LiveVerify);
