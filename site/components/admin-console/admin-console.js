/* ============================================================
   <c-admin-console> — the operator console behind admin.html.

   Replicates every governance transaction the terminal scripts
   perform (deploy-*.mjs, update-address-book.mjs, set-prices.mjs)
   plus the owner functions no script ever covered (payout/feed/
   lease setters, operator rotation, ownership handoffs), all
   signed by the connected wallet. Reads use the public RPC pool;
   a write is only ENABLED when the connected wallet matches that
   contract's owner/admin read live from the chain — and the chain
   enforces it regardless.

   Contract bytecode + selectors come from js/gen/contract-artifacts.js
   (generated from contracts/*.sol by scripts/build-contract-artifacts.mjs
   with the deploy scripts' exact solc settings), so a browser deploy
   produces the same code a terminal deploy would.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { Enclave } from "../../js/core/api.js";
import { connectWallet, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { baseRpc, waitReceipt, encCall, encAddr, hexBig } from "../../js/core/chain.js";
import { ADDRESS_BOOK_ADDRESS, USDC_BASE } from "../../js/core/config.js";
import { esc, on, short, showToast } from "../../js/core/util.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";

const EXPLORER = "https://basescan.org";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x" + "0".repeat(40);
const KEY_RE = /^[A-Za-z0-9_-]{1,31}$/;

/* the book panel's row order; other (custom) keys found on-chain follow */
const BOOK_KEYS = ["registry", "deployments", "appCatalog", "enclavePay", "volumeAccess"];

const lc = (a) => (a || "").toLowerCase();
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const perHr = (p6) => "$" + (Number(p6) * 3600 / 1e6).toFixed(4) + "/hr";
const mono = (a) => `<span class="ac-addr" title="${esc(a)}">${esc(a)}</span>`;
const encKey = (k) => { let h = ""; for (const ch of k) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return "0x" + h.padEnd(64, "0"); };
const friendly = (e) => (e && (e.code === 4001 || /reject|denied|declin|cancell/i.test(e.message || ""))) ? "cancelled in the wallet" : (e.message || String(e));

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const rdAddr = async (to, sel) => { const r = await call(to, "0x" + sel); return "0x" + (r || "").replace(/^0x/, "").slice(-40).padStart(40, "0"); };
const rdUint = async (to, sel) => hexBig((await call(to, "0x" + sel)) || "0x0");

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
    this._body = this.querySelector("#acBody");
    this._note = this.querySelector("#acNote");
    this._body.addEventListener("click", (e) => this._onClick(e));
    this._body.addEventListener("input", (e) => this._onInput(e));
    on("enclave:wallet", () => { this._paintSigner(); this._gate(); });
    this.refresh();
  }

  async refresh() {
    this._paintSigner();
    try {
      const S = this.S = { book: { addr: ADDRESS_BOOK_ADDRESS, owner: null, entries: {} } };
      if (!S.book.addr) { this._note.textContent = "no ADDRESS_BOOK_ADDRESS is configured — deploy the book first (scripts/deploy-address-book.mjs)."; return; }
      const bookSel = CONTRACTS.EnclaveAddressBook.sel;
      const [allHex, bookOwner] = await Promise.all([call(S.book.addr, "0x" + bookSel.all), rdAddr(S.book.addr, bookSel.owner)]);
      S.book.owner = bookOwner;
      S.book.entries = decodeBook(allHex);
      const E = S.book.entries;

      const dep = E.deployments, cat = E.appCatalog, pay = E.enclavePay, vol = E.volumeAccess;
      const dSel = CONTRACTS.EnclaveDeployments.sel, pSel = CONTRACTS.EnclavePay.sel, vSel = CONTRACTS.EnclaveVolumeAccess.sel;
      [S.dep, S.cat, S.pay, S.vol] = await Promise.all([
        dep ? Promise.all([rdAddr(dep, dSel.owner), rdAddr(dep, dSel.payout), rdUint(dep, dSel.pricePerSec6), rdUint(dep, dSel.cpuPricePerSec6), rdUint(dep, dSel.leaseSec), rdAddr(dep, dSel.ethUsdFeed)])
              .then(([owner, payout, gpu, cpu, lease, feed]) => ({ addr: dep, owner, payout, gpu, cpu, lease, feed })) : null,
        cat ? rdAddr(cat, CONTRACTS.EnclaveAppCatalog.sel.owner).then((owner) => ({ addr: cat, owner })) : null,
        pay ? Promise.all([rdAddr(pay, pSel.owner), rdAddr(pay, pSel.payout), rdAddr(pay, pSel.usdc)])
              .then(([owner, payout, usdc]) => ({ addr: pay, owner, payout, usdc })) : null,
        vol ? Promise.all([rdAddr(vol, vSel.admin), rdAddr(vol, vSel.operator)])
              .then(([admin, operator]) => ({ addr: vol, admin, operator })) : null,
      ]);
      this._note.hidden = true;
      this._paint();
    } catch (e) {
      this._note.hidden = false;
      this._note.textContent = "chain read failed: " + (e.message || e) + " — retry below.";
      this._body.hidden = false;
      this._body.innerHTML = `<button class="btn btn-sm" data-act="refresh">Retry</button>`;
    }
  }

  /* ---------- painting ---------- */

  _paintSigner() {
    const el = this.querySelector("#acSigner");
    const me = lc(Enclave.address);
    if (!me) {
      el.innerHTML = `<span class="ac-who dim">no wallet connected — reads work, writes need the governance wallet</span>
        <button class="btn btn-primary btn-sm" data-connect>Connect wallet</button>`;
      const b = el.querySelector("[data-connect]");
      if (b) b.addEventListener("click", async () => { try { await connectWallet(); } catch (e) { showToast(friendly(e)); } });
      return;
    }
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
    chip("volumes", S.vol && S.vol.admin);
    el.innerHTML = `<span class="ac-who">signing as <b class="ac-addr">${esc(Enclave.address)}</b></span>${chips.join("")}
      <button class="btn btn-sm ac-refresh" data-refresh>↻ Refresh</button>`;
    const r = el.querySelector("[data-refresh]");
    if (r) r.addEventListener("click", () => this.refresh());
  }

  _row(label, current, act, opts = {}) {
    const id = act.replace(/[^a-z0-9]/gi, "");
    return `<div class="ac-row">
      <div class="ac-lbl">${label}${opts.hint ? `<span class="ac-hint">${opts.hint}</span>` : ""}</div>
      <div class="ac-cur">${current}</div>
      <input class="ac-in" id="in-${id}" data-for="${act}" type="text" placeholder="${esc(opts.placeholder || "0x…")}" spellcheck="false" autocomplete="off" />
      <span class="ac-live" id="live-${id}"></span>
      <button class="btn btn-sm ac-apply" data-act="${act}" data-owner="${esc(opts.owner || "")}">${esc(opts.verb || "Set")}</button>
    </div>`;
  }

  _paint() {
    const S = this.S;
    const sec = (title, sub, inner) => `<section class="ac-panel">
      <h3>${title}</h3>${sub ? `<p class="ac-sub">${sub}</p>` : ""}${inner}
      <div class="ac-status" hidden></div>
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
        <input class="ac-in ac-in-key" id="newBookKey" type="text" placeholder="new key (ascii, ≤31)" spellcheck="false" />
        <span></span>
        <input class="ac-in" id="newBookVal" type="text" placeholder="0x…" spellcheck="false" />
        <span></span>
        <button class="btn btn-sm" data-act="book-set-new" data-owner="${esc(S.book.owner)}">Add key</button>
      </div>`;
      parts.push(sec(`Address book · ${link(S.book.addr)}`,
        `The platform's one on-chain root — enclaves, this site, the relays, and the CLI re-resolve every address from it within ≤5 min of a change. Owner ${mono(S.book.owner)}. Setting a key to the zero address retires it (readers keep their baked fallback).`,
        rows + custom));
    }

    /* -- deployments -- */
    if (S.dep) {
      const d = S.dep;
      parts.push(sec(`EnclaveDeployments · ${link(d.addr)}`,
        `Prices are µUSDC per second for a FULL card / node; existing deployments keep the rate they were created at. Owner ${mono(d.owner)}.`,
        this._row("GPU price <code>setPrice</code>", `${d.gpu} <span class="dim">(≈ ${perHr(d.gpu)})</span>`, "dep-gpu", { owner: d.owner, placeholder: String(d.gpu), hint: "µUSDC/s" }) +
        this._row("CPU price <code>setCpuPrice</code>", `${d.cpu} <span class="dim">(≈ ${perHr(d.cpu)})</span>`, "dep-cpu", { owner: d.owner, placeholder: String(d.cpu), hint: "µUSDC/s" }) +
        this._row("Lease <code>setLeaseSec</code>", `${d.lease}s`, "dep-lease", { owner: d.owner, placeholder: String(d.lease), hint: "60…86400 s" }) +
        this._row("ETH/USD feed <code>setEthUsdFeed</code>", isZero(d.feed) ? `<span class="dim">disabled (0x0)</span>` : mono(d.feed), "dep-feed", { owner: d.owner, hint: "0x0 disables ETH funding" }) +
        this._row("Payout <code>setPayout</code>", mono(d.payout), "dep-payout", { owner: d.owner })));
    } else parts.push(sec("EnclaveDeployments", `<span class="warn">not in the address book</span> — deploy one below, or set the <code>deployments</code> key.`, ""));

    /* -- pay -- */
    if (S.pay) {
      parts.push(sec(`EnclavePay · ${link(S.pay.addr)}`,
        `The gasless-funding forwarder. USDC ${mono(S.pay.usdc)} (immutable). Owner ${mono(S.pay.owner)}.`,
        this._row("Payout <code>setPayout</code>", mono(S.pay.payout), "pay-payout", { owner: S.pay.owner })));
    }

    /* -- volume access -- */
    if (S.vol) {
      parts.push(sec(`EnclaveVolumeAccess · ${link(S.vol.addr)}`,
        `Admin ${mono(S.vol.admin)}. The operator is the enclave runner key that gets granted on volumes (rotate it if the runner key rotates). Per-volume grant/revoke stays in the vault client — it needs sealed keys, not just a signature.`,
        this._row("Operator <code>setOperator</code>", mono(S.vol.operator), "vol-op", { owner: S.vol.admin })));
    }

    /* -- catalog pointer -- */
    if (S.cat) {
      parts.push(sec(`EnclaveAppCatalog · ${link(S.cat.addr)}`,
        `Owner ${mono(S.cat.owner)}. Moderation (approve / reject / verify / delist) already lives on the <a href="apps.html">Apps page</a> when you browse it with the owner wallet — it isn't duplicated here.`, ""));
    }

    /* -- deploy cards -- */
    {
      const pre = {
        EnclavePay: { usdc: USDC_BASE, payout: S.pay && S.pay.payout },
        EnclaveDeployments: { usdc: USDC_BASE, payout: (S.dep && S.dep.payout) || (S.pay && S.pay.payout), registry: S.book.entries.registry, ethUsdFeed: S.dep && S.dep.feed },
        EnclaveVolumeAccess: { operator: S.vol && S.vol.operator },
      };
      const notes = {
        EnclaveAddressBook: `<span class="warn">redeploying the book replaces the ONE address baked into every component</span> — that path needs the config/site/CLI rebake + a release + a dashboard update. Use <code>scripts/deploy-address-book.mjs</code> instead unless you know exactly why.`,
        EnclaveRegistry: `EnclaveDeployments pins the registry it trusts at construction — after a registry redeploy, redeploy EnclaveDeployments too (pointed at the new registry), then update both book keys.`,
        EnclaveDeployments: `deploys with the source-default prices — adjust in the panel above after pointing the book. Existing deployments live on in the OLD contract; users top up there until they redeploy.`,
        EnclaveVolumeAccess: `grants live per-volume inside the contract instance — a redeploy starts with no volumes and no grants.`,
      };
      const cards = Object.keys(CONTRACTS).map((name) => {
        const c = CONTRACTS[name];
        const p = pre[name] || {};
        const inputs = c.ctor.map((a) => `<label class="ac-ctor-l">${esc(a.name)} <span class="ac-hint">${esc(a.type)}</span>
          <input class="ac-in ac-ctor" data-ctor="${esc(a.name)}" type="text" value="${esc(p[a.name] || "")}" placeholder="0x…" spellcheck="false" /></label>`).join("");
        return `<div class="ac-card" data-card="${esc(name)}">
          <h4>${esc(name)}<span class="ac-hint">${(c.bytecode.length / 2 - 1).toLocaleString()} bytes${c.bookKey ? ` · book key <code>${esc(c.bookKey)}</code>` : " · not a book entry"}</span></h4>
          ${notes[name] ? `<p class="ac-sub">${notes[name]}</p>` : ""}
          ${inputs || `<p class="ac-sub dim">no constructor arguments — the deployer becomes ${name === "EnclaveVolumeAccess" ? "admin" : name === "EnclaveRegistry" ? "(no owner — open registration)" : "owner"}.</p>`}
          <button class="btn btn-primary btn-sm" data-act="deploy:${esc(name)}">Deploy ${esc(name)}</button>
          <div class="ac-deploy-out" hidden></div>
          <div class="ac-status" hidden></div>
        </div>`;
      }).join("");
      parts.push(`<section class="ac-panel"><h3>Deploy a contract</h3>
        <p class="ac-sub">Compiled from <code>contracts/*.sol</code> at site build time with the deploy scripts' exact solc settings; the deploy is a raw creation transaction from your wallet. After it confirms, point the address book at the new contract in one click — the whole platform follows within a poll. Then refresh the repo's baked fallbacks when convenient: paste the new address into <code>enclaves/gpu/tinfoil-config.yml</code> (catalog: <code>site/js/core/config.js</code>), run <code>scripts/sync-contract-addresses.sh</code>, commit.</p>
        <div class="ac-cards">${cards}</div><div class="ac-status" hidden></div></section>`);
    }

    /* -- danger zone -- */
    {
      const rows = [
        S.book && { label: "Address book", fn: "setOwner", to: S.book.addr, cur: S.book.owner, sel: CONTRACTS.EnclaveAddressBook.sel.setOwner, act: "own-book" },
        S.dep && { label: "EnclaveDeployments", fn: "setOwner", to: S.dep.addr, cur: S.dep.owner, sel: CONTRACTS.EnclaveDeployments.sel.setOwner, act: "own-dep" },
        S.cat && { label: "EnclaveAppCatalog", fn: "transferOwnership", to: S.cat.addr, cur: S.cat.owner, sel: CONTRACTS.EnclaveAppCatalog.sel.transferOwnership, act: "own-cat" },
        S.pay && { label: "EnclavePay", fn: "setOwner", to: S.pay.addr, cur: S.pay.owner, sel: CONTRACTS.EnclavePay.sel.setOwner, act: "own-pay" },
        S.vol && { label: "EnclaveVolumeAccess", fn: "transferAdmin", to: S.vol.addr, cur: S.vol.admin, sel: CONTRACTS.EnclaveVolumeAccess.sel.transferAdmin, act: "own-vol" },
      ].filter(Boolean);
      this._ownRows = Object.fromEntries(rows.map((r) => [r.act, r]));
      const inner = rows.map((r) => `<div class="ac-row">
        <div class="ac-lbl">${esc(r.label)} <code>${esc(r.fn)}</code></div>
        <div class="ac-cur">${mono(r.cur)}</div>
        <input class="ac-in" id="in-${r.act}" type="text" placeholder="new owner 0x…" spellcheck="false" />
        <input class="ac-in ac-in-key" id="cf-${r.act}" type="text" placeholder='type "TRANSFER"' spellcheck="false" />
        <button class="btn btn-sm ac-danger-btn" data-act="${r.act}" data-owner="${esc(r.cur)}">Transfer</button>
      </div>`).join("");
      parts.push(sec(`<span class="warn">Danger zone — ownership handoffs</span>`,
        `Every one of these is SINGLE-STEP: there is no accept from the new key, so a typo hands the platform to a stranger permanently. Type the address twice as carefully as you'd sign it.`,
        inner));
    }

    this._body.innerHTML = parts.join("");
    this._body.hidden = false;
    this._paintSigner();
    this._gate();
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
    live.textContent = (act === "dep-gpu" || act === "dep-cpu") && /^\d+$/.test(v) ? "≈ " + perHr(BigInt(v)) : "";
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
      if (act === "dep-lease") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && +v >= 60 && +v <= 86400, "lease must be 60…86400 seconds")) return;
        return void this._tx(S.dep.addr, encCall(dSel.setLeaseSec, [{ t: "uint", v }]), `setLeaseSec(${v})`, panelStatus, true);
      }
      if (act === "dep-feed" || act === "dep-payout" || act === "pay-payout" || act === "vol-op") {
        const v = inputFor(act);
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex)")) return;
        if (act !== "dep-feed" && !need(!isZero(v), "the zero address is rejected by the contract")) return;
        const map = {
          "dep-feed":   [S.dep.addr, dSel.setEthUsdFeed, "setEthUsdFeed"],
          "dep-payout": [S.dep.addr, dSel.setPayout, "setPayout"],
          "pay-payout": [S.pay.addr, CONTRACTS.EnclavePay.sel.setPayout, "setPayout"],
          "vol-op":     [S.vol.addr, CONTRACTS.EnclaveVolumeAccess.sel.setOperator, "setOperator"],
        };
        const [to, sel, fn] = map[act];
        return void this._tx(to, encCall(sel, [{ t: "addr", v }]), `${fn}(${short(v)})`, panelStatus, true);
      }

      /* ownership handoffs */
      if (act.startsWith("own-")) {
        const r = this._ownRows[act];
        const v = val("in-" + act), cf = val("cf-" + act);
        if (!need(ADDR_RE.test(v) && !isZero(v), "enter the new owner address (0x…, non-zero)")) return;
        if (!need(cf === "TRANSFER", 'type TRANSFER (exactly) to confirm — this handoff is single-step and irreversible')) return;
        return void this._tx(r.to, encCall(r.sel, [{ t: "addr", v }]), `${r.label} ${r.fn} → ${short(v)}`, panelStatus, true);
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
          this._status(status, "p", "deploying — confirm the creation transaction in your wallet…");
          const data = c.bytecode + args.map(encAddr).join("");
          const hash = await Enclave.provider.request({ method: "eth_sendTransaction", params: [{ from: Enclave.address, data }] });
          this._status(status, "p", "sent " + hash.slice(0, 14) + "… waiting for confirmation…");
          const rcpt = await waitReceipt(hash, 90);
          const addr = rcpt.contractAddress;
          if (!need(addr && ADDR_RE.test(addr), "confirmed, but the receipt carries no contract address — check the tx on basescan")) return;
          this._status(status, "ok", `deployed ✓`);
          out.hidden = false;
          out.innerHTML = `<div class="ac-deployed">${esc(name)} → ${mono(addr)} · <a href="${EXPLORER}/address/${esc(addr)}" target="_blank" rel="noopener">basescan</a></div>` +
            (c.bookKey
              ? `<button class="btn btn-primary btn-sm" data-act="book-point:${esc(c.bookKey)}:${esc(addr)}" data-owner="${esc(S.book.owner)}">Point the book: ${esc(c.bookKey)} → ${esc(short(addr))}</button>
                 <span class="ac-hint">one owner tx; enclaves, site, relays and CLI follow within ≤5 min</span>`
              : `<p class="ac-sub warn">this is a NEW address book — bake its address into the configs/site/CLI (scripts/deploy-address-book.mjs does this) and ship a release before anything reads it.</p>`);
          this._gate();
        } finally { btn.disabled = false; }
        return;
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
      this._status(statusEl, "p", label + " — confirm in your wallet…");
      const hash = await sendTx(to, data);
      this._status(statusEl, "p", label + " · " + hash.slice(0, 14) + "… waiting for confirmation…");
      await waitReceipt(hash);
      this._status(statusEl, "ok", label + " — confirmed ✓");
      showToast(label + " ✓");
      if (refreshAfter) setTimeout(() => this.refresh(), 1200);
    } catch (e) {
      this._status(statusEl, "err", label + " — " + friendly(e));
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
