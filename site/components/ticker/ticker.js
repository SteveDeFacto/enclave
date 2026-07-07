/* ============================================================
   <c-ticker> — the facts marquee under the hero. The items
   live here, with the component that renders them.
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";
import { esc } from "../../js/core/util.js";

const ITEMS = [
  ["Intel TDX", " + NVIDIA confidential computing"],
  ["Per-second", " metering, settled on-chain"],
  ["TLS", " terminates inside the enclave"],
  ["H200", " · whole-GPU confidential computing"],
  ["Wasm apps", " · wasi:http, sandboxed in the enclave"],
  ["No accounts", " · no KYC · wallet-native"],
  ["CORS-enabled", " · drive it from the browser"],
  ["Per-tenant", " Wasm sandbox + process isolation · VRAM wiped on rotation"],
  ["Verify the quote", " before you connect"],
  ["No custody", " · pay-per-deploy, top up to extend"]
];

class Ticker extends NanElement {
  static templateUrl = new URL("./ticker.html", import.meta.url);

  renderedCallback() {
    const t = this.querySelector(".ticker-track"); if (!t) return;
    const one = ITEMS.map(([b, rest]) => '<span class="it"><b>' + esc(b) + "</b>" + esc(rest) + "</span>").join("");
    t.innerHTML = one + one;   // doubled: the keyframe scrolls -50% for a seamless loop
  }
}
register("c-ticker", Ticker);
