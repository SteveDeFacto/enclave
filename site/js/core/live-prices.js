/* ============================================================
   Live price marks for STATIC copy. The overview and develop
   pages quote real dollar rates in prose, formulas, and example
   tables - numbers the operator can change on-chain at any time
   (setPrice/setCpuPrice on EnclaveDeployments), which is exactly
   how the old "$1/hr per node" copy went stale against a live
   $3/hr contract. Any element carrying data-live-price is
   rewritten from the contract the moment the cached price read
   lands; the HTML keeps the last-known values for first paint
   (and for crawlers), same constants-then-contract idiom as the
   deploy console.

   Markup: <span data-live-price="KIND" data-gpu="PCT" data-cpu="PCT">…</span>
   (share dials in whole percent, either may be omitted for 0)
     unit-hr - $/hr of the shares, trimmed ("6", not "6.00"; the
               headline "× $6/hr per full card" rates)
     hr      - $/hr of the shares, 2dp (the example table)
     hr4     - $/hr, 4dp, contract ceil math (the rounding note)
     lin-hr4 - $/hr, 4dp, LINEAR math (what the note contrasts)
     sec     - $/sec of the shares, 6dp (rates are whole µUSDC/s)
   ============================================================ */
import { depPrices6, rate6Of } from "./chain.js";

// "6.00" reads like a spreadsheet in a headline; whole-dollar rates drop the
// cents, anything else keeps them ($6.50 stays "6.50").
const trimWhole = (s) => s.endsWith(".00") ? s.slice(0, -3) : s;

export function hydrateLivePrices(){
  depPrices6().then((pr) => {
    for (const el of document.querySelectorAll("[data-live-price]")){
      const gm = Math.round(Number(el.dataset.gpu || 0) * 10);   // whole % -> 1/1000ths
      const cm = Math.round(Number(el.dataset.cpu || 0) * 10);
      const sec = Number(rate6Of(pr, gm, cm)) / 1e6;             // the contract's ceil math
      const hr = sec * 3600;
      switch (el.dataset.livePrice){
        case "unit-hr": el.textContent = trimWhole(hr.toFixed(2)); break;
        case "hr":      el.textContent = hr.toFixed(2); break;
        case "hr4":     el.textContent = hr.toFixed(4); break;
        case "lin-hr4": el.textContent = ((Number(pr.gpu) * gm + Number(pr.cpu) * cm) / 1000 * 3600 / 1e6).toFixed(4); break;
        case "sec":     el.textContent = sec.toFixed(6); break;
      }
    }
  }).catch(() => {});   // RPC pool down: the baked copy stands, as before
}
