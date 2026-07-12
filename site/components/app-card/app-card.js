/* ============================================================
   <c-app-card> - one catalog listing, as a compact TILE: an
   optional thumbnail, the name, the status badges, and the
   description. Everything else (versions, specs, CID, deploy +
   owner/publisher actions) lives on the app's own page - the whole
   tile is a button that opens it. Data flows IN through the `app`
   property; the click flows OUT as a `card-action` {act:"open"}
   event (the LWC data-down/events-up pattern), which the Apps page
   turns into a navigation to apps?app=<appId>.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";
import { IPFS_IMG_GATEWAY } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { APPROVAL } from "../../js/core/chain.js";
import { STORE, selIdx, appOfficial, appMedia, placeholderArt } from "../../js/core/catalog.js";

class AppCard extends EnclaveElement {
  static properties = { app: null };
  static templateUrl = new URL("./app-card.html", import.meta.url);

  renderedCallback() {
    const app = this.app; if (!app) return;
    const i = selIdx(app);
    const v = app.versions[i] || { verified:false, yanked:false, approval:APPROVAL.pending };
    const isOfficial = appOfficial(app);

    const art = this.querySelector("article");
    art.className = "app-card" + (v.verified ? " verified" : "") + (app.active ? "" : " delisted");
    art.dataset.appid = app.appId;

    // thumbnail (from the default version's media); the band is always there -
    // fixed 16:9, generated placeholder when the app ships no art - so every
    // card is the same shape whether or not the publisher branded it
    const media = appMedia(app), thumb = this.querySelector(".app-thumb");
    thumb.hidden = false;
    thumb.style.backgroundImage = media.thumbnail
      ? "url('" + IPFS_IMG_GATEWAY + encodeURIComponent(media.thumbnail) + "')"
      : placeholderArt(app.appId || app.slug, app.name || app.slug);

    this.querySelector("h3").textContent = app.name;

    const badge = v.verified
      ? '<span class="app-badge" title="This version is marked verified by the catalog owner">✓ verified</span>'
      : (!STORE.owner || isOfficial) ? ''
      : '<span class="app-badge comm" title="Community-published; not owner-verified">community</span>';
    const apBadge = v.approval === APPROVAL.approved
      ? (isOfficial ? '' : '<span class="app-badge" title="Approved by the catalog owner; deployable">✓ approved</span>')
      : v.approval === APPROVAL.rejected
      ? '<span class="app-badge rej" title="Rejected by the catalog owner; deploys are refused">✕ rejected</span>'
      : '<span class="app-badge unv" title="Awaiting catalog-owner approval; deploys are refused until then">pending</span>';
    const officialBadge = isOfficial
      ? '<span class="app-badge" title="Published by Enclave Host, Inc. (the catalog deployer wallet)">★ by Enclave</span>' : "";
    const delistBadge = app.active ? ''
      : '<span class="app-badge del" title="Delisted: hidden from the public store; only you (its publisher) and the catalog owner see it.">delisted</span>';
    this.querySelector(".app-badges").innerHTML = officialBadge + badge + apBadge + delistBadge;

    this.querySelector(".app-desc").innerHTML = app.description ? esc(app.description) : '<span class="dim">no description</span>';

    if (!this._wired) {
      this._wired = true;
      const open = () => this.dispatch("card-action", { app: this.app, act: "open" });
      this.addEventListener("click", open);
      this.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
    }
  }
}
register("c-app-card", AppCard);
