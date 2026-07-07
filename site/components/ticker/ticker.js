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
  }
}
register("c-ticker", Ticker);
