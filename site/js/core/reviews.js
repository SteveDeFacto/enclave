/* ============================================================
   Reviews - read side of EnclaveReviews (1-5 stars + comments).

   Two reads, deliberately split by cost: the store grid asks for
   TALLIES (count + star sum for a whole page of apps in one
   eth_call), and only an app's own page pulls the review BODIES.
   A tile never fetches prose it won't show.

   The write side isn't here - posting is a wallet transaction the
   Apps page routes, same as every other on-chain action. What
   this module does own is the RECEIPT hunt: the contract only
   accepts a review from someone who funded a deployment of that
   app, so the form has to find that deployment before it can
   offer to sign anything (findReceipt below).

   No contract in the address book = no ratings anywhere; every
   entry point answers empty rather than guessing.
   ============================================================ */
import { revConfigured, revTallies, revGetReviews, revCanReview, revOwner } from "./chain.js";
import { parseCatalogRef } from "./catalog.js";
import { Enclave } from "./api.js";
import { emit, on, esc } from "./util.js";

export const REVIEWS = {
  tally: {},    // appId -> { count, sum }
  byApp: {},    // appId -> Review[] (one app's full list, newest first)
  at: {},       // appId -> when its tally last landed
  listAt: {},   // appId -> when its list last landed
  owner: null,  // EnclaveReviews.owner - the only wallet that can hide one
};

/* The moderator is THIS contract's owner, which is not automatically the
   catalog's owner (separate deploys, separate handoffs) - so the hide buttons
   ask the reviews contract who it obeys rather than assuming. */
let _ownerRun = null;
export function loadRevOwner(){
  if (!revConfigured() || REVIEWS.owner || _ownerRun) return _ownerRun;
  _ownerRun = revOwner().then(o => {
    REVIEWS.owner = (o || "").toLowerCase();
    _ownerRun = null;
    emit("enclave:reviews", { type: "owner" });
  }).catch(() => { _ownerRun = null; });
  return _ownerRun;
}
const FRESH_MS = 120000;
const BATCH = 200;            // appIds per talliesOf call - one page of the store is ~20
const _inflight = new Set();  // appIds already being read (the grid repaints more often than the chain moves)

/* ---- tallies: the grid's rating column ---- */
export async function loadTallies(appIds, force){
  if (!revConfigured() || !appIds || !appIds.length) return;
  const now = Date.now();
  // de-dupe against BOTH the cache and reads already in the air - paging fast
  // must never drop a page's read on the floor, and must never double-fetch one
  const want = [...new Set(appIds)].filter(id => !_inflight.has(id) && (force || !(REVIEWS.at[id] > now - FRESH_MS)));
  if (!want.length) return;
  want.forEach(id => _inflight.add(id));
  try {
    for (let s = 0; s < want.length; s += BATCH){
      const chunk = want.slice(s, s + BATCH);
      const rows = await revTallies(chunk);
      // an app nobody reviewed still gets a stamp, or it re-reads forever
      for (const id of chunk){ REVIEWS.tally[id] = REVIEWS.tally[id] || { count: 0, sum: 0 }; REVIEWS.at[id] = Date.now(); }
      for (const r of rows) REVIEWS.tally[r.appId] = { count: r.count, sum: r.sum };
    }
    emit("enclave:reviews", { type: "tallies" });
  } catch(e){
    // ratings are an ornament on the grid: a failed read leaves the tiles
    // unrated rather than breaking the store (which is the actual product)
    emit("enclave:reviews", { type: "error", message: e.message || String(e) });
  }
  want.forEach(id => _inflight.delete(id));
}

/* ---- one app's reviews, for its page ---- */
export async function loadReviews(appId, force){
  if (!revConfigured() || !appId) return [];
  if (!force && REVIEWS.byApp[appId] && REVIEWS.listAt[appId] > Date.now() - FRESH_MS) return REVIEWS.byApp[appId];
  try {
    const list = await revGetReviews(appId);
    list.sort((a, b) => b.updatedAt - a.updatedAt);            // freshest first
    REVIEWS.byApp[appId] = list;
    REVIEWS.listAt[appId] = Date.now();
    // the list is authoritative for THIS app - keep the tile's tally in step
    // (it counts only what readers see, exactly like the contract's)
    const vis = list.filter(r => !r.hidden);
    REVIEWS.tally[appId] = { count: vis.length, sum: vis.reduce((n, r) => n + r.stars, 0) };
    REVIEWS.at[appId] = Date.now();
    emit("enclave:reviews", { type: "list", appId });
    return list;
  } catch(e){
    emit("enclave:reviews", { type: "error", appId, message: e.message || String(e) });
    throw e;
  }
}

/* ---- derived ---- */
export const tallyOf = (appId) => REVIEWS.tally[appId] || { count: 0, sum: 0 };
// average as a number, or null when nobody has rated it (0 would be a lie -
// the scale starts at 1, so "no rating" and "bad rating" must not look alike)
export function avgOf(appId){
  const t = tallyOf(appId);
  return t.count ? t.sum / t.count : null;
}
export const myReview = (appId, address) => {
  const me = (address || "").toLowerCase();
  return me ? (REVIEWS.byApp[appId] || []).find(r => r.reviewer.toLowerCase() === me) || null : null;
};

/* Five stars with a fractional fill: an overlay clipped to the average's
   percentage, so 4.3 reads as 4.3 and not as "4" or "4.5". One element in the
   a11y tree carries the number - the glyphs themselves are decorative. */
export function starsHtml(avg, opts){
  const o = opts || {};
  const pct = avg == null ? 0 : Math.max(0, Math.min(100, (avg / 5) * 100));
  // "5 out of 5" for one review's whole-number rating, "4.3 out of 5" for an
  // average - the screen-reader label shouldn't invent a decimal
  const label = avg == null ? "not rated yet"
    : (Number.isInteger(avg) ? String(avg) : avg.toFixed(1)) + " out of 5 stars";
  return '<span class="stars' + (o.cls ? " " + o.cls : "") + '" role="img" aria-label="' + esc(label) + '">'
       + '<span class="stars-off" aria-hidden="true">★★★★★</span>'
       + '<span class="stars-on" aria-hidden="true" style="width:' + pct.toFixed(2) + '%">★★★★★</span>'
       + '</span>';
}

/* ---- the receipt: which of my deployments proves I ran this app? ----
   EnclaveReviews takes a deployment id and checks it itself (owner, app,
   funded). We just have to FIND one: the ledger rows for the connected wallet
   are public, so this needs no session - a connected address is enough.
   Returns { id, label } or { reason } - the reason is shown in place of the
   form, because "you can't review this" is only fair if it says why. */
const _receipt = {};        // (address|appId) -> { id } | { reason }
export async function findReceipt(appId, opts){
  const me = (Enclave.address || "").toLowerCase();
  if (!me) return { reason: "Connect the wallet you deployed with to review this app." };
  const key = me + "|" + appId;
  if (!(opts && opts.force) && _receipt[key]) return _receipt[key];
  let rows;
  try {
    const res = await Enclave.listDeployments();
    rows = Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || []);
  } catch(e){
    // don't cache a transport failure as a refusal
    return { reason: "Couldn’t read your deployments to check eligibility (" + (e.message || e) + ")." };
  }
  const mine = rows.filter(d => {
    const cr = parseCatalogRef(d && d.image && d.image.reference);
    return cr && cr.appId.toLowerCase() === String(appId).toLowerCase();
  });
  // funded is the test the contract applies (creating a record costs only
  // gas); paidUsdc is balance + spent, so a finished deployment still counts
  const paid = mine.filter(d => parseFloat(d.paidUsdc || "0") > 0)
                   .sort((a, b) => parseFloat(b.paidUsdc || "0") - parseFloat(a.paidUsdc || "0"));
  const out = paid.length ? { id: paid[0].id, label: paid[0].id }
    : mine.length ? { reason: "You created a deployment of this app but never funded it - reviews come from people who ran it." }
    : { reason: "Only wallets that have run this app can review it. Deploy it first; your deployment is the receipt." };
  _receipt[key] = out;
  return out;
}
// ask the contract itself before we put a wallet through a signature (the
// local hunt can be right about the deployment and still wrong about, say, a
// repointed ledger - the chain is the authority)
export async function confirmReceipt(appId, deploymentId){
  try { return await revCanReview(appId, deploymentId, Enclave.address); }
  catch(e){ return false; }
}
export function forgetReceipts(){ for (const k of Object.keys(_receipt)) delete _receipt[k]; }

// a mid-session address-book change (contract deployed/repointed) drops
// everything read from the OLD address
on("enclave:addresses", ({ changed }) => {
  if (changed && changed.indexOf("REVIEWS_ADDRESS") !== -1){
    REVIEWS.tally = {}; REVIEWS.byApp = {}; REVIEWS.at = {}; REVIEWS.listAt = {}; REVIEWS.owner = null;
    emit("enclave:reviews", { type: "reset" });
  }
});
// a wallet switch changes who "my review" and the receipt belong to
on("enclave:wallet", () => forgetReceipts());
