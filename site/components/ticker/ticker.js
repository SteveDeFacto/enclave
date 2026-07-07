/* ============================================================
   <c-ticker> — the facts marquee under the hero. The items live
   in the TEMPLATE (so the build-time prerender shows them with
   no JS at all); hydration just doubles the track, which the
   -50% keyframe needs for a seamless loop.
   ============================================================ */
import { NanElement, register } from "../../js/lib/nan-element.js";

class Ticker extends NanElement {
  static templateUrl = new URL("./ticker.html", import.meta.url);

  renderedCallback() {
    const t = this.querySelector(".ticker-track");
    if (!t || t.dataset.looped) return;
    t.dataset.looped = "1";
    t.innerHTML += t.innerHTML;
    // constant speed regardless of how many facts the template holds:
    // one loop = one content copy, at ~50 px/s
    const copy = t.scrollWidth / 2;
    if (copy > 0) t.style.animationDuration = Math.round(copy / 50) + "s";
  }
}
register("c-ticker", Ticker);
