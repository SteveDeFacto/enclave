/* ============================================================
   <c-app-reviews> - the ratings block on an app's page: the
   average with its distribution, the write form (only for a
   wallet that actually ran the app), and the reviews themselves.

   Data flows IN through the `app` property; every wallet
   transaction flows OUT as a `review-action` event, so this
   component never touches a provider - the Apps page owns the
   one transaction router, exactly like `card-action`.

   Eligibility is the interesting part of the UI: the contract
   takes a review only from someone with a FUNDED deployment of
   the app, so the form's job before anything else is to find
   that receipt (core/reviews.js findReceipt) and, when there
   isn't one, say plainly why the form is closed.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, short } from "../../js/core/util.js";
import { Enclave } from "../../js/core/api.js";
import { revConfigured, REVIEW_MAX_BODY } from "../../js/core/chain.js";
import { REVIEWS, loadReviews, loadRevOwner, tallyOf, avgOf, myReview, starsHtml, findReceipt } from "../../js/core/reviews.js";

const PAGE = 5;                                   // reviews shown before "show more"
const stamp = (sec) => new Date(Number(sec) * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

class AppReviews extends EnclaveElement {
  static properties = { app: null };
  static templateUrl = new URL("./app-reviews.html", import.meta.url);

  constructor(){
    super();
    this._shown = PAGE;        // how many of the list are expanded
    this._draft = null;        // { stars, body } while the form is open (survives re-renders)
    this._receipt = null;      // { id } | { reason } for the connected wallet
    this._busy = false;        // a transaction is in flight
    this._for = null;          // which app the loads above belong to
  }

  /* The Apps page hands us the same `app` object on every repaint, so the
     property setter never fires - this block subscribes to its OWN reads
     instead (the review list lands well after the catalog does). */
  connectedCallback(){
    super.connectedCallback();
    if (this._subs) return;
    this._subs = [
      ["enclave:reviews", (e) => { const d = e.detail || {}; if (d.type !== "error" && (!d.appId || d.appId === this._for)) this.requestRender(); }],
      // a wallet switch changes whose review is "yours" and whose receipt counts
      ["enclave:wallet", () => { this._draft = null; this._receipt = null; this._findReceipt(); }],
    ];
    for (const [n, fn] of this._subs) document.addEventListener(n, fn);
  }
  disconnectedCallback(){
    super.disconnectedCallback();
    if (this._subs) for (const [n, fn] of this._subs) document.removeEventListener(n, fn);
    this._subs = null;
  }

  renderedCallback(){
    const app = this.app; if (!app) return;
    const sec = this.querySelector(".revs");
    // no contract in the address book = no ratings surface at all (rather
    // than an empty "0 reviews" block that looks like an unloved app)
    if (!revConfigured()){ sec.hidden = true; return; }
    sec.hidden = false;

    // an app switch (or first paint) resets the per-app state and reads
    if (this._for !== app.appId){
      this._for = app.appId;
      this._shown = PAGE; this._draft = null; this._receipt = null;
      loadReviews(app.appId).catch(() => {});
      loadRevOwner();
      this._findReceipt();
    }

    this._renderSummary(app);
    this._renderForm(app);
    this._renderList(app);
    this._wire();
  }

  /* ---- the average, and where it comes from ---- */
  _renderSummary(app){
    const t = tallyOf(app.appId), avg = avgOf(app.appId);
    const list = (REVIEWS.byApp[app.appId] || []).filter(r => !r.hidden);
    const loading = !REVIEWS.listAt[app.appId];
    if (!t.count){
      this.querySelector(".revs-summary").innerHTML = loading
        ? '<div class="loading" role="status">reading reviews from Base…</div>'
        : '<p class="revs-none">No reviews yet. If you’ve run this app, yours would be the first.</p>';
      return;
    }
    // Distribution: 5 down to 1, each bar a share of the visible reviews. The
    // count can arrive BEFORE the bodies do (the grid's talliesOf read is what
    // brought us here), and empty bars under a real count would read as "3
    // reviews, none of them any stars" - so hold the bars until the list lands.
    const bars = loading
      ? '<div class="loading" role="status">reading reviews from Base…</div>'
      : [5, 4, 3, 2, 1].map(n => list.filter(r => r.stars === n).length).map((c, i) =>
        '<div class="revs-bar"><span class="revs-bar-n">' + (5 - i) + '</span>'
        + '<span class="revs-bar-track"><span class="revs-bar-fill" style="width:' + ((c / t.count) * 100).toFixed(1) + '%"></span></span>'
        + '<span class="revs-bar-c">' + c + '</span></div>').join("");
    this.querySelector(".revs-summary").innerHTML =
      '<div class="revs-avg">'
        + '<div class="revs-avg-n">' + avg.toFixed(1) + '</div>'
        + starsHtml(avg, { cls: "stars-lg" })
        + '<div class="revs-avg-c">' + t.count + (t.count === 1 ? " review" : " reviews") + '</div>'
      + '</div>'
      + '<div class="revs-bars">' + bars + '</div>';
  }

  /* ---- the write form, or the reason there isn't one ---- */
  _renderForm(app){
    const host = this.querySelector(".revs-form");
    const mine = myReview(app.appId, Enclave.address);
    const r = this._receipt;

    if (!Enclave.address){
      host.innerHTML = '<p class="revs-gate">Only wallets that have run this app can review it. '
        + '<button class="btn btn-sm" data-act="connect" type="button">Connect wallet</button></p>';
      return;
    }
    if (!r){ host.innerHTML = '<p class="revs-gate dim">checking whether you’ve run this app…</p>'; return; }
    if (r.reason){ host.innerHTML = '<p class="revs-gate">' + esc(r.reason) + '</p>'; return; }

    const d = this._draft || { stars: mine ? mine.stars : 0, body: mine ? mine.body : "" };
    const pick = [1, 2, 3, 4, 5].map(n =>
      '<label class="revs-pick-star' + (d.stars >= n ? " on" : "") + '">'
      + '<input class="sr-only" type="radio" name="revStars" value="' + n + '"' + (d.stars === n ? " checked" : "") + '>'
      + '<span aria-hidden="true">★</span><span class="sr-only">' + n + (n === 1 ? " star" : " stars") + '</span></label>').join("");
    const left = REVIEW_MAX_BODY - new TextEncoder().encode(d.body || "").length;
    host.innerHTML =
      '<div class="revs-write">'
      + '<fieldset class="revs-pick"><legend>' + (mine ? "Update your rating" : "Your rating") + '</legend>' + pick + '</fieldset>'
      + '<label class="sr-only" for="revBody">Your review</label>'
      + '<textarea id="revBody" class="revs-body" rows="3" placeholder="What was it like to run? (optional)"></textarea>'
      + '<div class="revs-write-foot">'
        + '<span class="revs-count' + (left < 0 ? " over" : "") + '">' + left + ' left</span>'
        + '<span class="revs-receipt" title="the funded deployment that proves you ran this app">receipt ' + short(r.id) + '</span>'
        + '<button class="btn btn-primary btn-sm" data-act="post" type="button"'
          + (this._busy || !d.stars || left < 0 ? " disabled" : "") + '>'
          + (this._busy ? "signing…" : mine ? "Update review" : "Post review") + '</button>'
      + '</div></div>';
    // the textarea's value is set as a PROPERTY, never as markup: a draft that
    // round-trips through innerHTML would lose the caret on every keystroke
    const ta = this.querySelector(".revs-body");
    if (ta && ta.value !== (d.body || "")) ta.value = d.body || "";
  }

  /* ---- the reviews themselves ---- */
  _renderList(app){
    const host = this.querySelector(".revs-list");
    const all = REVIEWS.byApp[app.appId] || [];
    const me = (Enclave.address || "").toLowerCase();
    const isOwner = !!(REVIEWS.owner && me && me === REVIEWS.owner);
    // a hidden review is gone for readers; its AUTHOR still sees it (marked),
    // so a takedown never reads as "my review silently vanished", and the
    // catalog owner sees every one to be able to undo the call
    const list = all.filter(r => !r.hidden || isOwner || r.reviewer.toLowerCase() === me);
    if (!list.length){ host.innerHTML = ""; return; }

    const rows = list.slice(0, this._shown).map(r => {
      const own = r.reviewer.toLowerCase() === me;
      return '<article class="rev' + (r.hidden ? " hidden-rev" : "") + '">'
        + '<div class="rev-head">'
          + starsHtml(r.stars)
          + '<span class="rev-who' + (own ? " me" : "") + '" title="' + esc(r.reviewer) + '">' + (own ? "you" : short(r.reviewer)) + '</span>'
          + '<time class="rev-when" datetime="' + new Date(Number(r.createdAt) * 1000).toISOString() + '">' + stamp(r.createdAt) + '</time>'
          + (Number(r.updatedAt) > Number(r.createdAt) ? '<span class="rev-edited" title="edited ' + stamp(r.updatedAt) + '">edited</span>' : '')
          + (r.hidden ? '<span class="app-badge rej">hidden</span>' : '')
          + (isOwner ? '<button class="btn btn-sm rev-mod" data-act="' + (r.hidden ? "unhide" : "hide") + '" data-who="' + esc(r.reviewer) + '" type="button">'
              + (r.hidden ? "unhide" : "hide") + '</button>' : '')
        + '</div>'
        + (r.body ? '<p class="rev-body">' + esc(r.body) + '</p>' : '')
        + '</article>';
    }).join("");
    const more = list.length > this._shown
      ? '<button class="btn btn-sm revs-more" data-act="more" type="button">show ' + Math.min(PAGE, list.length - this._shown) + ' more</button>' : '';
    host.innerHTML = rows + more;
  }

  /* ---- one delegated listener per instance ---- */
  _wire(){
    if (this._wired) return;
    this._wired = true;
    this.addEventListener("input", (e) => {
      if (!e.target.closest(".revs-body")) return;
      this._draft = { stars: this._draftStars(), body: e.target.value };
      // repaint the counter + button state without touching the textarea
      const left = REVIEW_MAX_BODY - new TextEncoder().encode(this._draft.body).length;
      const c = this.querySelector(".revs-count");
      if (c){ c.textContent = left + " left"; c.classList.toggle("over", left < 0); }
      const b = this.querySelector('[data-act="post"]');
      if (b) b.disabled = this._busy || !this._draft.stars || left < 0;
    });
    this.addEventListener("change", (e) => {
      const s = e.target.closest('input[name="revStars"]'); if (!s) return;
      const ta = this.querySelector(".revs-body");
      this._draft = { stars: parseInt(s.value, 10), body: ta ? ta.value : "" };
      this.requestRender();
    });
    this.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]"); if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === "more"){ this._shown += PAGE; this.requestRender(); return; }
      if (act === "connect"){ this.dispatch("review-action", { act: "connect", app: this.app }); return; }
      if (act === "hide" || act === "unhide"){
        this.dispatch("review-action", { act, app: this.app, reviewer: btn.dataset.who, hidden: act === "hide" });
        return;
      }
      if (act === "post"){
        const ta = this.querySelector(".revs-body");
        const stars = this._draftStars();
        if (!stars || !this._receipt || !this._receipt.id) return;
        this.dispatch("review-action", { act: "post", app: this.app, stars,
          body: ta ? ta.value : "", deploymentId: this._receipt.id });
      }
    });
  }
  _draftStars(){
    const on = this.querySelector('input[name="revStars"]:checked');
    return on ? parseInt(on.value, 10) : (this._draft ? this._draft.stars : 0);
  }

  async _findReceipt(){
    const app = this.app; if (!app) return;
    const appId = app.appId;
    try {
      const r = await findReceipt(appId);
      if (this._for !== appId) return;                 // the page moved on mid-read
      this._receipt = r;
    } catch(e){
      if (this._for === appId) this._receipt = { reason: "Couldn’t check your eligibility right now." };
    }
    this.requestRender();
  }

  /* the Apps page calls these around a review transaction */
  setBusy(on){ this._busy = !!on; this.requestRender(); }
  clearDraft(){ this._draft = null; this.requestRender(); }
  recheckReceipt(){ this._receipt = null; this._findReceipt(); }
}
register("c-app-reviews", AppReviews);
