/* ============================================================
   <c-deployments> - the "My Apps" panel: the signed-in
   customer's deployments, each with status, spend, its app origin,
   its dedicated IPv6 (when the deployment declares tcp/udp
   ports), in-browser attestation verification, and suspend/resume
   (on-chain rows; the balance stays on the record across a
   suspend - legacy dep_ rows terminate instead).
   ONE panel for both kinds of customer: wallet rows come from the
   ledger/enclave list and act via wallet txs; passkey/card account
   rows come from the relay's account-scoped join (their credit
   vault owns them on-chain) and money/control ops are passkey-
   signed vault operations instead - same rows, same controls.
   Polls while signed in; follows `enclave:wallet` address edges
   (async session restore, account switches), `enclave:account`
   sign-in/out edges and `enclave:auth` sign-in edges.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { $$, esc, hlJson, fmtDur, statusCls, copyText, showToast, lsGet, lsSet } from "../../js/core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { pad32, encUint, encCall, DEP_SEL, APPROVAL, depPrices6, rate6Of, depGet, depSchemaRev, depFeeOf, catVersionFee, waitReceipt } from "../../js/core/chain.js";
import { authenticate, connectWallet, refreshWallet, saveSession, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { slugOfRef, artOfRef, loadCatalog, parseCatalogRef, catalogRef, specOf, STORE } from "../../js/core/catalog.js";
import { vspecOf, verifyEnclaveInBrowser } from "../../js/core/verify.js";
import { runlog, paintLine } from "../../js/core/runlog.js";
import { payForRuntime } from "../../js/core/fund.js";
import { shareRates, minPctsOf, adoptServerSpec } from "../../js/core/pricing.js";

// The app's reachable URL. Through the gateway each deployment gets its OWN
// origin: a per-deployment subdomain (<id>.app.enclave.host, the base36 part of
// the deployment id; the "dep_" is dropped as redundant in this namespace), so
// an app can't touch the frontend's origin or another tenant's. Talking to an
// enclave directly falls back to the /x/<id> path. The deployment's own
// network.endpoint (the enclave's hostname) is only a last resort; it's the
// right value for attestation/registry, not for how the user reaches the app.
export function appEndpoint(d){
  if (!d || !d.id) return (d && d.network && d.network.endpoint) || "";
  const root = Enclave.base.replace(/\/v1\/?$/, "");
  if (/(^|\/\/)api\.(enclave|nan)\.host/i.test(root))
    return "https://" + appLabel(d.id) + "." + APP_DOMAIN;
  return root + "/x/" + d.id;                              // direct-to-enclave override
}
// Subdomain label for a deployment id. On-chain ids are bytes32: the label is
// the FIRST 8 HEX CHARS (32 bits - collisions are fantasy at any realistic
// deployment count; enclaves resolve the prefix to the unique match, and any
// longer prefix keeps working too). Legacy dep_ ids keep their base36 label.
export function appLabel(id){
  return /^0x[0-9a-f]{64}$/i.test(id) ? id.slice(2, 10).toLowerCase() : id.replace(/^dep_/, "");
}
// appEndpoint can derive from server-supplied fields (network.endpoint), so an
// endpoint may only become a navigable href if it is https: or a relative URL;
// anything else (javascript:, data:, …) is dropped so a hostile API can't smuggle
// a scheme into the "open ↗" link. "" means "not safe to link" (caller omits it).
function safeHref(u){
  const s = String(u || "");
  if (/^https:\/\//i.test(s)) return s;                 // absolute enclave/app origin
  if (/^\/(?!\/)/.test(s) || /^\.{1,2}\//.test(s)) return s;   // root- or dot-relative path
  return "";
}

/* ---- TLS-gated Open control ----
   An app origin's certificate is minted INSIDE the enclave (ACME dns-01),
   which takes a moment after the app reaches running - and every enclave
   release re-mints all of them (CVMs keep no disk). Until issuance the origin
   serves the self-signed fallback pair, so "open ↗" would land the user on a
   browser certificate warning. The control therefore starts as a DISABLED
   button with an amber OPEN padlock and only becomes the live link (closed
   jade padlock) once a probe from THIS browser completes a real handshake
   (_probeTls below) - the browser's own trust decision is the ground truth,
   not any server-side claim. */
const LOCK_OPEN = '<svg class="enc-lock" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M9 11V7a3.5 3.5 0 0 1 6.9-.9"/></svg>';
const LOCK_SHUT = '<svg class="enc-lock" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M9 11V7a3.5 3.5 0 0 1 7 0v4"/></svg>';
function openCtl(d, ep, tls){
  const href = safeHref(ep);
  if (!(d && d.public && (d.status || "") === "running" && href)) return "";
  return (tls && tls.state === "ok")
    ? '<a class="enc-open" data-tls="' + esc(d.id) + '" href="' + esc(href) + '/" target="_blank" rel="noopener" aria-label="Open app (new tab) - TLS certificate valid" title="TLS certificate valid - issued inside the enclave, verified by this browser">' + LOCK_SHUT + ' open ↗</a>'
    : '<button class="enc-open" data-tls="' + esc(d.id) + '" type="button" disabled aria-label="Open app - waiting for its TLS certificate" title="waiting for the app’s TLS certificate - minted inside the enclave, usually ready within a minute">' + LOCK_OPEN + ' open ↗</button>';
}

function shortImg(s){ if (!s) return ""; return s.length > 44 ? s.slice(0, 42) + "…" : s; }
// Status buckets for the filter bar: coarse groups beat ten raw statuses.
// Unknown/new statuses land in "ended" rather than vanishing.
const FILTER_KEY = "enclave_dash_filters";
const BUCKETS = ["running", "queued", "ended", "failed"];
// Decline reasons that no amount of waiting resolves (mirrors the enclave's
// claim-gauntlet wording; deploy.js's watchClaimAndRun keys on the same set)
const WHY_TERMINAL = /below the app|minimum shares|yanked|not .{0,12}approved|rejected|delisted|unlisted|configcid|retired|deactivated/i;
function bucketOf(st){
  st = String(st || "").toLowerCase();
  if (st === "running") return "running";
  // the "queued" bucket matches the ledger's own vocabulary: everything on
  // its way (queued/claimed/provisioning/awaiting_payment/...) but not over —
  // unfunded (drained; resumes on top-up) waits here too, it just isn't "queued"
  // "unknown" = an account row the relay's ledger cache hasn't caught up to
  // yet (fresh deploy) - it's on its way, not over
  if (["provisioning", "queued", "pending", "claiming", "claimed", "starting", "created", "awaiting_payment", "unfunded", "unknown"].indexOf(st) !== -1) return "queued";
  if (["failed", "error"].indexOf(st) !== -1) return "failed";
  return "ended";   // stopped, stopping, terminated, expired, …
}
// Who can act on a row: "wallet" rows are owned by the connected wallet
// (on-chain txs + enclave-session reads); "vault" rows are owned by the
// account's credit vault (money/control ops are passkey-signed through the
// relay); "order" rows are legacy provisioner-owned (read-only here).
function ctlOf(d){ return d && d.viaVault ? "vault" : (d && d.orderId ? "order" : "wallet"); }
function encTier(d){
  const r = d.resources || {};
  const g = r.gpuShare || 0, c = r.cpuShare != null ? r.cpuShare : (r.share || 0);
  if (g > 0) return Math.round(g * 100) + "% GPU · " + Math.round(c * 100) + "% CPU";
  return c ? (Math.round(c * 100) + "% CPU") : "CPU";
}
// A deployment's DEDICATED IPv6 (per-deployment addressing): declared tcp/udp
// ports are served at [address]:<logical port> via the relays, and outbound
// connections (dedicated-IP egress) leave from the same address. Rendered as
// its own copyable row when the API surfaces network.address - which it also
// does for port-less deployments when egress is on (outbound-only address).
function depIp6Row(d){
  const net = d.network || {};
  if (!net.address) return "";
  const tcp = (net.tcp && net.tcp.ports) || [];
  const udp = (net.udp && net.udp.ports) || [];
  const ports = (tcp.length ? " · tcp " + tcp.join(",") : "") + (udp.length ? " · udp " + udp.join(",") : "");
  const title = (tcp.length || udp.length)
    ? "dedicated IPv6 - this deployment's own address: tcp/udp ports are served on it at their real port numbers" + (net.egress ? ", and its outbound traffic egresses from it" : "")
    : "dedicated IPv6 - this deployment's own address: its outbound traffic egresses from it (no inbound tcp/udp ports declared)";
  return '<button class="enc-ep" data-ep="' + esc(net.address) + '" title="' + esc(title) + '">'
    + 'ip6 [' + esc(net.address) + ']' + esc(ports) + ((tcp.length || udp.length) ? '' : ' · egress only') + ' ⧉</button>';
}

class Deployments extends EnclaveElement {
  static templateUrl = new URL("./deployments.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._page = 0;                            // current deployments page (5 per page)
    this._logPolls = {};                       // open Output panels' log timers, by id
    this._strips = new Map();                  // live-deploy strips, keyed by run record
    this.querySelector(".enc-refresh").addEventListener("click", () => this.refresh({ spinner: true }));
    // status filter: a single-select seg + search, the store toolbar's
    // grammar (persisted; a legacy stored checkbox-set falls back to All)
    let saved = null; try { saved = JSON.parse(lsGet(FILTER_KEY) || "null"); } catch (e) {}
    this._filter = (typeof saved === "string" && ("all" === saved || BUCKETS.indexOf(saved) !== -1)) ? saved : "all";
    $$(".enc-segs button", this).forEach(b => {
      b.classList.toggle("on", b.dataset.bucket === this._filter);
      b.setAttribute("aria-pressed", String(b.dataset.bucket === this._filter));
      b.addEventListener("click", () => {
        this._filter = b.dataset.bucket;
        lsSet(FILTER_KEY, JSON.stringify(this._filter));
        $$(".enc-segs button", this).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
        this._page = 0;                        // a new filter starts at the first page
        this._renderRows(this._list || []);
      });
    });
    const q = this.querySelector(".enc-search");
    if (q) q.addEventListener("input", () => { this._q = q.value.trim().toLowerCase(); this._page = 0; this._renderRows(this._list || []); });
    // document-level listeners must be removable: the soft-nav router mounts a
    // fresh instance per visit, and detached ones must not keep refreshing.
    // A sign-in mid-view (the lazy log/attestation unlock) must NOT clobber
    // the open panel the user just unlocked - skip the repaint, the poll
    // catches up once the panel closes.
    this._onAuth = (e) => {
      if (Enclave.address && this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden]), .enc-upg:not([hidden])")) return;
      this.refresh({ spinner: !!(e.detail && e.detail.spinner) });
    };
    document.addEventListener("enclave:auth", this._onAuth);
    // the wallet session restores ASYNC after a hard reload (provider
    // discovery can take seconds), so the panel mounts and paints the connect
    // wall FIRST - and an address-only session (the lazy-SIWE norm) never
    // fires enclave:auth. Follow the wallet edges instead: whenever the
    // effective address differs from what the last paint used (restore,
    // connect, account switch, disconnect), re-list.
    this._onWallet = () => { if (Enclave.address !== this._paintedFor) this.refresh(); };
    document.addEventListener("enclave:wallet", this._onWallet);
    // passkey/card sign-in and sign-out edges: the same rule as the wallet edge
    this._onAcct = () => { if (Enclave.accountAuthed() !== this._paintedAcct) this.refresh(); };
    document.addEventListener("enclave:account", this._onAcct);
    this._onLog = (e) => this._onRunlog(e.detail || {});
    document.addEventListener("enclave:runlog", this._onLog);
    // deploys in flight (soft-nav away and back): rejoin every live run.
    // After a HARD reload none are live - but some may sit interrupted in the
    // persisted log (the refresh killed their deploy flows mid-stream); hand
    // them ALL to deploy.js to re-read the ledger and keep narrating, each
    // into its own run (a fleet resumes as a fleet).
    runlog.live().forEach(r => this._strip(r));
    const cuts = runlog.interrupted();
    if (cuts.length) import("../../js/pages/deploy.js")
      .then(m => cuts.forEach(r => m.resumeDeployWatch(r))).catch(() => {});
    // rows show their app's cover art, resolved from the catalog - kick the
    // read here too (no-op when loaded; the localStorage copy paints first)
    // and repaint once the live catalog lands, unless a panel is open (same
    // clobber rule as _onAuth; the regular poll catches up after it closes).
    loadCatalog();
    this._onCat = () => {
      if (this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden]), .enc-upg:not([hidden])")) return;
      if (this._list) this._renderRows(this._list);
    };
    document.addEventListener("enclave:catalog", this._onCat);
    this.refresh();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPoll();
    Object.keys(this._logPolls || {}).forEach(id => this._stopLogPoll(id));
    if (this._onAuth) document.removeEventListener("enclave:auth", this._onAuth);
    if (this._onWallet) document.removeEventListener("enclave:wallet", this._onWallet);
    if (this._onAcct) document.removeEventListener("enclave:account", this._onAcct);
    if (this._onLog) document.removeEventListener("enclave:runlog", this._onLog);
    if (this._onCat) document.removeEventListener("enclave:catalog", this._onCat);
    this._wired = false; this._onAuth = null; this._onWallet = null; this._onAcct = null; this._onLog = null; this._onCat = null;
  }

  /* ---- live-deploy strips: one per run streaming with no row to live in ---- */
  _strip(run, create) {
    let s = this._strips.get(run);
    if (s || create === false) return s || null;
    const wrap = this.querySelector(".enc-lives"); if (!wrap) return null;
    s = document.createElement("div");
    s.className = "enc-live";
    s.innerHTML = '<div class="enc-live-bar"><span class="elb-k">deploying</span><span class="enc-live-lbl"></span><button class="enc-live-x" type="button" title="dismiss" aria-label="Dismiss">✕</button></div>'
      + '<div class="term enc-live-out" role="status" aria-live="polite"></div>';
    s.querySelector(".enc-live-lbl").textContent = run.id || run.label || "";
    s.querySelector(".enc-live-x").addEventListener("click", () => { this._strips.delete(run); s.remove(); });
    const out = s.querySelector(".enc-live-out");
    run.lines.forEach(l => paintLine(out, l[0], l[1]));   // rejoined/resumed runs replay their history
    wrap.appendChild(s);
    this._strips.set(run, s);
    return s;
  }
  /* a strip yields to its row the moment one exists (the row's Output panel
     carries the history from there); an UNCLAIMED deployment has no row (rows
     come from the enclave API), so its strip stays until claimed or dismissed */
  _retireStrip(run) {
    const s = this._strips.get(run);
    if (s && run.done && run.id && this.querySelector('.enc-outbtn[data-id="' + run.id + '"]')) {
      this._strips.delete(run); s.remove();
    }
  }
  _onRunlog(d) {
    if (d.type === "start") this._strip(d.run);
    else if (d.type === "id") {
      const s = this._strip(d.run, false);
      const lbl = s && s.querySelector(".enc-live-lbl"); if (lbl) lbl.textContent = d.run.id;
    }
    else if (d.type === "line") {
      const s = this._strip(d.run, false);               // a dismissed strip stays dismissed
      if (s) paintLine(s.querySelector(".enc-live-out"), d.cls, d.txt);
      // a row's open Output panel for this deployment follows the narrative too
      if (d.run.id) { const nar = this._openNar(d.run.id); if (nar) paintLine(nar.box, d.cls, d.txt, nar.scroller); }
    }
    else if (d.type === "end") this._retireStrip(d.run);
    else if (d.type === "clear") {                        // sign-out purged the run log
      this._strips.forEach((s) => s.remove());
      this._strips.clear();
    }
  }
  _openNar(id) {
    const row = this.querySelector('.enc-out[data-id="' + id + '"]:not([hidden])');
    if (!row) return null;
    return { box: row.querySelector(".enc-out-nar"), scroller: row.querySelector(".enc-out-term") };
  }

  async refresh(opts) {
    opts = opts || {};
    const body = this.querySelector(".enc-body");
    if (!body) return;
    this._paintedFor = Enclave.address;             // what this paint reflects (see _onWallet)
    this._paintedAcct = Enclave.accountAuthed();    // …and the account edge (_onAcct)
    const hideBar = () => { const tb = this.querySelector(".enc-toolbar"); if (tb) tb.hidden = true; };
    if (!Enclave.address && !this._paintedAcct){
      this._stopPoll(); hideBar();
      const pager = this.querySelector(".enc-pager"); if (pager){ pager.hidden = true; pager.innerHTML = ""; }
      body.innerHTML = '<div class="enc-empty">Sign in (above) to see your enclaves.</div>'; return;
    }
    // NO sign-in wall: a connected wallet is enough - the list is public
    // ledger data, scoped by address (api.js adds ?owner= when tokenless);
    // a session only enriches rows with the enclaves' live view
    if (!body.querySelector(".enc-row") || opts.spinner) body.innerHTML = '<div class="loading" role="status">loading your enclaves…</div>';
    try {
      const list = [];
      if (Enclave.address){
        const res = await Enclave.listDeployments();
        list.push(...(Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || [])));
      }
      // passkey/card accounts: rows owned by the account's credit vault (plus
      // legacy provisioned orders) via the relay's account-scoped ledger join -
      // the SAME row shape, so both kinds of customer share this panel
      if (this._paintedAcct){
        try {
          const seen = new Set(list.map((d) => String(d.id).toLowerCase()));
          for (const d of (await Enclave.accountDeployments()).deployments || []){
            if (!d.id) d.id = d.deploymentId;
            if (d.id && !seen.has(String(d.id).toLowerCase())) list.push(d);
          }
        } catch(e){ if (!Enclave.address) throw e; }   // wallet rows still serve
      }
      const tb = this.querySelector(".enc-toolbar"); if (tb) tb.hidden = false;   // refresh + Deploy CTA live here now
      this._renderRows(list, opts.highlight);
      this._startPoll();
    } catch(e){
      // an expired/refused session isn't a wall anymore: drop the token and
      // re-list scoped by the connected address (the public ledger view)
      if (e.status === 401 && Enclave.token){ Enclave.token = null; saveSession(); refreshWallet(); return this.refresh(opts); }
      body.innerHTML = '<div class="enc-empty">couldn’t load enclaves: ' + esc(e.message || String(e)) + '</div>';
    }
  }

  _renderRows(list, highlight) {
    const body = this.querySelector(".enc-body");
    list = (list || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    this._list = list;
    const counts = { all: list.length, running: 0, queued: 0, ended: 0, failed: 0 };
    list.forEach(d => { counts[bucketOf(d.status)]++; });
    $$(".enc-segs button", this).forEach(b => { const n = b.querySelector("b"); if (n) n.textContent = String(counts[b.dataset.bucket] || 0); });
    let shown = this._filter === "all" ? list.slice() : list.filter(d => bucketOf(d.status) === this._filter);
    if (this._q) shown = shown.filter(d =>
      (d.id + " " + ((d.image && d.image.reference) || "") + " " + (d.status || "")).toLowerCase().includes(this._q));
    const pager = this.querySelector(".enc-pager");
    const clearPager = () => { if (pager){ pager.hidden = true; pager.innerHTML = ""; } };
    if (!list.length){ body.innerHTML = '<div class="enc-empty">No apps yet. <a href="apps">Deploy one →</a></div>'; clearPager(); return; }
    if (!shown.length){ body.innerHTML = '<div class="enc-empty">Nothing here - pick another status tab or clear the search.</div>'; clearPager(); return; }
    // paginate: 5 rows per page (the list grows unbounded; keep the panel short).
    // The page persists across the 10s poll; a just-deployed (highlighted) row
    // pulls the view to whichever page it lands on; clamp when the list shrinks.
    const PER_PAGE = 5;
    const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
    if (highlight){ const hi = shown.findIndex(d => d.id === highlight); if (hi >= 0) this._page = Math.floor(hi / PER_PAGE); }
    if (this._page >= pages) this._page = pages - 1;
    if (!(this._page >= 0)) this._page = 0;
    const pageRows = shown.slice(this._page * PER_PAGE, this._page * PER_PAGE + PER_PAGE);
    body.innerHTML = pageRows.map(d => {
      const ep = appEndpoint(d), st = d.status || "–";
      // vault rows speak in dollars (account customers never see token names);
      // wallet rows keep the explicit USDC wording. Paid AND spent: both row
      // sources (supervisor live view, relay ledger view) carry spentUsdc.
      const ctl = ctlOf(d);
      const bud = (d.paidUsdc != null)
        ? ((ctl === "wallet" ? esc(d.paidUsdc) + " USDC paid" : "$" + esc(d.paidUsdc) + " paid")
           + (d.spentUsdc != null ? " · " + (ctl === "wallet" ? esc(d.spentUsdc) : "$" + esc(d.spentUsdc)) + " spent" : "")
           + (d.timeRemainingSec > 0 ? " · " + esc(fmtDur(d.timeRemainingSec)) + " left" : "")
           + (d.paused ? " · ⏸ time frozen (" + esc(d.pauseReason || "outage") + ", resumes when service is restored)" : ""))
        : "–";
      // on-chain rows without a live runner stay actionable: queued/claimed
      // work can be topped up, and awaiting_payment/unfunded are Top up's
      // whole point (unfunded = drained; a top-up is what un-sticks it)
      const live = ["running", "provisioning", "queued", "pending", "claiming", "claimed", "awaiting_payment", "unfunded"].indexOf(st) !== -1;
      // on-chain rows are WORK ITEMS: setActive(false) suspends (the remaining
      // balance stays on the record) and setActive(true) re-queues it, so a
      // stopped/terminated on-chain row is resumable, not gone. "stopped" is
      // the ledger's word for it; "terminated" is the ex-runner's own record
      // of the same suspend (it shadows the ledger row while signed in).
      // Legacy dep_ instances have no ledger record to reactivate: theirs
      // stays Terminate, and ended legacy rows offer nothing.
      const onchain = /^0x[0-9a-f]{64}$/i.test(d.id || "");
      const resumable = onchain && (st === "stopped" || st === "terminated");
      // the row's app identity, shared by the cover-art chip and the meta line
      const appLbl = (d.app && d.app.slug ? d.app.slug + ":" + d.app.version : null)
        || (d.image && d.image.reference ? slugOfRef(d.image.reference) || shortImg(d.image.reference) : null);
      const art = artOfRef(d.image && d.image.reference, appLbl || d.id);
      return '<div class="enc-row' + (highlight && d.id === highlight ? " enc-new" : "") + '">' +
        '<div class="enc-main">' +
          '<span class="enc-thumb" style="background-image:' + art + '" aria-hidden="true"></span>' +
          '<span class="ap-badge ' + statusCls(st) + '">' + esc(st) + '</span>' +
          '<span class="ap-badge ' + (d.public ? 'ep-public' : 'ep-private') + '" title="' + (d.public ? 'anyone can reach the app endpoint' : 'only your wallet token can reach the app') + '">' + (d.public ? 'public' : 'private') + '</span>' +
          '<button class="enc-id" data-copy="' + esc(d.id) + '">' + esc(d.id) + ' ⧉</button>' +
          '<span class="enc-br" aria-hidden="true"></span>' +
          '<span class="enc-meta">' + esc(encTier(d)) + (appLbl ? ' · <span class="dim">' + esc(appLbl) + '</span>' : '') + '</span>' +
          '<span class="enc-spend">' + bud + '</span>' +
          '<span class="enc-acts">' +
            '<button class="btn btn-sm enc-outbtn" data-id="' + esc(d.id) + '" aria-expanded="false">Output</button>' +
            (live && ctl !== "order" ? '<button class="btn btn-sm enc-fundbtn" data-id="' + esc(d.id) + '" aria-expanded="false" title="' + (ctl === "vault" ? 'Add runtime from your credit balance - one passkey tap' : 'Add runtime - a gas-free USDC signature credits the deployment’s on-chain balance') + '">Top up</button>' : '') +
            (onchain && (live || resumable) && ctl !== "order" ? '<button class="btn btn-sm enc-upgbtn" data-id="' + esc(d.id) + '" aria-expanded="false" title="Switch to another approved version of this app - paid time carries over; the app restarts in place on the new version">Version</button>' : '') +
            (st === "running" && ctl === "wallet" ? '<button class="btn btn-sm enc-restart" data-id="' + esc(d.id) + '" title="Stop and relaunch the app in place - same version, endpoint and balance; app state is ephemeral. The fix for a wedged instance (e.g. a model that never loaded at boot)">Restart</button>' : '') +
            '<button class="btn btn-sm enc-verify" data-id="' + esc(d.id) + '" aria-expanded="false">Verify</button>' +
            (resumable && ctl !== "order" ? '<button class="btn btn-sm enc-resume" data-id="' + esc(d.id) + '" title="Put it back on the queue - an enclave re-claims it and the app relaunches fresh from its published version, spending the remaining balance">Resume</button>' : '') +
            (live && ctl !== "order" ? (onchain
              ? '<button class="btn btn-sm danger enc-kill" data-id="' + esc(d.id) + '" title="Stop the app and take it off the queue. The remaining balance stays on the deployment - Resume restarts it any time">Suspend</button>'
              : '<button class="btn btn-sm danger enc-kill" data-id="' + esc(d.id) + '">Terminate</button>') : '') +
          '</span>' +
        '</div>' +
        ((st === "failed" || st === "expired") && d.error ? '<div class="enc-err" title="why this deployment ' + esc(st) + '">⚠ ' + esc(d.error) + '</div>' : '') +
        // a version change the runner could not apply yet (unapproved/oversized
        // target, catalog unreachable): the OLD version keeps serving; say why
        (d.versionChange && d.versionChange.error ? '<div class="enc-err" title="the requested version change has not applied - the previous version keeps serving; the runner retries automatically">⚠ version change pending: ' + esc(d.versionChange.error) + '</div>' : '') +
        (st === "queued" ? '<div class="enc-why" data-why="' + esc(d.id) + '" role="status" aria-live="polite" hidden></div>' : '') +
        (ep ? '<button class="enc-ep" data-ep="' + esc(ep) + '">' + esc(ep) + ' ⧉</button>'
              + openCtl(d, ep, this._tls && this._tls.get(d.id)) : '') +
        depIp6Row(d) +
        '<div class="enc-fund" hidden></div>' +
        '<div class="enc-upg" hidden></div>' +
        '<div class="enc-out" data-id="' + esc(d.id) + '" hidden></div>' +
        '<div class="enc-att" hidden></div>' +
      '</div>';
    }).join("");
    $$(".enc-id", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
    $$(".enc-ep", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.ep)));
    $$(".enc-outbtn", body).forEach(b => b.addEventListener("click", () => this._output(b.dataset.id, b)));
    $$(".enc-fundbtn", body).forEach(b => b.addEventListener("click", () => this._fund(b.dataset.id, b)));
    $$(".enc-upgbtn", body).forEach(b => b.addEventListener("click", () => this._upgrade(b.dataset.id, b)));
    $$(".enc-verify", body).forEach(b => b.addEventListener("click", () => this._verify(b.dataset.id, b)));
    $$(".enc-kill", body).forEach(b => b.addEventListener("click", () => this._kill(b.dataset.id, b)));
    $$(".enc-resume", body).forEach(b => b.addEventListener("click", () => this._resume(b.dataset.id, b)));
    $$(".enc-restart", body).forEach(b => b.addEventListener("click", () => this._restart(b.dataset.id, b)));
    this._fillWhy();               // cached decline reasons repaint instantly with the rows
    this._probeWhy(pageRows);      // then refresh them (throttled per row)
    this._probeTls(pageRows);      // TLS-gate the Open controls (throttled per row)
    this._renderPager(pages, shown.length, PER_PAGE);
    // finished runs' strips yield to their rows the moment those render
    [...this._strips.keys()].forEach(r => this._retireStrip(r));
    // a just-deployed row opens its Output panel so the narrative continues in place
    if (highlight) {
      const b = body.querySelector('.enc-outbtn[data-id="' + highlight + '"]');
      if (b && runlog.runFor(highlight)) this._output(highlight, b);
    }
  }

  /* ---- queued rows: WHY is the fleet not taking this? ----
     "queued" only says no runner holds a lease - the ledger can't say why.
     /v1/claim-hint runs the enclaves' exact claim gauntlet and returns the
     decline reason, so the row can distinguish "waiting on capacity" from
     TERMINAL states (below the app's minimum shares, unapproved version,
     retired configCid) where no amount of waiting ever starts the app and
     the only exit is suspend + redeploy (created shares are immutable).
     Without this, a permanently unclaimable deployment is indistinguishable
     from a patient one - it took chain forensics to tell them apart once
     (2026-07-14, 0xf3d976a0…). Probes are throttled hard: current page only,
     30s per row - the enclave's hint bucket is per-source-IP and the relay
     pools every browser behind its one IP. ---- */
  async _probeWhy(rows) {
    this._why = this._why || new Map();
    for (const d of rows) {
      if ((d.status || "") !== "queued" || !/^0x[0-9a-f]{64}$/i.test(d.id || "")) continue;
      const c = this._why.get(d.id);
      if (c && Date.now() - c.at < 30_000) continue;
      this._why.set(d.id, { ...(c || {}), at: Date.now() });   // stamp before the await: overlapping polls must not double-probe
      try {
        const r = await fetch(Enclave.base + "/claim-hint", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ id: d.id }) });
        const h = await r.json();
        if (h && h.accepted === false && h.reason)
          this._why.set(d.id, { at: Date.now(), reason: h.reason, terminal: WHY_TERMINAL.test(h.reason) });
        else if (h && h.accepted === true)
          this._why.set(d.id, { at: Date.now(), reason: "", terminal: false });   // being claimed - clear the line
      } catch(e){}   // 429 / network: keep what we knew, retry next cycle
    }
    this._fillWhy();
  }
  _fillWhy() {
    if (!this._why) return;
    $$(".enc-why", this).forEach(el => {
      const c = this._why.get(el.dataset.why);
      if (!c || !c.reason){ el.hidden = true; el.innerHTML = ""; el.classList.remove("enc-err"); return; }
      el.classList.toggle("enc-err", !!c.terminal);
      el.innerHTML = c.terminal
        ? "⚠ won’t start by waiting - the fleet refuses this work: " + esc(c.reason)
          + " (a deployment’s shares are immutable: suspend it and redeploy at the app’s current minimums)"
        : '<span class="dim">fleet: ' + esc(c.reason) + " - retrying automatically</span>";
      el.hidden = false;
    });
  }

  /* ---- Open-control TLS probes: does THIS browser trust the app origin? ----
     A no-cors HEAD resolves (opaque) iff DNS + TCP + the TLS handshake all
     succeeded with a certificate this browser trusts - the self-signed
     fallback rejects, which is exactly the "cert not through yet" state.
     Redirects follow (no-cors REQUIRES follow - manual throws a TypeError),
     so an app whose / redirects somewhere broken or insecure stays amber:
     right call, since that's also what greets whoever clicks open.
     Throttle: pending rows retry each ~10s poll; a green row re-verifies
     every 5 min (an enclave release re-mints every cert, so green can regress)
     and only flips back on an actual failed probe - never while in flight. ---- */
  async _probeTls(rows) {
    this._tls = this._tls || new Map();
    for (const d of rows) {
      if (!(d.public && (d.status || "") === "running")) { this._tls.delete(d.id); continue; }
      const href = safeHref(appEndpoint(d));
      if (!/^https:\/\//i.test(href)) continue;   // only absolute https origins render an Open control
      const c = this._tls.get(d.id);
      if (c && Date.now() - c.at < (c.state === "ok" ? 300_000 : 8_000)) continue;
      this._tls.set(d.id, { state: c ? c.state : "wait", at: Date.now() });   // stamp before the await: overlapping polls must not double-probe
      try {
        await fetch(href + "/", { method: "HEAD", mode: "no-cors", cache: "no-store",
                                  signal: AbortSignal.timeout(8000) });
        this._tls.set(d.id, { state: "ok", at: Date.now() });
      } catch (e) {
        this._tls.set(d.id, { state: "wait", at: Date.now() });
      }
    }
    this._fillTls();
  }
  /* swap Open controls in place when a probe verdict differs from what's
     rendered - the 10s poll skips repaints while a panel is open, and the
     first probe usually lands between two paints */
  _fillTls() {
    if (!this._tls) return;
    $$("[data-tls]", this).forEach(el => {
      const c = this._tls.get(el.dataset.tls);
      const ok = !!(c && c.state === "ok");
      if (ok === (el.tagName === "A")) return;
      const d = (this._list || []).find(x => x.id === el.dataset.tls);
      const html = d ? openCtl(d, appEndpoint(d), c) : "";
      if (html) el.outerHTML = html;
    });
  }

  /* ---- pager: prev · "x–y of N" · next. Hidden for a single page. ---- */
  _renderPager(pages, total, per) {
    const pager = this.querySelector(".enc-pager"); if (!pager) return;
    if (pages <= 1){ pager.hidden = true; pager.innerHTML = ""; return; }
    const p = this._page, first = p * per + 1, last = Math.min(total, (p + 1) * per);
    pager.hidden = false;
    pager.innerHTML =
      '<button class="btn btn-sm enc-pg" data-pg="prev" type="button"' + (p <= 0 ? " disabled" : "") + '>← prev</button>' +
      '<span class="enc-pg-info">' + first + '–' + last + ' of ' + total + ' · page ' + (p + 1) + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm enc-pg" data-pg="next" type="button"' + (p >= pages - 1 ? " disabled" : "") + '>next →</button>';
    $$(".enc-pg", pager).forEach(b => b.addEventListener("click", () => {
      this._page += b.dataset.pg === "next" ? 1 : -1;
      this._renderRows(this._list || []);
      const top = this.querySelector(".enc-body");
      if (top) top.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }));
  }

  /* ---- per-row Top up: extend a deployment's runtime in place. One amount,
     the runtime it adds at this deployment's own rate, one gas-free USDC
     signature (EIP-3009 -> fundWithAuthorization; same flow as deploying). ---- */
  _fund(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-fund"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const d = (this._list || []).find(x => x.id === id) || {};
    const via = ctlOf(d) === "vault";   // credit-vault row: passkey-signed, spends account credit
    const r = d.resources || {};
    const gpuPct = Math.round((r.gpuShare || 0) * 100), cpuPct = Math.round((r.cpuShare != null ? r.cpuShare : (r.share || 0)) * 100);
    // the deployment's own burn rate: the API's live number (the on-chain
    // snapshot) when present; else the CONTRACT's prices; constants only
    // until that read lands
    let rate = parseFloat(d.ratePerSecondUsdc) || shareRates(gpuPct, cpuPct).rate;
    if (!parseFloat(d.ratePerSecondUsdc))
      depPrices6().then(pr => { rate = Number(rate6Of(pr, gpuPct * 10, cpuPct * 10)) / 1e6; if (box.isConnected && !box.hidden) upd(); }).catch(() => {});
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">top up · ' + esc(id) + '</div>'
      + '<div class="enc-fund-body">'
      +   '<label for="efAmt">Add runtime (' + (via ? 'USD' : 'USDC') + ')</label>'
      +   '<input class="ef-amt" id="efAmt" type="number" value="5" min="0.01" step="any" inputmode="decimal" />'
      +   '<span class="ef-est"></span>'
      +   '<button class="btn btn-sm btn-primary ef-go" type="button">' + (via ? 'Confirm with passkey' : 'Sign &amp; pay') + '</button>'
      + '</div>'
      + '<div class="term enc-fund-status" role="status" aria-live="polite"></div>';
    const amt = box.querySelector(".ef-amt"), est = box.querySelector(".ef-est");
    const go = box.querySelector(".ef-go"), st = box.querySelector(".enc-fund-status");
    const paint = (cls, txt) => paintLine(st, cls, txt);
    const upd = () => {
      const usd = parseFloat(amt.value) || 0;
      est.textContent = (rate > 0 && usd > 0) ? "adds ≈ " + fmtDur(usd / rate) : "";
      go.disabled = !(usd >= 0.01);
    };
    amt.addEventListener("input", upd); upd();
    go.addEventListener("click", async () => {
      const usd = parseFloat(amt.value) || 0; if (!(usd >= 0.01)) return;
      go.disabled = true; st.innerHTML = "";
      if (via){
        // credit path: the vault owns this deployment on-chain; one passkey
        // tap signs fundDeployment and the balance moves credit -> deployment
        try {
          paint("info", "[*] confirm with your passkey…");
          const { vaultOp } = await import("../../js/core/vault.js");
          await vaultOp("fund", { id, amountUsd: usd });
          paint("ok", "[✓] topped up from your credit" + (rate > 0 ? " - +" + fmtDur(usd / rate) + " of runtime" : "") + " · the enclave picks up the new balance within a minute");
          showToast("topped up " + id.slice(0, 10) + "… with $" + usd.toFixed(2));
          document.dispatchEvent(new CustomEvent("enclave:credit"));   // the dashboard's credit card refreshes
          setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; } this.refresh(); }, 3500);
        } catch(e){ paint("warn", "[x] " + (e.message || String(e))); }
        finally { go.disabled = false; }
        return;
      }
      try {
        // no SIWE: the EIP-3009 authorization IS the proof of key ownership
        if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
        await ensureBaseChain();
        let pricing = null;
        try { pricing = await (await fetch(Enclave.base + "/pricing", { signal: AbortSignal.timeout(8000) })).json(); } catch(e){}
        await payForRuntime({
          contract: DEPLOYMENTS_ADDRESS, deploymentRef: id,
          usdcDomain: pricing && pricing.usdcDomain, usdc: (pricing && pricing.usdc) || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          ethUsd: pricing && pricing.ethUsd,
        }, usd, "USDC", paint);
        paint("ok", "[✓] topped up" + (rate > 0 ? " - +" + fmtDur(usd / rate) + " of runtime" : "") + " · the enclave picks up the new balance within a minute");
        showToast("topped up " + id.slice(0, 10) + "… with $" + usd.toFixed(2));
        setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; } this.refresh(); }, 3500);
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? "[x] rejected in wallet - nothing was paid" : "[x] " + (e.message || String(e)));
      } finally { go.disabled = false; refreshWallet(); }
    });
  }

  /* ---- per-row Version: repoint the deployment at another approved version
     of its app - the owner's UPGRADE path (setAppRef on the ledger). Paid
     time, shares and any live lease stay on the record: the runner restarts
     the app in place on the new version within about a minute, so a new
     release never costs a second buy-in. Candidates are the app's other
     approved un-yanked versions; ones whose minimums exceed this deployment's
     bought shares are listed disabled (created shares are immutable - those
     need a fresh deploy at bigger dials). Checked here BEFORE the wallet
     signature, the deploy form's floor rule: runners enforce the same gate,
     and a version no runner accepts would leave the app dark. ---- */
  async _upgrade(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-upg"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">change version · ' + esc(id) + '</div>'
      + '<div class="term enc-upg-status" role="status" aria-live="polite"><span class="ln dimln">// reading the ledger + catalog…</span></div>';
    let d = null, rev = 1;
    try {
      [rev, d] = await Promise.all([depSchemaRev(), depGet(id)]);
      await loadCatalog();
      // adopt the fleet's live hardware for the minimum-share floors (the
      // deploy dials' rule: a stale spec must over-ask, never under-sell an
      // unclaimable switch); the pre-fetch fallback constants already over-ask
      try { adoptServerSpec(await Enclave.getAvailability()); } catch(e){}
    } catch(e){ d = null; }
    if (box.hidden || !box.isConnected) return;             // closed while loading
    const fail = (msg) => { box.querySelector(".enc-upg-status").innerHTML = ""; paintLine(box.querySelector(".enc-upg-status"), "warn", msg); };
    if (!d) return fail("[x] couldn’t read this deployment from the ledger - try again shortly");
    const cr = parseCatalogRef(d.appRef);
    if (!cr) return fail("[x] this deployment doesn’t reference a catalog version (" + (d.appRef || "no appRef") + ") - only catalog deployments can switch versions");
    const app = STORE.byId[cr.appId];
    if (!app || !app.versions) return fail("[x] the catalog doesn’t list this deployment’s app (delisted?) - nothing to switch to");
    if (rev < 3)
      return fail("[!] the live ledger contract predates version changes - the Version control activates with the next contract upgrade. Until then: deploy the new version fresh, then suspend this one (its balance stays on the record).");
    // The deployment's publisher-fee snapshot is as immutable as its shares:
    // a candidate version asking MORE than the snapshot could never pay its
    // publisher, so every runner would refuse the switch - list it disabled,
    // exactly like a share misfit. Fail closed on unreadable fees: offering a
    // switch runners refuse would leave the app dark. (Pre-fee ledger/catalog
    // revs read as all-zero without extra RPC - nothing disables today.)
    let snapFee = 0n; const verFees = {};
    try {
      snapFee = (await depFeeOf(id)).feePerSec6;
      await Promise.all(app.versions.map(async (v, i) => {
        verFees[i] = (!v.yanked && v.approval === APPROVAL.approved) ? await catVersionFee(cr.appId, i) : 0n;
      }));
    } catch(e){ return fail("[x] couldn’t read the publisher fees involved - try again shortly"); }
    // every approved, un-yanked version, newest first; the current one and the
    // ones this deployment's immutable shares (or fee snapshot) can't cover
    // render disabled
    const bought = { gpuMilli: Number(d.gpuMilli) || 0, cpuMilli: Number(d.cpuMilli) || 0 };
    const rows = app.versions
      .map((v, i) => ({ v, i, mins: minPctsOf(specOf(v)) }))
      .filter(r => !r.v.yanked && r.v.approval === APPROVAL.approved)
      .map(r => ({ ...r,
        shareFit: r.mins.gpuPct * 10 <= bought.gpuMilli && r.mins.cpuPct * 10 <= bought.cpuMilli,
        feeFit: (verFees[r.i] || 0n) <= snapFee }))
      .map(r => ({ ...r, fits: r.shareFit && r.feeFit }))
      .reverse();
    const others = rows.filter(r => r.i !== cr.index);
    const pick = others.find(r => r.fits);                  // newest fitting release = the natural upgrade
    if (!others.length)
      return fail("// " + app.slug + " has no other approved version yet - new releases appear here once the catalog owner approves them");
    const selId = "euSel" + appLabel(id);
    box.innerHTML = '<div class="ap-attbar">change version · ' + esc(id) + '</div>'
      + '<div class="enc-upg-body">'
      +   '<label for="' + selId + '">Switch ' + esc(app.slug) + ' to</label>'
      +   '<select class="eu-sel" id="' + selId + '">'
      +     rows.map(r => '<option value="' + r.i + '"' + ((r.i === cr.index || !r.fits) ? " disabled" : "") + (pick && r.i === pick.i ? " selected" : "") + '>'
      +       esc(app.slug + ":" + r.v.version)
      +       (r.i === cr.index ? " · current" : "")
      +       (!r.shareFit && r.i !== cr.index ? " · needs ≥ " + (r.mins.gpuPct ? r.mins.gpuPct + "% GPU / " : "") + r.mins.cpuPct + "% CPU" : "")
      +       (r.shareFit && !r.feeFit && r.i !== cr.index ? " · charges $" + (Number(verFees[r.i]) * 3600 / 1e6).toFixed(2) + "/hr publisher fee (above this deployment’s snapshot)" : "")
      +     '</option>').join("")
      +   '</select>'
      +   '<button class="btn btn-sm btn-primary eu-go" type="button">Change version</button>'
      + '</div>'
      + '<div class="term enc-upg-status" role="status" aria-live="polite"></div>';
    const sel = box.querySelector(".eu-sel"), go = box.querySelector(".eu-go"), st = box.querySelector(".enc-upg-status");
    const paint = (cls, txt) => paintLine(st, cls, txt);
    paint("info", "// paid time carries over: the runner restarts the app in place on the chosen version (~a minute); the endpoint and balance don’t change, app state is ephemeral");
    if (others.some(r => !r.shareFit))
      paint("dimln", "// disabled entries need more than this deployment’s " + (bought.gpuMilli ? (bought.gpuMilli / 10) + "% GPU / " : "") + (bought.cpuMilli / 10) + "% CPU - shares are immutable, those need a fresh deploy");
    if (others.some(r => r.shareFit && !r.feeFit))
      paint("dimln", "// entries charging a higher publisher fee than this deployment snapshotted at create need a fresh deploy - the fee snapshot is immutable, like the shares");
    const upd = () => { const r = rows.find(x => String(x.i) === sel.value); go.disabled = !r || r.i === cr.index || !r.fits; };
    sel.addEventListener("change", upd); upd();
    go.addEventListener("click", async () => {
      const r = rows.find(x => String(x.i) === sel.value);
      if (!r || r.i === cr.index || !r.fits) return;
      go.disabled = true;
      const via = ctlOf((this._list || []).find(x => x.id === id)) === "vault";
      try {
        if (via){
          // credit-vault row: the vault owns the deployment on-chain, so the
          // switch is a passkey-signed controlDeployment(setAppRef) via the relay
          paint("info", "[*] confirm the version change with your passkey…");
          const { vaultOp } = await import("../../js/core/vault.js");
          await vaultOp("control", { id, action: "version", ref: catalogRef(cr.appId, r.i) });
        } else {
          // no SIWE: the setAppRef tx is owner-gated on-chain - a connected wallet is all this needs
          if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
          await ensureBaseChain();
          paint("info", "[*] confirm the version-change transaction in your wallet…");
          const th = await sendTx(DEPLOYMENTS_ADDRESS, encCall(DEP_SEL.setAppRef,
            [{ t: "bytes32", v: id }, { t: "str", v: catalogRef(cr.appId, r.i) }]));
          paint("dimln", "  ↳ sent " + th + " · waiting for confirmation…");
          await waitReceipt(th);
        }
        if (this._why) this._why.delete(id);   // a pre-change decline reason must not outlive the switch
        // nudge the fleet: makes queued/suspended rows relaunch promptly (a
        // running one is restarted by its own runner's next ledger pass)
        fetch(Enclave.base + "/claim-hint", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
        paint("ok", "[✓] switched to " + app.slug + ":" + r.v.version + " - the runner applies it within a minute; paid time and the endpoint carry over");
        showToast("switched " + id.slice(0, 10) + "… to " + app.slug + ":" + r.v.version);
        setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); } this.refresh(); }, 3500);
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? (via ? "[x] cancelled - nothing changed" : "[x] rejected in wallet - nothing changed") : "[x] " + (e.message || String(e)));
        go.disabled = false;
      } finally { if (!via) refreshWallet(); }
    });
  }

  /* ---- per-row Output panel: recorded deploy narrative + live app logs ---- */
  _output(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-out"); if (!box) return;
    if (!box.hidden) { box.hidden = true; box.innerHTML = ""; this._stopLogPoll(id); btn.setAttribute("aria-expanded", "false"); return; }
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    // logs are NOT a live region: each poll replaces them wholesale (a live region would re-announce all 200 lines every 5s)
    box.innerHTML = '<div class="ap-attbar">output · ' + esc(id) + '</div>'
      + '<div class="term enc-out-term">'
      +   '<div class="enc-out-info"></div>'
      +   '<div class="enc-out-nar"></div>'
      +   '<div class="enc-out-logs" role="log" aria-live="off" aria-label="Deployment logs" tabindex="0"><span class="ln dimln">// fetching app logs…</span></div>'
      + '</div>';
    const nar = box.querySelector(".enc-out-nar"), scroller = box.querySelector(".enc-out-term");
    // lead with the OUTSIDE view - the app's reachable endpoints - because the
    // logs below speak in enclave-internal bind ports that match nothing out here
    const info = box.querySelector(".enc-out-info");
    const d = (this._list || []).find(x => x.id === id);
    if (info && d){
      const ep = appEndpoint(d);
      if (ep) paintLine(info, "ok", "→ reachable at " + ep + (d.public ? "" : "   (private · owner token required)"), scroller);
      const net = d.network || {};
      const tcp = (net.tcp && net.tcp.ports) || [], udp = (net.udp && net.udp.ports) || [];
      if (net.address)
        paintLine(info, "info", "→ dedicated IPv6 [" + net.address + "]"
          + (tcp.length ? " · tcp " + tcp.join(",") : "") + (udp.length ? " · udp " + udp.join(",") : "")
          + ((tcp.length || udp.length) ? "   (served at these real port numbers)" : "   (outbound egress address - no inbound ports declared)"), scroller);
      paintLine(info, "dimln", "// any 127.0.0.1:<port> below is the app's internal bind inside the enclave - from outside, use the endpoints above", scroller);
    }
    const run = runlog.runFor(id);
    if (run) {
      paintLine(nar, "dimln", "// deploy narrative · " + run.label + " (recorded in this browser)", scroller);
      run.lines.forEach(l => paintLine(nar, l[0], l[1], scroller));
    }
    if (ctlOf(d) !== "wallet") this._noteLogs(box);
    else if (Enclave.authed()) this._startLogs(id, box);
    else this._lockedLogs(id, box);
  }
  /* vault-owned rows: the enclaves' log read rides the in-enclave WALLET
     session (the credit vault is the on-chain owner, and only IT could prove
     ownership - ERC-1271 session support is tracked follow-up work). Honest
     note instead of an unlock that could never succeed. */
  _noteLogs(box) {
    const el = box.querySelector(".enc-out-logs"); if (!el) return;
    el.innerHTML = '<span class="ln dimln">// app logs for credit-run deployments are coming soon - today the log channel rides an in-enclave wallet session. The endpoints above are live now.</span>';
  }
  _startLogs(id, box) {
    this._fetchLogs(id, box);
    this._stopLogPoll(id);
    this._logPolls[id] = setInterval(() => {
      if (box.hidden || !box.isConnected) { this._stopLogPoll(id); return; }
      this._fetchLogs(id, box);
    }, 5000);
  }
  /* logs are the one genuinely PRIVATE read on this panel (an app's stdout
     routinely carries secrets), so this is where the lazy SIWE lives: prove
     key ownership once - a gas-free signature - right where it's needed */
  _lockedLogs(id, box) {
    const el = box.querySelector(".enc-out-logs"); if (!el) return;
    el.innerHTML = '<span class="ln dimln">// app logs are owner-private - one gas-free signature proves this wallet owns this deployment (lasts a week)</span>'
      + '<button class="wp-mini enc-unlock" type="button">unlock logs</button>';
    el.querySelector(".enc-unlock").addEventListener("click", async () => {
      try { await authenticate(); if (!box.hidden && box.isConnected) this._startLogs(id, box); }
      catch(e){ showToast(e.message || String(e)); }
    });
  }
  _stopLogPoll(id) {
    if (this._logPolls && this._logPolls[id]) { clearInterval(this._logPolls[id]); delete this._logPolls[id]; }
  }
  async _fetchLogs(id, box) {
    const el = box.querySelector(".enc-out-logs"), scroller = box.querySelector(".enc-out-term");
    if (!el) return;
    try {
      const text = await Enclave.logs(id, { tail: 200 });
      if (box.hidden || !el.isConnected) return;
      const lines = String(text == null ? "" : text).split("\n");
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      // wholesale replace each poll; keep the reader's place unless they're tailing
      const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      const keep = scroller.scrollTop;
      el.innerHTML = '<span class="ln dimln">// app logs (stdout/stderr from the enclave · tail 200 · refreshes while open)</span>';
      if (!lines.length) el.insertAdjacentHTML("beforeend", '<span class="ln dimln">// (no output yet)</span>');
      for (const ln of lines) {
        const s = document.createElement("span");
        // enclave-internal noise (loopback/wildcard binds) reads dim; real app output full-strength
        s.className = "ln " + (/127\.0\.0\.1|0\.0\.0\.0/.test(ln) ? "dimln" : "logln");
        s.textContent = ln; el.appendChild(s);
      }
      scroller.scrollTop = follow ? scroller.scrollHeight : keep;
    } catch (e) {
      if (el.isConnected && !box.hidden)
        el.innerHTML = '<span class="ln warn">// logs unavailable: ' + esc(e.message || String(e)) + '</span>';
    }
  }

  async _verify(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-att"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (ctlOf((this._list || []).find(x => x.id === id)) !== "wallet"){
      // vault/order rows: the per-deployment attestation read rides an
      // in-enclave wallet session the account doesn't hold - honest note
      // (ERC-1271 passkey sessions are the tracked follow-up)
      box.innerHTML = '<div class="ap-attbar">attestation · ' + esc(id) + '</div>'
        + '<div class="term"><span class="ln dimln">// in-browser attestation verification for credit-run deployments is coming soon - today the attestation read rides an in-enclave wallet session. The same hardware guarantees protect this deployment; verification just can’t be shown here yet.</span></div>';
      return;
    }
    if (!Enclave.authed()){
      // the attestation read rides the owner session; unlock it in place
      box.innerHTML = '<div class="ap-attbar">attestation · ' + esc(id) + '</div>'
        + '<div class="term"><span class="ln dimln">// attestation reads ride the owner session - one gas-free signature unlocks them (lasts a week)</span>'
        + '<button class="wp-mini enc-unlock" type="button">unlock &amp; verify</button></div>';
      box.querySelector(".enc-unlock").addEventListener("click", async () => {
        try { await authenticate(); if (!box.hidden && box.isConnected) this._attest(id, box); }
        catch(e){ showToast(e.message || String(e)); }
      });
      return;
    }
    this._attest(id, box);
  }
  async _attest(id, box) {
    box.innerHTML = '<div class="ap-attbar">attestation · ' + esc(id)
      + '<span class="enc-vbadge">⏳ verifying in your browser…</span></div>'
      + '<pre class="ap-attpre">fetching…</pre>';
    const badge = box.querySelector(".enc-vbadge");
    try {
      const att = await Enclave.attestation(id);
      const pre = box.querySelector(".ap-attpre"); if (pre) pre.innerHTML = hlJson(att);
      const vspec = vspecOf(att);
      if (!vspec){ if (badge) badge.textContent = ""; return; }
      // the badge is computed HERE, in the customer's browser; the API's
      // verification.selfCheck is the enclave's own (labeled) diagnostic.
      try {
        const r = await verifyEnclaveInBrowser(vspec);
        if (!badge || box.hidden) return;
        if (r.ok){
          badge.className = "enc-vbadge ok"; badge.textContent = "✓ verified in your browser";
          badge.title = "hardware report → silicon vendor's root of trust (AMD SEV-SNP on today's fleet; Intel TDX via DCAP), Sigstore release provenance, measurement match and cert binding, checked client-side against " + r.repo + " (enclave " + r.host + ")";
        } else {
          badge.className = "enc-vbadge bad"; badge.textContent = "✗ not verified: " + (r.error || "check failed");
        }
      } catch(e){ if (badge && !box.hidden){ badge.className = "enc-vbadge bad"; badge.textContent = "✗ could not verify: " + (e.message || e); } }
    }
    catch(e){ const pre = box.querySelector(".ap-attpre"); if (pre) pre.textContent = e.message; if (badge) badge.textContent = ""; }
  }

  async _kill(id, btn) {
    const onchain = /^0x[0-9a-f]{64}$/i.test(id);
    if (btn){ btn.disabled = true; btn.textContent = onchain ? "suspending…" : "terminating…"; }
    if (ctlOf((this._list || []).find(x => x.id === id)) === "vault"){
      // vault-owned row: setActive(false) goes through the vault contract,
      // passkey-signed - the runner's owner-stop watcher sees the ledger flip
      // and tears the app down within a minute (same suspend semantics)
      try {
        const { vaultOp } = await import("../../js/core/vault.js");
        await vaultOp("control", { id, action: "suspend" });
        showToast("suspended " + id.slice(0, 10) + "… - the remaining balance stays on it; Resume restarts it any time");
        setTimeout(() => this.refresh(), 900);
      } catch(e){ showToast(e.message || String(e)); if (btn){ btn.disabled = false; btn.textContent = "Suspend"; } }
      return;
    }
    try {
      // On-chain deployments (bytes32 ids) are WORK ITEMS: the enclave DELETE
      // only releases the current lease - any enclave would re-claim while the
      // record stays active and funded. A real stop is the owner's
      // setActive(false) on the ledger (one wallet tx), then the enclave release.
      // The remaining balance stays on the record and setActive(true) re-queues
      // it, so for on-chain rows this is a SUSPEND, not an end.
      if (onchain){
        showToast("confirm setActive(false) in your wallet - this suspends the app and takes it off the queue");
        await ensureBaseChain();
        const th = await sendTx(DEPLOYMENTS_ADDRESS, "0x" + DEP_SEL.setActive + pad32(id.replace(/^0x/, "")) + encUint(0));
        await waitReceipt(th);
      }
      const r = await Enclave.terminateDeployment(id).catch(e => {
        // the enclave's owner-stop watcher may already have torn it down
        if (onchain) return null;
        throw e;
      });
      showToast(onchain
        ? "suspended " + id.slice(0, 10) + "… - the remaining balance stays on it; Resume restarts it any time"
        : (r && r.status === "terminated" ? "terminated " : "terminating ") + id);
      setTimeout(() => this.refresh(), 900);
    }
    catch(e){ showToast(e.message); if (btn){ btn.disabled = false; btn.textContent = onchain ? "Suspend" : "Terminate"; } }
  }

  /* ---- restart a running deployment in place: stop the app instance and
     relaunch it on the same version, lease and balance (no wallet tx - the
     enclave API does it under the owner session). The remedy for a wedged
     instance the crash detector can't see: the process answers, it just
     can't do its job - e.g. a tenant that booted before its model volume
     finished mounting and so can never load the model. App state is
     ephemeral by design, so a restart never loses anything but the wedge. ---- */
  async _restart(id, btn) {
    if (btn){ btn.disabled = true; btn.textContent = "restarting…"; }
    try {
      // owner-private action: rides the session token, lazy-SIWE like logs
      if (!Enclave.authed()) await authenticate();
      await Enclave.restartDeployment(id);
      showToast("restarted " + id.slice(0, 10) + "… - relaunching in place, back within a minute");
      setTimeout(() => this.refresh(), 1200);
    }
    catch(e){ showToast(e.message || String(e)); }
    finally { if (btn){ btn.disabled = false; btn.textContent = "Restart"; } }
  }

  /* ---- resume a suspended on-chain deployment: setActive(true) re-queues
     the work item (the balance never left it), then one claim-hint nudges the
     fleet so the relaunch doesn't wait for the next sweep - the ex-runner
     itself may re-adopt (terminated is CLAIM_TERMINAL). The app relaunches
     FRESH from its published version: suspend/resume preserves money, not
     memory (app state is ephemeral by design). ---- */
  async _resume(id, btn) {
    if (btn){ btn.disabled = true; btn.textContent = "resuming…"; }
    const via = ctlOf((this._list || []).find(x => x.id === id)) === "vault";
    try {
      if (via){
        // vault-owned row: setActive(true) through the vault, passkey-signed
        const { vaultOp } = await import("../../js/core/vault.js");
        await vaultOp("control", { id, action: "resume" });
      } else {
        showToast("confirm setActive(true) in your wallet - this re-queues the app; billing resumes once it runs");
        await ensureBaseChain();
        const th = await sendTx(DEPLOYMENTS_ADDRESS, "0x" + DEP_SEL.setActive + pad32(id.replace(/^0x/, "")) + encUint(1));
        await waitReceipt(th);
      }
      if (this._why) this._why.delete(id);   // a pre-suspend decline reason must not outlive the resume
      fetch(Enclave.base + "/claim-hint", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
      showToast("resumed " + id.slice(0, 10) + "… - re-queued; an enclave picks it up shortly");
      setTimeout(() => this.refresh(), 900);
    }
    catch(e){ showToast(e.message); if (btn){ btn.disabled = false; btn.textContent = "Resume"; } }
  }

  _startPoll() {
    if (this._poll) return;
    this._poll = setInterval(() => {
      if (!Enclave.address && !Enclave.accountAuthed()){ this._stopPoll(); return; }
      if (this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden]), .enc-upg:not([hidden])")) return;   // don't clobber an open attestation/output/top-up view
      this.refresh();
    }, 10000);
  }
  _stopPoll() { if (this._poll){ clearInterval(this._poll); this._poll = null; } }
}
register("c-deployments", Deployments);
