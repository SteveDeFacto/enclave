/* ============================================================
   <c-enclave-panel> - the hero's sealed-enclave visual: a
   particle canvas inside a dashed boundary, periodically swept
   by a "measurement" that rolls the fake rtmr3 hash.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

const HEXC = "0123456789abcdef";
const hex = (n) => { let s = ""; for (let i = 0; i < n; i++) s += HEXC[(Math.random() * 16) | 0]; return s; };
const fmtHash = () => "0x" + hex(4) + "…" + hex(4);

class EnclavePanel extends EnclaveElement {
  static templateUrl = new URL("./enclave-panel.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const $ = (s) => this.querySelector(s);
    const cv = $("#enclaveCanvas"); if (!cv) return;
    const ctx = cv.getContext("2d");
    const reduce = (typeof matchMedia === "function") && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const PAD = 14;
    let W = 0, H = 0, DPR = 1, parts = [], sweep = -1, seedW = -1, seedH = -1;

    function size() {
      const r = cv.getBoundingClientRect();
      if (r.width < 40) return false;   // section hidden / not laid out - keep the last good bitmap
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width; H = r.height || 280;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      return true;
    }
    function seed() {
      seedW = W; seedH = H; parts = [];
      const n = Math.max(10, Math.min(26, Math.floor(W / 16)));
      for (let i = 0; i < n; i++)
        parts.push({ x: PAD + Math.random() * (W - 2 * PAD), y: PAD + Math.random() * (H - 2 * PAD),
          vx: (Math.random() - .5) * .5, vy: (Math.random() - .5) * .5, r: 1 + Math.random() * 1.6 });
    }
    function frame() {
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(47,230,168,.26)"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
      ctx.strokeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD); ctx.setLineDash([]);
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i], b = parts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 58) { ctx.strokeStyle = "rgba(47,230,168," + (0.1 * (1 - d / 58)) + ")";
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
      parts.forEach(p => {
        if (!reduce) {
          p.x += p.vx; p.y += p.vy;
          if (p.x < PAD || p.x > W - PAD) p.vx *= -1;
          if (p.y < PAD || p.y > H - PAD) p.vy *= -1;
          p.x = Math.max(PAD, Math.min(W - PAD, p.x)); p.y = Math.max(PAD, Math.min(H - PAD, p.y));
        }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3, 0, 7); ctx.fillStyle = "rgba(47,230,168,.06)"; ctx.fill();
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fillStyle = "rgba(130,247,205,.95)"; ctx.fill();
      });
      if (sweep >= 0) {
        const y = PAD + sweep * (H - 2 * PAD);
        const g = ctx.createLinearGradient(0, y - 16, 0, y + 16);
        g.addColorStop(0, "rgba(143,162,255,0)"); g.addColorStop(.5, "rgba(143,162,255,.45)"); g.addColorStop(1, "rgba(143,162,255,0)");
        ctx.fillStyle = g; ctx.fillRect(PAD, y - 16, W - 2 * PAD, 32);
        ctx.strokeStyle = "rgba(143,162,255,.85)"; ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
        sweep += 0.02;
        if (sweep > 1) { sweep = -1; $("#measureHash").textContent = fmtHash();
          const st = $("#enclaveState"); if (st) st.textContent = "sealed"; }
      }
      if (!reduce) requestAnimationFrame(frame);
    }
    function tick() {
      sweep = 0; const st = $("#enclaveState"); if (st) st.textContent = "measuring";
      setTimeout(tick, 3800 + Math.random() * 2800);
    }
    function revive() {                 // re-sync after anything that can invalidate the bitmap, the
      if (!size()) return;              // DPR transform, or a seed made while the section was hidden
      if (seedW !== W || seedH !== H) seed();
      if (reduce) frame();
    }
    size(); seed(); $("#measureHash").textContent = fmtHash();
    if (reduce) { frame(); }
    else { requestAnimationFrame(frame); setTimeout(tick, 1600); }
    let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(revive, 150); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) revive(); });
    cv.addEventListener("contextrestored", revive);   // browser reclaimed the canvas backing store
  }
}
register("c-enclave-panel", EnclavePanel);
