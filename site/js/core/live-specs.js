/* ============================================================
   Live hardware marks for STATIC copy - the sibling of
   live-prices.js. The overview and develop pages quote real
   fleet hardware in prose, formulas, and the example table
   (card VRAM/TFLOPS, node RAM/vCPU/GFLOPS, what a share grants)
   - numbers that change the day the fleet's card does, and that
   already bit us once as constants (2026-07-14: "141 GB" copy
   vs the probed 140.4 GiB card sold unclaimable shares). Any
   element carrying data-live-spec is rewritten from the same
   /availability payload the deploy console's share math adopts
   (relay spec* fleet minima - see pricing.js); the HTML keeps
   the last-known values for first paint and crawlers, and those
   baked values are written to match what the FALLBACK constants
   render to, so a failed fetch never shows a mismatch.

   Markup: <span data-live-spec="KIND" data-gpu="PCT" data-cpu="PCT">…</span>
   (share dials in whole percent; omit both for the exact-spec kinds)
     card-vram / card-tflops / node-ram / node-vcpus / node-gflops
             - the server spec itself, verbatim (the divisor in
               the catalog floor math, so no display rounding)
     vram / tflops - what data-gpu % of the card grants
     ram / vcpu / gflops - what data-cpu % of the node grants
               (grants round like the deploy console readout)
     tflops-floor - data-gpu % of the card rounded DOWN: the
               "an app declaring N TFLOPS floors at X%" example
               must round down or the claimed floor goes wrong
   ============================================================ */
import { Enclave } from "./api.js";
import { serverSpec } from "./pricing.js";

// grant formatting: 2dp under 1, 1dp under 10, whole above ("0.16 vCPU",
// "1.4 GB", "99 TFLOPS"); parseFloat drops trailing zeros ("6.40" -> "6.4")
const fmt = (v) => String(parseFloat(v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0)));

function render(){
  const s = serverSpec();
  for (const el of document.querySelectorAll("[data-live-spec]")){
    const g = Number(el.dataset.gpu || 0) / 100;
    const c = Number(el.dataset.cpu || 0) / 100;
    switch (el.dataset.liveSpec){
      case "card-vram":    el.textContent = String(s.cardVramGb); break;
      case "card-tflops":  el.textContent = String(s.cardTflops); break;
      case "node-ram":     el.textContent = String(s.nodeRamGb); break;
      case "node-vcpus":   el.textContent = String(s.nodeVcpus); break;
      case "node-gflops":  el.textContent = String(s.nodeGflops); break;
      case "vram":         el.textContent = fmt(g * s.cardVramGb); break;
      case "tflops":       el.textContent = fmt(g * s.cardTflops); break;
      case "tflops-floor": el.textContent = String(Math.floor(g * s.cardTflops)); break;
      case "ram":          el.textContent = fmt(c * s.nodeRamGb); break;
      case "vcpu":         el.textContent = fmt(c * s.nodeVcpus); break;
      case "gflops":       el.textContent = fmt(c * s.nodeGflops); break;
    }
  }
}

export function hydrateLiveSpecs(){
  // getAvailability() adopts the payload into pricing.js' server spec as a
  // side effect - render() then reads the adopted numbers back
  Enclave.getAvailability().then(render).catch(() => {});   // relay down: the baked copy stands
}
