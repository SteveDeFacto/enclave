/* ============================================================
   <c-attest-chain> - the "what trustless means" walkthrough:
   the chain-of-measurements links on the left, and the selected
   link's artifact (json / verifier code) on the right.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { hlJson, hlCode, copyText } from "../../js/core/util.js";

/* the artifact shown for each template link, in template order (the link
   titles/descriptions live in the TEMPLATE so the build can prerender them) */
const LINKS = [
  { fn: "policy.json",
    j: { tdx: { mrtd: "0x5a3c…91ef", minTcb: "2026.05" }, gpu: { approvedDrivers: ["565.57.01"], approvedVbios: ["96.00.AE.00.01"] } } },
  { fn: "vm.json",
    j: { technology: "intel-tdx", quote: "BAACAIEAAAAA…", measurements: { mrTd: "5a3c…91ef", rtmr0: "83d5…44aa", rtmr1: "12fc…09b3", rtmr2: "0000…0000", rtmr3: "9f86…0a08" }, reportData: "4b8c…e2a1" } },
  { fn: "gpu.json",
    j: { technology: "nvidia-cc", ccMode: "on", driverVersion: "565.57.01", nonce: "e37b…52c9", report: "SFVMQ…", certChain: "LS0tL…" } },
  { fn: "tls.json",
    j: { tlsKeyFingerprint: "sha256:4b8c…e2a1", boundTo: "reportData[0:32] = sha256(TLS pubkey SPKI)" } },
  { fn: "verify.js",
    code: "import { Verifier } from '@tinfoilsh/verifier';\n// or from a shell: tinfoil attestation verify -e <enclave-host> -r <repo>\n\nconst att = await (await fetch(`/v1/attestation`)).json(); // public: verify BEFORE login\natt.verification.selfCheck;          // enclave's own diagnostic: useful, but not trust\n\nawait new Verifier({\n  serverURL:  new URL(att.verification.attestationEndpoint).origin,\n  configRepo: att.verification.repo, // exact GitHub casing; Sigstore compares verbatim\n}).verify();  // hardware report → vendor root · Sigstore release provenance · measurements match\n\npinTls(att.tlsKeyFingerprint);       // only now: connect" }
];

class AttestChain extends EnclaveElement {
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
    wrap.querySelectorAll(".link").forEach((el, i) => {
      el.addEventListener("click", () => {
        wrap.querySelectorAll(".link").forEach(x => x.classList.remove("active"));
        el.classList.add("active"); this.show(i);
      });
    });
    this.show(0);
    const cp = this.querySelector(".copybtn");
    cp.addEventListener("click", () => copyText(this._raw, cp));
  }
}
register("c-attest-chain", AttestChain);
