/* ============================================================
   <c-attest-chain> — the "what trustless means" walkthrough:
   the chain-of-measurements links on the left, and the selected
   link's artifact (json / verifier code) on the right.
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";
import { esc, hlJson, hlCode, copyText } from "../../js/core/util.js";

const LINKS = [
  { t: "Hardware root of trust", fn: "policy.json",
    d: "Intel TDX and the NVIDIA GPU hold keys fused at manufacture. Enclave can't extract or forge them. The silicon vendor is the root of trust, not the operator.",
    j: { tdx: { mrtd: "0x5a3c…91ef", minTcb: "2026.05" }, gpu: { approvedDrivers: ["565.57.01"], approvedVbios: ["96.00.AE.00.01"] } } },
  { t: "The VM measures itself", fn: "vm.json",
    d: "On boot the CPU emits a DCAP quote over MRTD + RTMR0–3, binding the firmware, the kernel, and the exact enclave image, including the Wasm app catalog baked into it. Change one byte and the quote changes.",
    j: { technology: "intel-tdx", quote: "BAACAIEAAAAA…", measurements: { mrTd: "5a3c…91ef", rtmr0: "83d5…44aa", rtmr1: "12fc…09b3", rtmr2: "0000…0000", rtmr3: "9f86…0a08" }, reportData: "4b8c…e2a1" } },
  { t: "The GPU attests too", fn: "gpu.json",
    d: "With confidential computing on, the H200 signs an attestation report over your nonce, proving CC mode, driver, and vBIOS before any data reaches VRAM. Check it against NVIDIA's NRAS or nvtrust.",
    j: { technology: "nvidia-cc", ccMode: "on", driverVersion: "565.57.01", nonce: "e37b…52c9", report: "SFVMQ…", certChain: "LS0tL…" } },
  { t: "TLS is born inside", fn: "tls.json",
    d: "The enclave generates its TLS keypair in sealed memory and folds the public-key hash into the quote's report_data. The private key never leaves the boundary, so nobody can sit in the middle.",
    j: { tlsKeyFingerprint: "sha256:4b8c…e2a1", boundTo: "reportData[0:32] = sha256(TLS pubkey SPKI)" } },
  { t: "Your browser verifies", fn: "verify.js",
    d: "Tinfoil's open-source verifier runs the whole chain client-side: hardware report against the vendor root, Sigstore provenance of the release, measurement comparison, TLS binding. The API's verification.selfCheck is the enclave running these same steps on itself: a labeled diagnostic, because trust only counts when YOUR client computes it. Try it live below.",
    code: "import { Verifier } from '@tinfoilsh/verifier';\n// or from a shell: tinfoil attestation verify -e <enclave-host> -r <repo>\n\nconst att = await (await fetch(`/v1/attestation`)).json(); // public: verify BEFORE login\natt.verification.selfCheck;          // enclave's own diagnostic: useful, but not trust\n\nawait new Verifier({\n  serverURL:  new URL(att.verification.attestationEndpoint).origin,\n  configRepo: att.verification.repo, // exact GitHub casing; Sigstore compares verbatim\n}).verify();  // hardware report → vendor root · Sigstore release provenance · measurements match\n\npinTls(att.tlsKeyFingerprint);       // only now: connect" }
];

class AttestChain extends NanElement {
  static templateUrl = new URL("./attest-chain.html", import.meta.url);

  show(i) {
    const l = LINKS[i];
    this.querySelector(".attest-fn").textContent = l.fn;
    const out = this.querySelector(".attest-out");
    if (l.code) { out.innerHTML = hlCode(l.code); this._raw = l.code; }
    else { out.innerHTML = hlJson(l.j); this._raw = JSON.stringify(l.j, null, 2); }
  }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const wrap = this.querySelector(".chain");
    LINKS.forEach((l, i) => {
      const el = document.createElement("div");
      el.className = "link" + (i === 0 ? " active" : "");
      el.innerHTML = '<div class="lk-h"><span class="lk-n">0' + (i + 1) + '</span><span class="lk-t">'
        + esc(l.t) + '</span></div><p class="lk-d">' + esc(l.d) + "</p>";
      el.addEventListener("click", () => {
        wrap.querySelectorAll(".link").forEach(x => x.classList.remove("active"));
        el.classList.add("active"); this.show(i);
      });
      wrap.appendChild(el);
    });
    this.show(0);
    const cp = this.querySelector(".copybtn");
    cp.addEventListener("click", () => copyText(this._raw, cp));
  }
}
register("c-attest-chain", AttestChain);
