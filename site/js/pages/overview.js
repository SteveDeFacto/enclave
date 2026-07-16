/* ============================================================
   Overview page - composition of self-hydrating components; the
   one page-specific wire is the pricing section's provenance
   chips (which contract the rates live on), the same grammar as
   the store head on Apps and the Dashboard.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/enclave-panel/enclave-panel.js";
import "../../components/ticker/ticker.js";
import "../../components/flow/flow.js";
import "../../components/attest-chain/attest-chain.js";
import "../../components/live-verify/live-verify.js";
import { $ } from "../core/util.js";
import { DEPLOYMENTS_ADDRESS } from "../core/config.js";
import { catExplorer } from "../core/chain.js";
import { hydrateLivePrices } from "../core/live-prices.js";

/* Scroll reveal: sections below the fold get .rv (hidden, see base.css)
   and settle in on first intersection; cards inside stagger via --rv-i.
   The hidden state is only ever applied HERE, so with JS off (or broken)
   everything just stays visible. Sections already on screen are skipped -
   nothing visible ever blinks out to fade back in. One observer per
   <main> mount (soft navs swap <main> and re-run boot). */
let revealObs;
function initReveal() {
  if (revealObs) { revealObs.disconnect(); revealObs = null; }
  if (!("IntersectionObserver" in window)) return;
  const strip = (s) => {          // entrance done: hand the nodes back untouched
    s.classList.remove("rv", "rv-in");
    for (const k of s.querySelectorAll(".rv-kid")) { k.classList.remove("rv-kid"); k.style.removeProperty("--rv-i"); }
  };
  revealObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      revealObs.unobserve(e.target);
      e.target.classList.add("rv-in");
      setTimeout(strip, 1700, e.target);   // > the longest transition + stagger
    }
  }, { rootMargin: "0px 0px -12% 0px" });
  for (const s of document.querySelectorAll('main section[data-view="overview"]:not(.hero)')) {
    const r = s.getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0) continue;   // on screen right now: never hide it
    s.classList.add("rv");
    let i = 0;
    for (const kid of s.querySelectorAll(".cards > .card, .price-grid > .price-card")) {
      kid.classList.add("rv-kid");
      kid.style.setProperty("--rv-i", i++);
    }
    revealObs.observe(s);
  }
}

export function boot() {
  // the pricing section's provenance mark: one icon straight to the contract
  // on Basescan (Steven's call - no chip text, no chain/short-address noise);
  // the full name + address live in the tooltip
  const link = $("#priceAddrLink");
  if (link){
    if (DEPLOYMENTS_ADDRESS && !/^0x0+$/i.test(DEPLOYMENTS_ADDRESS)){
      link.href = catExplorer() + "/address/" + DEPLOYMENTS_ADDRESS;
      link.title = "EnclaveDeployments · " + DEPLOYMENTS_ADDRESS;
    } else link.hidden = true;
  }
  // every quoted dollar rate on this page re-reads from the contract - the
  // baked numbers are only the first paint (see core/live-prices.js)
  hydrateLivePrices();
  // reveal init waits one frame: the router scrolls right after boot()
  // returns (and a hard entry may still be applying its anchor scroll), so
  // the fold check must run against the settled viewport, not a stale one
  requestAnimationFrame(initReveal);
}
