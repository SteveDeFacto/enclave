/* ============================================================
   <c-fleet-list> — per-enclave capacity rows (the relay's
   /enclaves table). Assign `.rows` (already sorted upstream) and
   it renders each box's two free pools.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, fmtNum } from "../../js/core/util.js";
import { CARD_GB, NODE_RAM_GB, NODE_VCPUS } from "../../js/core/pricing.js";

class FleetList extends EnclaveElement {
  static properties = { rows: null };
  static templateUrl = new URL("./fleet-list.html", import.meta.url);

  renderedCallback() {
    const list = this.querySelector(".fleet-list"); if (!list) return;
    const rows = this.rows || [];
    const meter = (pct) => '<i class="fleet-meter"><b style="width:' + Math.max(0, Math.min(100, pct)) + '%"></b></i>';
    list.innerHTML = !rows.length
      ? '<div class="fleet-empty">no live enclaves</div>'
      : rows.map(e => {
          const a = e.availability || {};
          const gpu = a.gpu === true;
          const gFree = a.gpuShareFree != null ? a.gpuShareFree : (gpu ? a.maxShare || 0 : 0);
          const cFree = a.cpuShareFree != null ? a.cpuShareFree : (gpu ? 0 : a.maxShare || 0);
          const gPct = Math.floor(gFree * 100), cPct = Math.floor(cFree * 100);
          const name = String(e.endpoint || "").replace(/^https?:\/\//, "").split(".")[0] || "enclave";
          return '<div class="fleet-row" title="' + esc(e.endpoint || "") + '">'
            + '<span class="ap-badge ' + (gpu ? "info" : "") + '">' + (gpu ? "gpu" : "cpu") + '</span>'
            + '<span class="fleet-name">' + esc(name) + '</span>'
            + (gpu ? '<span class="fleet-pool">GPU ' + meter(gPct) + ' ' + gPct + '% free · ≈'
                   + Math.round(gFree * (a.cardVramGb || CARD_GB)) + ' GB VRAM</span>' : '')
            + '<span class="fleet-pool">CPU ' + meter(cPct) + ' ' + cPct + '% free · ≈'
            + fmtNum(cFree * (a.nodeRamGb || NODE_RAM_GB)) + ' GB RAM / ' + fmtNum(cFree * (a.nodeVcpus || NODE_VCPUS)) + ' vCPU</span>'
            + '</div>';
        }).join("");
  }
}
register("c-fleet-list", FleetList);
