/* ============================================================
   <c-app-card> — one catalog listing. Data flows IN through
   the `app` property; actions that need a wallet transaction or
   navigation flow OUT as a bubbling `card-action` CustomEvent
   (detail: { app, act, idx }) — the LWC data-down/events-up
   pattern. Copying the CID and switching the version are handled
   internally.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, short, copyText } from "../../js/core/util.js";
import { IPFS_GATEWAY } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { APPROVAL } from "../../js/core/chain.js";
import { STORE, selIdx, appOfficial } from "../../js/core/catalog.js";
import { minPctsOf } from "../../js/core/pricing.js";

class AppCard extends EnclaveElement {
  static properties = { app: null };
  static templateUrl = new URL("./app-card.html", import.meta.url);

  renderedCallback() {
    const app = this.app; if (!app) return;
    const i = selIdx(app);
    const v = app.versions[i] || { cid:"", version:"–", vramMb:0, gpuGflops:0, memMb:0, cpuGflops:0, verified:false, yanked:false, approval:APPROVAL.pending };
    const me = (Enclave.address || "").toLowerCase();
    const isPub = me && app.publisher.toLowerCase() === me;
    const isOwner = me && STORE.owner && me === STORE.owner;
    const gw = IPFS_GATEWAY.replace(/\/+$/, "") + "/" + encodeURIComponent(v.cid);
    const isOfficial = appOfficial(app);

    const art = this.querySelector("article");
    art.className = "app-card" + (v.verified ? " verified" : "") + (app.active ? "" : " delisted");
    art.dataset.appid = app.appId;

    this.querySelector("h3").textContent = app.name;

    const badge = v.verified
      ? '<span class="app-badge" title="This version is marked verified by the catalog owner">✓ verified</span>'
      : (!STORE.owner || isOfficial) ? ''   // owner not fetched yet: community status is unknown, show nothing
      : '<span class="app-badge comm" title="Community-published; not owner-verified">community</span>';
    // approval is the deploy gate: the enclave refuses this CID until the catalog owner approves it
    // (official apps skip the ✓ approved badge - owner-published implies it - but pending/rejected still show)
    const apBadge = v.approval === APPROVAL.approved
      ? (isOfficial ? '' : '<span class="app-badge" title="Approved by the catalog owner; deployable">✓ approved</span>')
      : v.approval === APPROVAL.rejected
      ? '<span class="app-badge rej" title="Rejected by the catalog owner; deploys are refused">✕ rejected</span>'
      : '<span class="app-badge unv" title="Awaiting catalog-owner approval; deploys are refused until then">pending</span>';
    const officialBadge = isOfficial
      ? '<span class="app-badge" title="Published by the platform (the catalog deployer wallet)">★ official</span>' : "";
    const delistBadge = app.active ? ''
      : '<span class="app-badge del" title="Delisted: hidden from the public store; only you (its publisher) and the catalog owner see it. Relist to restore it, or publish a new version to this slug (that relists it automatically).">delisted</span>';
    this.querySelector(".app-badges").innerHTML = officialBadge + badge + apBadge + delistBadge;

    this.querySelector(".app-desc").innerHTML = app.description ? esc(app.description) : '<span class="dim">no description</span>';
    this.querySelector(".app-metaline").innerHTML =
      '<span title="publisher (msg.sender)">' + short(app.publisher) + '</span><span>·</span><span>' + app.versions.length + (app.versions.length === 1 ? ' version' : ' versions') + '</span>';

    const apLabel = (vv) => vv.approval === APPROVAL.rejected ? ' (rejected)' : vv.approval !== APPROVAL.approved ? ' (pending)' : '';
    const opts = app.versions.map((vv, idx) =>
      '<option value="' + idx + '"' + (idx === i ? ' selected' : '') + '>' + esc(vv.version) + (vv.verified ? ' ✓' : '') + (vv.yanked ? ' (yanked)' : '') + apLabel(vv) + '</option>').join('');
    const m = minPctsOf(v);
    this.querySelector(".app-verrow").innerHTML =
      '<span class="vlbl">version</span><select class="ver-select" aria-label="Version">' + opts + '</select>'
      + '<span title="exact specs this app declares (' + ((Number(v.vramMb) > 0 || Number(v.gpuGflops) > 0)
          ? (Math.round(Number(v.vramMb) / 102.4) / 10) + ' GB VRAM' + (Number(v.gpuGflops) > 0 ? ' / ' + (Number(v.gpuGflops) / 1000) + ' TFLOPS GPU' : '') + ', '
          : 'CPU-only, ')
        + Number(v.memMb) + ' MB RAM' + (Number(v.cpuGflops) > 0 ? ' / ' + Number(v.cpuGflops) + ' GFLOPS CPU' : '')
        + ') set the minimum deploy shares">min '
        + (m.gpuPct > 0 ? m.gpuPct + '% GPU · ' : 'CPU-only · ') + m.cpuPct + '% CPU</span>'
      + (v.ports ? '<span class="vlbl" title="firewall config: ports this version may bind">⛨ ' + esc(v.ports) + '</span>' : '')
      + (v.yanked ? '<span class="vyank">yanked</span>' : '');

    this.querySelector(".app-cid code").textContent = v.cid;

    this.querySelector(".app-actions").innerHTML =
      '<button class="btn btn-primary btn-sm" data-act="deploy" type="button"'
        + (!app.active ? ' disabled title="Delisted: the enclave refuses its CIDs; relist first"'
           : v.approval === APPROVAL.approved ? '' : ' disabled title="Deploys unlock once the catalog owner approves this version"') + '>Use in Deploy →</button>'
      + '<a class="btn btn-sm" href="' + gw + '" target="_blank" rel="noopener">fetch .wasm</a>'
      + (isPub ? '<button class="btn btn-sm" data-act="newver" type="button" title="Open the publish form pre-filled from this version (new file/CID required)">add version</button>' : '')
      + (isPub && !app.active ? '<button class="btn btn-sm" data-act="relist" type="button">relist</button>' : '')
      + (isPub && app.active ? '<button class="btn btn-sm" data-act="delist" type="button">delist</button>' : '')
      + (isPub && !v.yanked ? '<button class="btn btn-sm" data-act="yank" type="button">yank</button>' : '')
      + (isOwner ? '<button class="btn btn-sm" data-act="verify" data-v="' + (v.verified ? 0 : 1) + '" type="button">' + (v.verified ? 'unverify' : 'verify') + '</button>' : '')
      + (isOwner && v.approval !== APPROVAL.approved ? '<button class="btn btn-sm" data-act="approve" type="button">approve</button>' : '')
      + (isOwner && v.approval !== APPROVAL.rejected ? '<button class="btn btn-sm" data-act="reject" type="button">reject</button>' : '');

    if (!this._wired) {
      this._wired = true;
      this.addEventListener("change", (e) => {
        const sel = e.target.closest(".ver-select"); if (!sel) return;
        STORE.sel[this.app.appId] = parseInt(sel.value, 10);
        this.requestRender();
      });
      this.addEventListener("click", (e) => {
        const cp = e.target.closest(".app-cid .copybtn");
        if (cp){ const vv = this.app.versions[selIdx(this.app)]; copyText(vv ? vv.cid : "", cp); return; }
        const btn = e.target.closest("[data-act]"); if (!btn || btn.disabled) return;
        this.dispatch("card-action", { app: this.app, act: btn.dataset.act, idx: selIdx(this.app), verified: btn.dataset.v === "1" });
      });
    }
  }
}
register("c-app-card", AppCard);
