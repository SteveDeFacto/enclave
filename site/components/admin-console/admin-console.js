/* ============================================================
   <c-admin-console> - the operator console behind admin.html.

   Replicates every governance transaction the terminal scripts
   perform (deploy-*.mjs, update-address-book.mjs, set-prices.mjs)
   plus the owner functions no script ever covered (payout/feed/
   lease setters, operator rotation, ownership handoffs), all
   signed by the connected wallet. Reads use the public RPC pool;
   a write is only ENABLED when the connected wallet matches that
   contract's owner/admin read live from the chain - and the chain
   enforces it regardless.

   Contract bytecode + selectors come from js/gen/contract-artifacts.js
   (generated from contracts/*.sol by scripts/build-contract-artifacts.mjs
   with the deploy scripts' exact solc settings), so a browser deploy
   produces the same code a terminal deploy would.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { Enclave } from "../../js/core/api.js";
import { connectWallet, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { baseRpc, waitReceipt, encCall, encAddr, hexBig, decodeStructArray, CAMPAIGN_SCHEMA } from "../../js/core/chain.js";
import { ADDRESS_BOOK_ADDRESS, USDC_BASE, DEFAULT_API_BASE } from "../../js/core/config.js";
import { esc, on, short, showToast } from "../../js/core/util.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";
import { MIG_KINDS, importState, sealTx } from "./migrate.js";

const EXPLORER = "https://basescan.org";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x" + "0".repeat(40);
const KEY_RE = /^[A-Za-z0-9_-]{1,31}$/;

/* the book panel's row order; other (custom) keys found on-chain follow */
const BOOK_KEYS = ["registry", "deployments", "appCatalog", "enclavePay", "featured", "reviews"];

const lc = (a) => (a || "").toLowerCase();
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const perHr = (p6) => "$" + (Number(p6) * 3600 / 1e6).toFixed(4) + "/hr";
const mono = (a) => `<span class="ac-addr" title="${esc(a)}">${esc(a)}</span>`;
const encKey = (k) => { let h = ""; for (const ch of k) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return "0x" + h.padEnd(64, "0"); };
const friendly = (e) => (e && (e.code === 4001 || /reject|denied|declin|cancell/i.test(e.message || ""))) ? "cancelled in the wallet" : (e.message || String(e));

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const rdAddr = async (to, sel) => { const r = await call(to, "0x" + sel); return "0x" + (r || "").replace(/^0x/, "").slice(-40).padStart(40, "0"); };
const rdUint = async (to, sel) => hexBig((await call(to, "0x" + sel)) || "0x0");
// Soft address read: a selector the DEPLOYED bytecode may not implement yet
// (e.g. pendingOwner on a contract still on its pre-two-step
// revision — which is every contract until it is redeployed) reverts. Treat
// that as "unset" (ZERO) instead of rejecting and blanking the whole console.
const rdAddrSoft = async (to, sel) => { try { return await rdAddr(to, sel); } catch { return ZERO; } };
// null = the getter isn't in the deployed contract (a pre-cap rev): the row
// paints as unsupported instead of the whole panel dying on one revert
const rdUintSoft = async (to, sel) => { try { const r = await call(to, "0x" + sel); return (!r || r === "0x") ? null : hexBig(r); } catch { return null; } };

/* decode all() -> { key: address } (skips zero/retired entries) */
function decodeBook(hex) {
  const b = (hex || "").replace(/^0x/, "");
  if (b.length < 128) return {};
  const word = (i) => b.slice(i * 64, i * 64 + 64);
  const num = (i) => parseInt(word(i).slice(48), 16);
  const kOff = num(0) / 32, vOff = num(1) / 32, n = num(kOff), out = {};
  for (let i = 0; i < n; i++) {
    const kw = word(kOff + 1 + i); let key = "";
    for (let j = 0; j < 64; j += 2) { const c = parseInt(kw.slice(j, j + 2), 16); if (!c) break; key += String.fromCharCode(c); }
    const a = "0x" + word(vOff + 1 + i).slice(24);
    if (key && !isZero(a)) out[key] = a;
  }
  return out;
}

class AdminConsole extends EnclaveElement {
  static templateUrl = new URL("./admin-console.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._root = this.querySelector("#acRoot");
    on("enclave:wallet", () => this._evaluate());
    this._evaluate();
  }

  /* The page renders NOTHING unless the connected wallet is the address
     book's owner - read live, fail closed (RPC trouble = locked; the next
     wallet event retries). This is presentation only: the real gate is every
     contract's own owner check, which the chain enforces on each write. */
  async _evaluate() {
    const me = lc(Enclave.address);
    const seq = this._evSeq = (this._evSeq || 0) + 1;
    if (!me || !ADDRESS_BOOK_ADDRESS) return this._lock();
    if (!this._bookOwner) {
      try { this._bookOwner = await rdAddr(ADDRESS_BOOK_ADDRESS, CONTRACTS.EnclaveAddressBook.sel.owner); }
      catch (e) { return this._lock(); }
      if (seq !== this._evSeq) return;                 // superseded by a newer wallet event
    }
    if (isZero(this._bookOwner) || lc(this._bookOwner) !== me) return this._lock();
    this._unlock();
  }

  _lock() {
    this._unlocked = false;
    this._root.innerHTML = "";
    this._body = this._note = null;
  }

  _unlock() {
    if (this._unlocked) { this._paintSigner(); this._gate(); return; }
    this._unlocked = true;
    this._root.innerHTML = `
      <div class="sec-head">
        <span class="eyebrow">Operator console</span>
        <h2>Platform governance, signed by your wallet.</h2>
        <p>Every owner transaction the contract scripts run from a terminal - deploys, address-book updates, prices, payout and operator rotation - sent from this wallet instead of a pasted private key. Each contract's owner is checked live; the chain enforces it again on every write.</p>
      </div>
      <div class="ac-signer" id="acSigner"></div>
      <div class="ac-note" id="acNote">reading the platform contracts…</div>
      <div id="acBody" hidden></div>`;
    this._body = this.querySelector("#acBody");
    this._note = this.querySelector("#acNote");
    this._body.addEventListener("click", (e) => this._onClick(e));
    this._body.addEventListener("input", (e) => this._onInput(e));
    this._body.addEventListener("change", (e) => { if (e.target.id === "migKind") this._migPrefill(); });
    this.refresh();
  }

  async refresh() {
    if (!this._unlocked) return;
    this._paintSigner();
    try {
      const S = this.S = { book: { addr: ADDRESS_BOOK_ADDRESS, owner: null, entries: {} } };
      if (!S.book.addr) { this._note.textContent = "no ADDRESS_BOOK_ADDRESS is configured - deploy the book first (scripts/deploy-address-book.mjs)."; return; }
      const bookSel = CONTRACTS.EnclaveAddressBook.sel;
      const [allHex, bookOwner, bookPending] = await Promise.all([call(S.book.addr, "0x" + bookSel.all), rdAddr(S.book.addr, bookSel.owner), rdAddrSoft(S.book.addr, bookSel.pendingOwner)]);
      S.book.owner = bookOwner;
      S.book.pending = bookPending;
      S.book.entries = decodeBook(allHex);
      const E = S.book.entries;

      const dep = E.deployments, cat = E.appCatalog, pay = E.enclavePay, feat = E.featured, rev = E.reviews;
      const dSel = CONTRACTS.EnclaveDeployments.sel, pSel = CONTRACTS.EnclavePay.sel, fSel = CONTRACTS.EnclaveFeatured.sel,
            rSel = CONTRACTS.EnclaveReviews.sel;
      // the featured campaign list + the gateway's view counter (both soft:
      // a fresh deploy has no campaigns, the relay may not be updated yet)
      const readCampaigns = async () => {
        const n = Number(await rdUint(feat, fSel.campaignCount));
        const out = [];
        for (let s = 0; s < n; s += 100)
          out.push(...decodeStructArray(await call(feat, encCall(fSel.getCampaignsPage, [{ t: "uint", v: s }, { t: "uint", v: 100 }])), CAMPAIGN_SCHEMA));
        return out;
      };
      [S.dep, S.cat, S.pay, S.feat, S.rev] = await Promise.all([
        dep ? Promise.all([rdAddr(dep, dSel.owner), rdAddr(dep, dSel.payout), rdUint(dep, dSel.pricePerSec6), rdUint(dep, dSel.cpuPricePerSec6), rdUint(dep, dSel.leaseSec), rdAddr(dep, dSel.ethUsdFeed), rdAddrSoft(dep, dSel.pendingOwner), rdUintSoft(dep, dSel.maxGpuMilli), rdUintSoft(dep, dSel.maxFeePerSec6)])
              .then(([owner, payout, gpu, cpu, lease, feed, pending, maxGpu, maxFee]) => ({ addr: dep, owner, payout, gpu, cpu, lease, feed, pending, maxGpu, maxFee })) : null,
        cat ? Promise.all([rdAddr(cat, CONTRACTS.EnclaveAppCatalog.sel.owner), rdAddrSoft(cat, CONTRACTS.EnclaveAppCatalog.sel.pendingOwner), rdUintSoft(cat, CONTRACTS.EnclaveAppCatalog.sel.maxFeePerSec6)])
              .then(([owner, pending, maxFee]) => ({ addr: cat, owner, pending, maxFee })) : null,
        pay ? Promise.all([rdAddr(pay, pSel.owner), rdAddr(pay, pSel.payout), rdAddr(pay, pSel.usdc), rdAddrSoft(pay, pSel.pendingOwner)])
              .then(([owner, payout, usdc, pending]) => ({ addr: pay, owner, payout, usdc, pending })) : null,
        feat ? Promise.all([rdAddr(feat, fSel.owner), rdAddr(feat, fSel.payout), rdUint(feat, fSel.maxBidPerView6), rdAddrSoft(feat, fSel.pendingOwner),
                            readCampaigns().catch(() => []),
                            fetch(DEFAULT_API_BASE + "/featured-views").then((r) => r.json()).then((j) => j.views || {}).catch(() => null)])
              .then(([owner, payout, maxBid, pending, campaigns, views]) => ({ addr: feat, owner, payout, maxBid, pending, campaigns, views })) : null,
        rev ? Promise.all([rdAddr(rev, rSel.owner), rdAddrSoft(rev, rSel.pendingOwner),
                           rdAddr(rev, rSel.ledger), rdAddr(rev, rSel.ledgerFallback), rdAddr(rev, rSel.book)])
              .then(([owner, pending, ledger, fallback, revBook]) => ({ addr: rev, owner, pending, ledger, fallback, revBook })) : null,
      ]);
      this._note.hidden = true;
      this._paint();
    } catch (e) {
      this._note.hidden = false;
      this._note.textContent = "chain read failed: " + (e.message || e) + " - retry below.";
      this._body.hidden = false;
      this._body.innerHTML = `<button class="btn btn-sm" data-act="refresh">Retry</button>`;
    }
  }

  /* ---------- painting ---------- */

  _paintSigner() {
    const el = this.querySelector("#acSigner");
    const me = lc(Enclave.address);
    if (!el || !me) return;                        // locked (or mid-lock repaint): nothing to paint
    const chips = [];
    const chip = (label, ownerAddr) => {
      if (!ownerAddr) return;
      const ok = lc(ownerAddr) === me;
      chips.push(`<span class="ac-chip ${ok ? "ok" : "no"}" title="${esc(ownerAddr)}">${esc(label)} ${ok ? "✓" : "✗"}</span>`);
    };
    const S = this.S || {};
    chip("book", S.book && S.book.owner);
    chip("deployments", S.dep && S.dep.owner);
    chip("catalog", S.cat && S.cat.owner);
    chip("pay", S.pay && S.pay.owner);
    chip("featured", S.feat && S.feat.owner);
    chip("reviews", S.rev && S.rev.owner);
    el.innerHTML = `<span class="ac-who">signing as <b class="ac-addr">${esc(Enclave.address)}</b></span>${chips.join("")}
      <button class="btn btn-sm ac-refresh" data-refresh>↻ Refresh</button>`;
    const r = el.querySelector("[data-refresh]");
    if (r) r.addEventListener("click", () => this.refresh());
  }

  _row(label, current, act, opts = {}) {
    const id = act.replace(/[^a-z0-9]/gi, "");
    return `<div class="ac-row">
      <div class="ac-lbl" id="lbl-${id}">${label}${opts.hint ? `<span class="ac-hint">${opts.hint}</span>` : ""}</div>
      <div class="ac-cur">${current}</div>
      <input class="ac-in" id="in-${id}" data-for="${act}" aria-labelledby="lbl-${id}" type="text" placeholder="${esc(opts.placeholder || "0x…")}" spellcheck="false" autocomplete="off" />
      <span class="ac-live" id="live-${id}"></span>
      <button class="btn btn-sm ac-apply" data-act="${act}" data-owner="${esc(opts.owner || "")}">${esc(opts.verb || "Set")}</button>
    </div>`;
  }

  _paint() {
    const S = this.S;
    const me = lc(Enclave.address);   // connected wallet — used by the danger-zone Accept affordance
    const sec = (title, sub, inner) => `<section class="ac-panel">
      <h3>${title}</h3>${sub ? `<p class="ac-sub">${sub}</p>` : ""}${inner}
      <div class="ac-status" role="status" aria-live="polite" hidden></div>
    </section>`;
    const link = (a) => `<a href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
    const parts = [];

    /* -- address book -- */
    {
      const E = S.book.entries;
      const keys = [...BOOK_KEYS, ...Object.keys(E).filter((k) => !BOOK_KEYS.includes(k))];
      const rows = keys.map((k) => this._row(
        `<code>${esc(k)}</code>`,
        E[k] ? mono(E[k]) : `<span class="dim">(unset)</span>`,
        "book-set:" + k, { owner: S.book.owner, verb: "Set" })).join("");
      const custom = `<div class="ac-row ac-row-new">
        <input class="ac-in ac-in-key" id="newBookKey" aria-label="New address-book key" type="text" placeholder="new key (ascii, ≤31)" spellcheck="false" />
        <span></span>
        <input class="ac-in" id="newBookVal" aria-label="Value" type="text" placeholder="0x…" spellcheck="false" />
        <span></span>
        <button class="btn btn-sm" data-act="book-set-new" data-owner="${esc(S.book.owner)}">Add key</button>
      </div>`;
      parts.push(sec(`Address book · ${link(S.book.addr)}`,
        `The platform's one on-chain root - enclaves, this site, the relays, and the CLI re-resolve every address from it within ≤5 min of a change. Owner ${mono(S.book.owner)}. Setting a key to the zero address retires it (readers keep their baked fallback).`,
        rows + custom));
    }

    /* -- deployments -- */
    if (S.dep) {
      const d = S.dep;
      parts.push(sec(`EnclaveDeployments · ${link(d.addr)}`,
        `Prices are µUSDC per second for a FULL card / node; existing deployments keep the rate they were created at. Owner ${mono(d.owner)}.`,
        this._row("GPU price <code>setPrice</code>", `${d.gpu} <span class="dim">(≈ ${perHr(d.gpu)})</span>`, "dep-gpu", { owner: d.owner, placeholder: String(d.gpu), hint: "µUSDC/s" }) +
        this._row("CPU price <code>setCpuPrice</code>", `${d.cpu} <span class="dim">(≈ ${perHr(d.cpu)})</span>`, "dep-cpu", { owner: d.owner, placeholder: String(d.cpu), hint: "µUSDC/s" }) +
        (d.maxGpu == null
          ? `<div class="ac-row"><div class="ac-lbl">GPU share cap <code>setMaxGpuMilli</code></div><div class="ac-cur"><span class="dim">not in this contract rev — redeploy EnclaveDeployments to enable the cap</span></div><span></span><span></span><span></span></div>`
          : this._row("GPU share cap <code>setMaxGpuMilli</code>", `${d.maxGpu} <span class="dim">(${Number(d.maxGpu) / 10}% of a card max per NEW deployment; existing records untouched)</span>`, "dep-maxgpu", { owner: d.owner, placeholder: String(d.maxGpu), hint: "0…1000 milli" })) +
        (d.maxFee == null
          ? `<div class="ac-row"><div class="ac-lbl">Publisher fee cap <code>setMaxFee</code></div><div class="ac-cur"><span class="dim">not in this contract rev — redeploy EnclaveDeployments to enable publisher fees</span></div><span></span><span></span><span></span></div>`
          : this._row("Publisher fee cap <code>setMaxFee</code>", `${d.maxFee} <span class="dim">(≈ ${perHr(d.maxFee)} max per NEW deployment's fee snapshot; keep in lockstep with the catalog's cap)</span>`, "dep-maxfee", { owner: d.owner, placeholder: String(d.maxFee), hint: "µUSDC/s" })) +
        this._row("Lease <code>setLeaseSec</code>", `${d.lease}s`, "dep-lease", { owner: d.owner, placeholder: String(d.lease), hint: "60…86400 s" }) +
        this._row("ETH/USD feed <code>setEthUsdFeed</code>", isZero(d.feed) ? `<span class="dim">disabled (0x0)</span>` : mono(d.feed), "dep-feed", { owner: d.owner, hint: "0x0 disables ETH funding" }) +
        this._row("Payout <code>setPayout</code>", mono(d.payout), "dep-payout", { owner: d.owner })));
    } else parts.push(sec("EnclaveDeployments", `<span class="warn">not in the address book</span> - deploy one below, or set the <code>deployments</code> key.`, ""));

    /* -- pay -- */
    if (S.pay) {
      parts.push(sec(`EnclavePay · ${link(S.pay.addr)}`,
        `The gasless-funding forwarder. USDC ${mono(S.pay.usdc)} (immutable). Owner ${mono(S.pay.owner)}.`,
        this._row("Payout <code>setPayout</code>", mono(S.pay.payout), "pay-payout", { owner: S.pay.owner })));
    }


    /* -- featured slot -- */
    if (S.feat) {
      const f = S.feat;
      const perK = (b) => "$" + (Number(b) * 1000 / 1e6).toFixed(2);
      const usd = (b) => "$" + (Number(b) / 1e6).toFixed(2);
      const rows = (f.campaigns || []).map((c) => {
        const views = f.views ? (f.views[c.appId] || 0) : null;
        const settledEst = c.bidPerView6 > 0 ? Math.floor(Number(c.spent6) / Number(c.bidPerView6)) : 0;
        const suggest = views == null ? "" : Math.max(0, views - settledEst);
        const id = "featsettle" + c.appId.slice(2, 10);
        return `<div class="ac-row">
          <div class="ac-lbl" id="lbl-${id}"><code title="${esc(c.appId)}">${esc(short(c.appId))}</code> by ${esc(short(c.advertiser))}
            <span class="ac-hint">${c.active ? "active" : "PAUSED"} · <button class="btn btn-sm" data-act="feat-active:${esc(c.appId)}:${c.active ? 0 : 1}" data-owner="${esc(f.owner)}">${c.active ? "pause" : "resume"}</button></span></div>
          <div class="ac-cur">${perK(c.bidPerView6)}/1k · bal ${usd(c.balance6)} · spent ${usd(c.spent6)}${views == null ? "" : ` · <b>${views}</b> lifetime views (≈${settledEst} settled)`}</div>
          <input class="ac-in" id="in-${id}" data-for="feat-settle:${esc(c.appId)}" aria-labelledby="lbl-${id}" type="text" placeholder="views to settle" value="${suggest}" spellcheck="false" autocomplete="off" />
          <span class="ac-live" id="live-${id}"></span>
          <button class="btn btn-sm ac-apply" data-act="feat-settle:${esc(c.appId)}" data-owner="${esc(f.owner)}">Settle</button>
        </div>`;
      }).join("");
      parts.push(sec(`EnclaveFeatured · ${link(f.addr)}`,
        `The store's featured slot: per-view campaigns escrow USDC; settle a metered view count to draw bid × views to the payout (capped at the escrow - the meter can only ever under-charge). Lifetime views come from the gateway (${esc(DEFAULT_API_BASE)}/featured-views); "≈ settled" assumes the bid hasn't changed. Owner ${mono(f.owner)}.`,
        this._row("Bid cap <code>setMaxBid</code>", `${f.maxBid} <span class="dim">(µUSDC per view · ${perK(f.maxBid)}/1k max)</span>`, "feat-maxbid", { owner: f.owner, placeholder: String(f.maxBid), hint: "µUSDC/view" }) +
        this._row("Payout <code>setPayout</code>", mono(f.payout), "feat-payout", { owner: f.owner }) +
        (rows || `<div class="ac-row"><div class="ac-lbl">Campaigns</div><div class="ac-cur"><span class="dim">none yet - publishers open them from the Apps page ("Promote your app")</span></div><span></span><span></span><span></span></div>`)));
    }

    /* -- reviews -- */
    if (S.rev) {
      const r = S.rev;
      // the receipt gate resolves its ledger THROUGH the book on every call,
      // so it can't drift; what's worth surfacing is WHICH source answered -
      // falling back means the book's `deployments` key is unset/zero
      const viaBook = !isZero(r.revBook) && S.dep && lc(r.ledger) === lc(S.dep.addr);
      parts.push(sec(`EnclaveReviews · ${link(r.addr)}`,
        `1-5 star ratings with comments. A review is only accepted from a wallet with a FUNDED deployment of that app - so ratings come from people who ran the app. Per-review moderation (hide / unhide) lives on the <a href="apps">Apps page</a> when you browse an app with the owner wallet; it isn't duplicated here. Hiding drops a review from the average and keeps its bytes on-chain. Owner ${mono(r.owner)}.`,
        `<div class="ac-row"><div class="ac-lbl">Receipt ledger <code>ledger()</code></div>
          <div class="ac-cur">${mono(r.ledger)} ${viaBook
            ? `<span class="dim">· follows the address book, no action needed</span>`
            : `<b class="ac-warn">· via the fallback (the book's <code>deployments</code> key is unset)</b>`}</div>
          <span></span><span></span><span></span></div>` +
        this._row("Ledger fallback <code>setLedgerFallback</code>",
          `${isZero(r.fallback) ? `<span class="dim">(unset)</span>` : mono(r.fallback)} <span class="dim">(used only when the book can't answer)</span>`,
          "rev-fallback", { owner: r.owner, placeholder: (S.dep && S.dep.addr) || "0x…" })));
    }

    /* -- catalog pointer -- */
    if (S.cat) {
      parts.push(sec(`EnclaveAppCatalog · ${link(S.cat.addr)}`,
        `Owner ${mono(S.cat.owner)}. Moderation (approve / reject / verify / delist) already lives on the <a href="apps">Apps page</a> when you browse it with the owner wallet - it isn't duplicated here.`,
        S.cat.maxFee == null
          ? `<div class="ac-row"><div class="ac-lbl">Publisher fee cap <code>setMaxFee</code></div><div class="ac-cur"><span class="dim">not in this contract rev — redeploy EnclaveAppCatalog to enable publisher fees</span></div><span></span><span></span><span></span></div>`
          : this._row("Publisher fee cap <code>setMaxFee</code>", `${S.cat.maxFee} <span class="dim">(≈ ${perHr(S.cat.maxFee)} max per NEW version at publish; released versions keep their fee)</span>`, "cat-maxfee", { owner: S.cat.owner, placeholder: String(S.cat.maxFee), hint: "µUSDC/s" })));
    }

    /* -- deploy cards -- */
    {
      // Every constructor argument this console can already answer from the
      // chain is filled in - hand-pasting a known address is just a chance to
      // paste the wrong one. Each entry falls back to a sibling contract's
      // value when the contract being replaced isn't deployed yet.
      const payoutAddr = (S.dep && S.dep.payout) || (S.pay && S.pay.payout) || (S.feat && S.feat.payout);
      const pre = {
        EnclavePay: { usdc: USDC_BASE, payout: (S.pay && S.pay.payout) || payoutAddr },
        EnclaveDeployments: { usdc: USDC_BASE, payout: payoutAddr, registry: S.book.entries.registry, ethUsdFeed: S.dep && S.dep.feed },
        EnclaveFeatured: { usdc: USDC_BASE, payout: (S.feat && S.feat.payout) || payoutAddr },
        EnclaveReviews: { book: S.book.addr, ledgerFallback: S.book.entries.deployments || (S.dep && S.dep.addr) },
      };
      const notes = {
        EnclaveAddressBook: `<span class="warn">redeploying the book replaces the ONE address baked into every component</span> - that path needs the config/site/CLI rebake + a release + a dashboard update. Use <code>scripts/deploy-address-book.mjs</code> instead unless you know exactly why.`,
        EnclaveRegistry: `EnclaveDeployments pins the registry it trusts at construction - after a registry redeploy, redeploy EnclaveDeployments too (pointed at the new registry), then update both book keys.`,
        EnclaveDeployments: `deploys with the source-default prices - adjust in the panel above after pointing the book. Existing deployments live on in the OLD contract; users top up there until they redeploy.`,
        EnclaveReviews: `resolves the ledger it checks receipts against through the BOOK on every call, so a later EnclaveDeployments redeploy needs nothing here. <code>ledgerFallback</code> is only consulted when the book has no <code>deployments</code> key.`,
      };
      const cards = Object.keys(CONTRACTS).map((name) => {
        const c = CONTRACTS[name];
        const p = pre[name] || {};
        const inputs = c.ctor.map((a) => `<label class="ac-ctor-l">${esc(a.name)} <span class="ac-hint">${esc(a.type)}</span>
          <input class="ac-in ac-ctor" data-ctor="${esc(a.name)}" type="text" value="${esc(p[a.name] || "")}" placeholder="0x…" spellcheck="false" /></label>`).join("");
        return `<div class="ac-card" data-card="${esc(name)}">
          <h4>${esc(name)}<span class="ac-hint">${(c.bytecode.length / 2 - 1).toLocaleString()} bytes${c.bookKey ? ` · book key <code>${esc(c.bookKey)}</code>` : " · not a book entry"}</span></h4>
          ${notes[name] ? `<p class="ac-sub">${notes[name]}</p>` : ""}
          ${inputs || `<p class="ac-sub dim">no constructor arguments - the deployer becomes ${name === "EnclaveRegistry" ? "(no owner - open registration)" : "owner"}.</p>`}
          <button class="btn btn-primary btn-sm" data-act="deploy:${esc(name)}">Deploy ${esc(name)}</button>
          <div class="ac-deploy-out" hidden></div>
          <div class="ac-status" role="status" aria-live="polite" hidden></div>
        </div>`;
      }).join("");
      parts.push(`<section class="ac-panel"><h3>Deploy a contract</h3>
        <p class="ac-sub">Compiled from <code>contracts/*.sol</code> at site build time with the deploy scripts' exact solc settings; the deploy is a raw creation transaction from your wallet. After it confirms, point the address book at the new contract in one click - the whole platform follows within a poll. Then refresh the repo's baked fallbacks when convenient: paste the new address into <code>enclaves/gpu/tinfoil-config.yml</code> (catalog: <code>site/js/core/config.js</code>), run <code>scripts/sync-contract-addresses.sh</code>, commit.</p>
        <div class="ac-cards">${cards}</div><div class="ac-status" role="status" aria-live="polite" hidden></div></section>`);
    }

    /* -- migrate -- */
    {
      parts.push(`<section class="ac-panel"><h3>Migrate data</h3>
        <p class="ac-sub">Move a contract's ENTIRE state into a freshly deployed import-capable revision: read the source, replay everything through the target's owner-gated import functions - packed via <code>multicall</code>, so the whole migration is typically <b>one wallet confirmation</b> - verify the copy field-by-field, then permanently seal the imports. The plan is a delta: re-clicking Migrate resumes an interrupted run and picks up records created on the source since the last pass (do one last pass right before pointing the book, then seal). Targets deployed before 2026-07-07 have no import surface and are rejected.</p>
        <div class="ac-mig-ctl">
          <select class="ac-in ac-in-key" id="migKind" aria-label="Migration kind">${Object.entries(MIG_KINDS).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join("")}</select>
          <input class="ac-in" id="migSource" aria-label="Source contract address" placeholder="source 0x…" spellcheck="false" autocomplete="off" />
          <input class="ac-in" id="migTarget" aria-label="Target contract address" placeholder="target 0x… (the new deploy)" spellcheck="false" autocomplete="off" />
        </div>
        <div class="ac-mig-actions">
          <button class="btn btn-sm" data-act="mig-read">Read source</button>
          <button class="btn btn-primary btn-sm" data-act="mig-run" disabled>Migrate</button>
          <button class="btn btn-sm" data-act="mig-verify" disabled>Verify</button>
          <button class="btn btn-sm ac-danger-btn" data-act="mig-seal" disabled>Seal target imports</button>
        </div>
        <div class="ac-mig-log" id="migLog" role="log" aria-label="Migration log" hidden></div>
        <div class="ac-status" role="status" aria-live="polite" hidden></div></section>`);
    }

    /* -- danger zone -- */
    {
      const bSel = CONTRACTS.EnclaveAddressBook.sel, cSel = CONTRACTS.EnclaveAppCatalog.sel;
      const dSel = CONTRACTS.EnclaveDeployments.sel, pSel = CONTRACTS.EnclavePay.sel;
      const rows = [
        S.book && { label: "Address book", fn: "setOwner", to: S.book.addr, cur: S.book.owner, pending: S.book.pending, sel: bSel.setOwner, accSel: bSel.acceptOwnership, act: "own-book" },
        S.dep && { label: "EnclaveDeployments", fn: "setOwner", to: S.dep.addr, cur: S.dep.owner, pending: S.dep.pending, sel: dSel.setOwner, accSel: dSel.acceptOwnership, act: "own-dep" },
        S.cat && { label: "EnclaveAppCatalog", fn: "transferOwnership", to: S.cat.addr, cur: S.cat.owner, pending: S.cat.pending, sel: cSel.transferOwnership, accSel: cSel.acceptOwnership, act: "own-cat" },
        S.pay && { label: "EnclavePay", fn: "setOwner", to: S.pay.addr, cur: S.pay.owner, pending: S.pay.pending, sel: pSel.setOwner, accSel: pSel.acceptOwnership, act: "own-pay" },
        S.feat && { label: "EnclaveFeatured", fn: "transferOwnership", to: S.feat.addr, cur: S.feat.owner, pending: S.feat.pending, sel: CONTRACTS.EnclaveFeatured.sel.transferOwnership, accSel: CONTRACTS.EnclaveFeatured.sel.acceptOwnership, act: "own-feat" },
        S.rev && { label: "EnclaveReviews", fn: "transferOwnership", to: S.rev.addr, cur: S.rev.owner, pending: S.rev.pending, sel: CONTRACTS.EnclaveReviews.sel.transferOwnership, accSel: CONTRACTS.EnclaveReviews.sel.acceptOwnership, act: "own-rev" },
      ].filter(Boolean);
      this._ownRows = Object.fromEntries(rows.map((r) => [r.act, r]));
      const inner = rows.map((r) => {
        const hasPending = r.pending && !isZero(r.pending);
        const mePending = hasPending && lc(r.pending) === me;
        const pendingHtml = hasPending
          ? `<div class="ac-pending">pending → ${mono(r.pending)} ${mePending
              ? `<button class="btn btn-sm ac-danger-btn" data-act="acc-${r.act}">Accept</button>`
              : `<span class="dim">(the new key completes it by calling accept)</span>`}</div>`
          : "";
        return `<div class="ac-row">
        <div class="ac-lbl">${esc(r.label)} <code>${esc(r.fn)}</code></div>
        <div class="ac-cur">${mono(r.cur)}</div>
        <input class="ac-in" id="in-${r.act}" aria-label="New owner address" type="text" placeholder="new owner 0x…" spellcheck="false" />
        <input class="ac-in ac-in-key" id="cf-${r.act}" aria-label="Type TRANSFER to confirm" type="text" placeholder='type "TRANSFER"' spellcheck="false" />
        <button class="btn btn-sm ac-danger-btn" data-act="${r.act}" data-owner="${esc(r.cur)}">Nominate</button>
        ${pendingHtml}
      </div>`;
      }).join("");
      parts.push(sec(`<span class="warn">Danger zone - ownership handoffs</span>`,
        `Every one of these is now TWO-STEP: "Nominate" only sets a pending owner — the new key takes control only after IT calls accept from its own wallet, so a typo can't hand the platform to a stranger (the wrong address simply can't accept). Until it accepts, nothing changes: re-nominate to correct, or nominate the zero address to cancel.`,
        inner));
    }

    this._body.innerHTML = parts.join("");
    this._body.hidden = false;
    this._paintSigner();
    this._migPrefill();
    this._gate();
  }

  /* reset the migration flow: prefill the source from the book for the chosen
     kind, clear cached reads, disable the downstream buttons */
  _migPrefill() {
    const kindSel = this._body && this._body.querySelector("#migKind");
    if (!kindSel) return;
    const m = MIG_KINDS[kindSel.value];
    this._body.querySelector("#migSource").value = this.S.book.entries[m.bookKey] || "";
    this._mig = { kind: kindSel.value, data: null };
    for (const a of ["mig-run", "mig-verify", "mig-seal"]) {
      const b = this._body.querySelector(`[data-act="${a}"]`);
      b.disabled = true;
      if (a === "mig-seal") { delete b.dataset.armed; b.textContent = "Seal target imports"; }
    }
    const log = this._body.querySelector("#migLog");
    log.hidden = true; log.innerHTML = "";
  }

  _migLog(cls, txt) {
    const log = this._body.querySelector("#migLog");
    log.hidden = false;
    const d = document.createElement("div");
    d.className = cls; d.textContent = txt;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  /* disable every gated button whose data-owner doesn't match the wallet */
  _gate() {
    if (!this._body) return;
    const me = lc(Enclave.address);
    for (const b of this._body.querySelectorAll("[data-act][data-owner]")) {
      const need = lc(b.dataset.owner);
      const ok = me && need && me === need;
      b.disabled = !ok;
      b.title = ok ? "" : (me ? `owner is ${b.dataset.owner}` : "connect the governance wallet first");
    }
  }

  /* ---------- interaction ---------- */

  _onInput(e) {
    const inp = e.target.closest(".ac-in[data-for]");
    if (!inp) return;
    const live = this._body.querySelector("#live-" + inp.dataset.for.replace(/[^a-z0-9]/gi, ""));
    if (!live) return;
    const act = inp.dataset.for, v = inp.value.trim();
    live.textContent = (act === "dep-gpu" || act === "dep-cpu" || act === "dep-maxfee" || act === "cat-maxfee") && /^\d+$/.test(v) ? "≈ " + perHr(BigInt(v)) : "";
  }

  async _onClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const panelStatus = btn.closest(".ac-card, .ac-panel")?.querySelector(".ac-status");
    const S = this.S;
    const val = (id) => { const i = this._body.querySelector("#" + id); return i ? i.value.trim() : ""; };
    const inputFor = (a) => val("in-" + a.replace(/[^a-z0-9]/gi, ""));
    const need = (cond, msg) => { if (!cond) { this._status(panelStatus, "err", msg); return false; } return true; };

    try {
      if (act === "refresh") return void this.refresh();

      /* address book sets */
      if (act.startsWith("book-set:")) {
        const key = act.slice(9), v = inputFor(act);
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex); the zero address retires the key")) return;
        return void this._tx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set, [{ t: "bytes32", v: encKey(key) }, { t: "addr", v }]),
          `set ${key} → ${short(v)}`, panelStatus, true);
      }
      if (act === "book-set-new") {
        const key = val("newBookKey"), v = val("newBookVal");
        if (!need(KEY_RE.test(key), "key must be 1–31 ascii chars (letters, digits, - _)")) return;
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex)")) return;
        return void this._tx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set, [{ t: "bytes32", v: encKey(key) }, { t: "addr", v }]),
          `set ${key} → ${short(v)}`, panelStatus, true);
      }

      /* deployments params */
      const dSel = CONTRACTS.EnclaveDeployments.sel;
      if (act === "dep-gpu" || act === "dep-cpu") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && BigInt(v) > 0n, "price is a positive integer in µUSDC per second (278 ≈ $1.00/hr)")) return;
        return void this._tx(S.dep.addr, encCall(act === "dep-gpu" ? dSel.setPrice : dSel.setCpuPrice, [{ t: "uint", v }]),
          `${act === "dep-gpu" ? "setPrice" : "setCpuPrice"}(${v}) ≈ ${perHr(BigInt(v))}`, panelStatus, true);
      }
      if (act === "dep-maxgpu") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && +v <= 1000, "cap is 0…1000 milli of one card (1000 = whole card / uncapped, 0 pauses GPU creates)")) return;
        return void this._tx(S.dep.addr, encCall(dSel.setMaxGpuMilli, [{ t: "uint", v }]),
          `setMaxGpuMilli(${v}) — ${+v / 10}% of a card max per deployment`, panelStatus, true);
      }
      if (act === "dep-maxfee" || act === "cat-maxfee") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v), "cap is a non-negative integer in µUSDC per second (1389 ≈ $5.00/hr; 0 disables fees on new " + (act === "dep-maxfee" ? "deployments" : "publishes") + ")")) return;
        const [to, sel] = act === "dep-maxfee"
          ? [S.dep.addr, dSel.setMaxFee]
          : [S.cat.addr, CONTRACTS.EnclaveAppCatalog.sel.setMaxFee];
        return void this._tx(to, encCall(sel, [{ t: "uint", v }]),
          `setMaxFee(${v}) ≈ ${perHr(BigInt(v))} publisher-fee cap`, panelStatus, true);
      }
      if (act === "dep-lease") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && +v >= 60 && +v <= 86400, "lease must be 60…86400 seconds")) return;
        return void this._tx(S.dep.addr, encCall(dSel.setLeaseSec, [{ t: "uint", v }]), `setLeaseSec(${v})`, panelStatus, true);
      }
      if (act === "dep-feed" || act === "dep-payout" || act === "pay-payout" || act === "feat-payout" || act === "rev-fallback") {
        const v = inputFor(act);
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex)")) return;
        // the reviews fallback accepts zero (that's how you retire it and pin
        // the contract to the book alone)
        if (act !== "dep-feed" && act !== "rev-fallback" && !need(!isZero(v), "the zero address is rejected by the contract")) return;
        const map = {
          "dep-feed":   [S.dep.addr, dSel.setEthUsdFeed, "setEthUsdFeed"],
          "dep-payout": [S.dep.addr, dSel.setPayout, "setPayout"],
          "pay-payout": [S.pay.addr, CONTRACTS.EnclavePay.sel.setPayout, "setPayout"],
          "feat-payout": [S.feat && S.feat.addr, CONTRACTS.EnclaveFeatured.sel.setPayout, "setPayout"],
          "rev-fallback": [S.rev && S.rev.addr, CONTRACTS.EnclaveReviews.sel.setLedgerFallback, "setLedgerFallback"],
        };
        const [to, sel, fn] = map[act];
        return void this._tx(to, encCall(sel, [{ t: "addr", v }]), `${fn}(${short(v)})`, panelStatus, true);
      }

      /* featured slot */
      const fSel = CONTRACTS.EnclaveFeatured.sel;
      if (act === "feat-maxbid") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && BigInt(v) > 0n, "cap is a positive integer in µUSDC per view (10000 = $10.00 per 1k views)")) return;
        return void this._tx(S.feat.addr, encCall(fSel.setMaxBid, [{ t: "uint", v }]),
          `setMaxBid(${v}) — $${(Number(v) * 1000 / 1e6).toFixed(2)}/1k cap`, panelStatus, true);
      }
      if (act.startsWith("feat-settle:")) {
        const appId = act.slice(12), v = inputFor(act);
        if (!need(/^\d+$/.test(v) && BigInt(v) > 0n, "enter the number of metered views to settle (a positive integer)")) return;
        return void this._tx(S.feat.addr, encCall(fSel.settle, [{ t: "bytes32", v: appId }, { t: "uint", v }]),
          `settle(${short(appId)}, ${v} views)`, panelStatus, true);
      }
      if (act.startsWith("feat-active:")) {
        const [, appId, on2] = act.split(":");
        return void this._tx(S.feat.addr, encCall(fSel.setActive, [{ t: "bytes32", v: appId }, { t: "bool", v: on2 === "1" }]),
          `setActive(${short(appId)}, ${on2 === "1"})`, panelStatus, true);
      }

      /* ownership handoffs (step 1: nominate) */
      if (act.startsWith("own-")) {
        const r = this._ownRows[act];
        const v = val("in-" + act), cf = val("cf-" + act);
        if (!need(ADDR_RE.test(v) && !isZero(v), "enter the new owner address (0x…, non-zero)")) return;
        if (!need(cf === "TRANSFER", 'type TRANSFER (exactly) to confirm - this NOMINATES the new key (two-step); it takes control only after it accepts')) return;
        return void this._tx(r.to, encCall(r.sel, [{ t: "addr", v }]), `${r.label} ${r.fn} → ${short(v)} (nominate)`, panelStatus, true);
      }
      /* ownership handoffs (step 2: the pending key accepts) */
      if (act.startsWith("acc-")) {
        const r = this._ownRows[act.slice(4)];
        return void this._tx(r.to, encCall(r.accSel, []), `${r.label} accept ownership`, panelStatus, true);
      }

      /* deploys */
      if (act.startsWith("deploy:")) {
        const name = act.slice(7);
        const card = this._body.querySelector(`[data-card="${name}"]`);
        const c = CONTRACTS[name];
        const args = [];
        for (const inp of card.querySelectorAll(".ac-ctor")) {
          const v = inp.value.trim();
          const argName = inp.dataset.ctor;
          const zeroOk = name === "EnclaveDeployments" && argName === "ethUsdFeed";
          if (!need(ADDR_RE.test(v) && (zeroOk || !isZero(v)), `constructor arg "${argName}" needs a valid ${zeroOk ? "" : "non-zero "}address`)) return;
          args.push(v);
        }
        const status = card.querySelector(".ac-status");
        const out = card.querySelector(".ac-deploy-out");
        btn.disabled = true;
        try {
          await this._connect();
          this._status(status, "p", "deploying - confirm the creation transaction in your wallet…");
          const data = c.bytecode + args.map(encAddr).join("");
          const hash = await sendTx(null, data);
          this._status(status, "p", "sent " + hash.slice(0, 14) + "… waiting for confirmation…");
          const rcpt = await waitReceipt(hash, 90);
          const addr = rcpt.contractAddress;
          if (!need(addr && ADDR_RE.test(addr), "confirmed, but the receipt carries no contract address - check the tx on basescan")) return;
          this._status(status, "ok", `deployed ✓`);
          out.hidden = false;
          out.innerHTML = `<div class="ac-deployed">${esc(name)} → ${mono(addr)} · <a href="${EXPLORER}/address/${esc(addr)}" target="_blank" rel="noopener">basescan</a></div>` +
            (c.bookKey
              ? `<button class="btn btn-primary btn-sm" data-act="book-point:${esc(c.bookKey)}:${esc(addr)}" data-owner="${esc(S.book.owner)}">Point the book: ${esc(c.bookKey)} → ${esc(short(addr))}</button>
                 <span class="ac-hint">one owner tx; enclaves, site, relays and CLI follow within ≤5 min</span>`
              : `<p class="ac-sub warn">this is a NEW address book - bake its address into the configs/site/CLI (scripts/deploy-address-book.mjs does this) and ship a release before anything reads it.</p>`);
          this._gate();
        } finally { btn.disabled = false; }
        return;
      }
      /* migration */
      if (act.startsWith("mig-")) {
        const M = this._mig, m = MIG_KINDS[M.kind];
        const src = val("migSource"), tgt = val("migTarget");
        const log = (cls, txt) => this._migLog(cls, txt);
        const enable = (a, on2) => { this._body.querySelector(`[data-act="${a}"]`).disabled = !on2; };

        if (act === "mig-read") {
          if (!need(ADDR_RE.test(src), "enter the source contract address")) return;
          btn.disabled = true;
          try {
            log("p", `reading ${m.label} from ${src}…`);
            M.data = await m.read(src);
            M.source = src;
            log("ok", `source holds ${m.counts(M.data)}`);
            enable("mig-run", true); enable("mig-verify", true);
          } catch (err) { log("err", "read failed: " + friendly(err)); }
          finally { btn.disabled = false; }
          return;
        }

        if (!need(M.data && M.source === src, "read the source first (re-read if you changed the address)")) return;
        if (!need(ADDR_RE.test(tgt), "enter the target contract address (the new deploy)")) return;
        if (!need(lc(tgt) !== lc(src), "source and target are the same contract")) return;

        if (act === "mig-run") {
          btn.disabled = true;
          try {
            const st = await importState(tgt, m.contractName);
            if (!need(st.capable, "target has no import surface - deploy a fresh " + m.contractName + " from the card above")) return;
            if (!need(!st.sealed, "target's imports are permanently sealed - deploy a fresh target")) return;
            log("p", "reading the target to plan the delta…");
            const after = await m.read(tgt);
            const txs = m.plan(M.data, after);
            if (!txs.length) { log("ok", "nothing to import - target already holds everything. Verify, then seal."); return; }
            log("p", `${txs.length} import transaction${txs.length === 1 ? "" : "s"} to send`);
            await this._connect();
            for (let i = 0; i < txs.length; i++) {
              log("p", `[${i + 1}/${txs.length}] ${txs[i].label} - confirm in your wallet…`);
              const hash = await sendTx(tgt, txs[i].dataHex);
              log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
              await waitReceipt(hash, 90);
              log("ok", `  ✓ ${txs[i].label}`);
            }
            log("ok", "migration pass complete - run Verify next (Migrate again later to pick up new source records).");
          } catch (err) { log("err", friendly(err) + " - fix and click Migrate again; the delta plan resumes where it stopped."); }
          finally { btn.disabled = false; }
          return;
        }

        if (act === "mig-verify") {
          btn.disabled = true;
          try {
            log("p", "verifying: re-reading the target and diffing field-by-field…");
            const r = await m.verify(M.data, tgt);
            if (r.bad.length) {
              log("err", `${r.ok}/${r.total} match; mismatched: ${r.bad.slice(0, 10).join(", ")}${r.bad.length > 10 ? " …" : ""}`);
            } else {
              log("ok", `all ${r.total} records match the source exactly`);
              enable("mig-seal", true);
            }
          } catch (err) { log("err", "verify failed: " + friendly(err)); }
          finally { btn.disabled = false; }
          return;
        }

        if (act === "mig-seal") {
          if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Click again to PERMANENTLY seal"; return; }
          delete btn.dataset.armed; btn.textContent = "Seal target imports";
          btn.disabled = true;
          try {
            await this._connect();
            log("p", "sealImports - confirm in your wallet…");
            const hash = await sendTx(tgt, sealTx(m.contractName));
            await waitReceipt(hash);
            log("ok", "imports permanently sealed ✓ - now point the book: " + m.bookKey + " → " + tgt + " (Address book panel above), and refresh the repo fallbacks when convenient.");
          } catch (err) { log("err", friendly(err)); btn.disabled = false; }
          return;
        }
      }

      if (act.startsWith("book-point:")) {
        const [, key, addr] = act.split(":");
        return void this._tx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set, [{ t: "bytes32", v: encKey(key) }, { t: "addr", v: addr }]),
          `book: ${key} → ${short(addr)}`, panelStatus, true);
      }
    } catch (err) {
      this._status(panelStatus, "err", friendly(err));
    }
  }

  async _connect() {
    if (!Enclave.provider) await connectWallet();
    await ensureBaseChain();
  }

  async _tx(to, data, label, statusEl, refreshAfter) {
    try {
      await this._connect();
      this._status(statusEl, "p", label + " - confirm in your wallet…");
      const hash = await sendTx(to, data);
      this._status(statusEl, "p", label + " · " + hash.slice(0, 14) + "… waiting for confirmation…");
      await waitReceipt(hash);
      this._status(statusEl, "ok", label + " - confirmed ✓");
      showToast(label + " ✓");
      if (refreshAfter) setTimeout(() => this.refresh(), 1200);
    } catch (e) {
      this._status(statusEl, "err", label + " - " + friendly(e));
    }
  }

  _status(el, cls, txt) {
    if (!el) { showToast(txt); return; }
    el.hidden = false;
    el.className = "ac-status " + cls;
    el.textContent = txt;
  }
}
register("c-admin-console", AdminConsole);
