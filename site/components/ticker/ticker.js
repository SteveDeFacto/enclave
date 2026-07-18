/* ============================================================
   <c-ticker> - the facts marquee under the hero. The items live
   in the TEMPLATE (so the build-time prerender shows them with
   no JS at all); hydration just doubles the track, which the
   -50% keyframe needs for a seamless loop.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class Ticker extends EnclaveElement {
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
    // WCAG 2.2.2: moving content needs a real pause control (hover-pause
    // alone leaves keyboard/touch users without one)
    const btn = this.querySelector(".ticker-pause");
    if (btn) btn.addEventListener("click", () => {
      const paused = this.querySelector(".ticker").classList.toggle("paused");
      btn.setAttribute("aria-pressed", String(paused));
      btn.setAttribute("aria-label", (paused ? "Play" : "Pause") + " the facts ticker");
      btn.textContent = paused ? "▶︎" : "⏸︎";
    });
  }
}
register("c-ticker", Ticker);
