/* ============================================================
   <c-deployments> - the "My Apps" panel: the signed-in
   wallet's deployments, each with status, spend, its app origin,
   its dedicated IPv6 (when the deployment declares tcp/udp
   ports), in-browser attestation verification, and terminate.
   Polls while a wallet is connected; follows `enclave:wallet`
   address edges (async session restore, account switches) and
   `enclave:auth` sign-in edges.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { $$, esc, hlJson, fmtDur, statusCls, copyText, showToast, lsGet, lsSet } from "../../js/core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { pad32, encUint, DEP_SEL, depPrices6, rate6Of, waitReceipt } from "../../js/core/chain.js";
import { authenticate, connectWallet, refreshWallet, saveSession, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { slugOfRef } from "../../js/core/catalog.js";
import { vspecOf, verifyEnclaveInBrowser } from "../../js/core/verify.js";
import { runlog, paintLine } from "../../js/core/runlog.js";
import { payForRuntime } from "../../js/core/fund.js";
import { shareRates } from "../../js/core/pricing.js";

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

function shortImg(s){ if (!s) return ""; return s.length > 44 ? s.slice(0, 42) + "…" : s; }
// Status buckets for the filter bar: coarse groups beat ten raw statuses.
// Unknown/new statuses land in "ended" rather than vanishing.
const FILTER_KEY = "enclave_dash_filters";
const BUCKETS = ["running", "starting", "ended", "failed"];
function bucketOf(st){
  st = String(st || "").toLowerCase();
  if (st === "running") return "running";
  // "claimed"/"queued"/"awaiting_payment" include LEDGER rows (the API merges
  // on-chain records the fleet isn't hosting right now): on their way, not over
  if (["provisioning", "queued", "pending", "claiming", "claimed", "starting", "created", "awaiting_payment"].indexOf(st) !== -1) return "starting";
  if (["failed", "error"].indexOf(st) !== -1) return "failed";
  return "ended";   // stopped, stopping, terminated, expired, …
}
function encTier(d){
  const r = d.resources || {};
  const g = r.gpuShare || 0, c = r.cpuShare != null ? r.cpuShare : (r.share || 0);
  if (g > 0) return Math.round(g * 100) + "% GPU · " + Math.round(c * 100) + "% CPU";
  return c ? (Math.round(c * 100) + "% CPU") : "CPU";
}
// A deployment's DEDICATED IPv6 (per-deployment addressing): declared tcp/udp
// ports are served at [address]:<logical port> via the relays, and outbound
// connections (dedicated-IP egress) leave from the same address. Rendered as
// its own copyable row when the API surfaces network.address.
function depIp6Row(d){
  const net = d.network || {};
  if (!net.address) return "";
  const tcp = (net.tcp && net.tcp.ports) || [];
  const udp = (net.udp && net.udp.ports) || [];
  const ports = (tcp.length ? " · tcp " + tcp.join(",") : "") + (udp.length ? " · udp " + udp.join(",") : "");
  return '<button class="enc-ep" data-ep="' + esc(net.address) + '" title="dedicated IPv6 - this deployment\'s own address: tcp/udp ports are served on it at their real port numbers, and its outbound traffic egresses from it">'
    + 'ip6 [' + esc(net.address) + ']' + esc(ports) + ' ⧉</button>';
}

class Deployments extends EnclaveElement {
  static templateUrl = new URL("./deployments.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._logPolls = {};                       // open Output panels' log timers, by id
    this._strips = new Map();                  // live-deploy strips, keyed by run record
    this.querySelector(".enc-refresh").addEventListener("click", () => this.refresh({ spinner: true }));
    // status filter: persisted set of enabled buckets (default: all on)
    let saved = null; try { saved = JSON.parse(lsGet(FILTER_KEY) || "null"); } catch (e) {}
    this._filters = new Set(Array.isArray(saved) ? saved.filter(b => BUCKETS.indexOf(b) !== -1) : BUCKETS);
    $$(".enc-filters input[data-bucket]", this).forEach(i => {
      i.checked = this._filters.has(i.dataset.bucket);
      i.addEventListener("change", () => {
        if (i.checked) this._filters.add(i.dataset.bucket); else this._filters.delete(i.dataset.bucket);
        lsSet(FILTER_KEY, JSON.stringify([...this._filters]));
        this._renderRows(this._list || []);
      });
    });
    // document-level listeners must be removable: the soft-nav router mounts a
    // fresh instance per visit, and detached ones must not keep refreshing.
    // A sign-in mid-view (the lazy log/attestation unlock) must NOT clobber
    // the open panel the user just unlocked - skip the repaint, the poll
    // catches up once the panel closes.
    this._onAuth = (e) => {
      if (Enclave.address && this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden])")) return;
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
    this.refresh();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPoll();
    Object.keys(this._logPolls || {}).forEach(id => this._stopLogPoll(id));
    if (this._onAuth) document.removeEventListener("enclave:auth", this._onAuth);
    if (this._onWallet) document.removeEventListener("enclave:wallet", this._onWallet);
    if (this._onLog) document.removeEventListener("enclave:runlog", this._onLog);
    this._wired = false; this._onAuth = null; this._onWallet = null; this._onLog = null;
  }

  /* ---- live-deploy strips: one per run streaming with no row to live in ---- */
  _strip(run, create) {
    let s = this._strips.get(run);
    if (s || create === false) return s || null;
    const wrap = this.querySelector(".enc-lives"); if (!wrap) return null;
    s = document.createElement("div");
    s.className = "enc-live";
    s.innerHTML = '<div class="enc-live-bar"><span class="elb-k">deploying</span><span class="enc-live-lbl"></span><button class="enc-live-x" type="button" title="dismiss">✕</button></div>'
      + '<div class="term enc-live-out"></div>';
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
  }
  _openNar(id) {
    const row = this.querySelector('.enc-out[data-id="' + id + '"]:not([hidden])');
    if (!row) return null;
    return { box: row.querySelector(".enc-out-nar"), scroller: row.querySelector(".enc-out-term") };
  }

  async refresh(opts) {
    opts = opts || {};
    const body = this.querySelector(".enc-body"), count = this.querySelector(".enc-count");
    if (!body) return;
    this._paintedFor = Enclave.address;   // what this paint reflects (see _onWallet)
    const setCount = t => { if (count) count.textContent = t || ""; };
    const hideBar = () => { const fb = this.querySelector(".enc-filters"); if (fb) fb.hidden = true; };
    if (!Enclave.address){
      setCount(""); this._stopPoll(); hideBar();
      body.innerHTML = '<div class="enc-empty">Connect your wallet (above) to see your enclaves.</div>'; return;
    }
    // NO sign-in wall: a connected wallet is enough - the list is public
    // ledger data, scoped by address (api.js adds ?owner= when tokenless);
    // a session only enriches rows with the enclaves' live view
    if (!body.querySelector(".enc-row") || opts.spinner) body.innerHTML = '<div class="enc-empty">loading your enclaves…</div>';
    try {
      const res = await Enclave.listDeployments();
      const list = Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || []);
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
    const body = this.querySelector(".enc-body"), count = this.querySelector(".enc-count");
    list = (list || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    this._list = list;
    const counts = { running: 0, starting: 0, ended: 0, failed: 0 };
    list.forEach(d => { counts[bucketOf(d.status)]++; });
    const bar = this.querySelector(".enc-filters");
    if (bar) {
      bar.hidden = !list.length;
      $$("input[data-bucket]", bar).forEach(i => { const b = i.closest("label").querySelector("b"); if (b) b.textContent = String(counts[i.dataset.bucket] || 0); });
    }
    const shown = list.filter(d => this._filters.has(bucketOf(d.status)));
    if (count) count.textContent = list.length
      ? (counts.running + " running · " + list.length + " total" + (shown.length !== list.length ? " · " + shown.length + " shown" : ""))
      : "";
    if (!list.length){ body.innerHTML = '<div class="enc-empty">No enclaves yet. <a href="apps/deploy">Deploy one →</a></div>'; return; }
    if (!shown.length){ body.innerHTML = '<div class="enc-empty">Nothing matches the status filter - tick more boxes above.</div>'; return; }
    body.innerHTML = shown.map(d => {
      const ep = appEndpoint(d), st = d.status || "–";
      const bud = (d.paidUsdc != null)
        ? (esc(d.paidUsdc) + " USDC paid" + (d.timeRemainingSec != null ? " · " + esc(fmtDur(d.timeRemainingSec)) + " left" : "")
           + (d.paused ? " · ⏸ time frozen (" + esc(d.pauseReason || "outage") + ", resumes when service is restored)" : ""))
        : "–";
      // on-chain rows without a live runner stay actionable: queued/claimed
      // work can be topped up, and awaiting_payment is Top up's whole point
      const live = ["running", "provisioning", "queued", "pending", "claiming", "claimed", "awaiting_payment"].indexOf(st) !== -1;
      return '<div class="enc-row' + (highlight && d.id === highlight ? " enc-new" : "") + '">' +
        '<div class="enc-main">' +
          '<span class="ap-badge ' + statusCls(st) + '">' + esc(st) + '</span>' +
          '<span class="ap-badge ' + (d.public ? 'ep-public' : 'ep-private') + '" title="' + (d.public ? 'anyone can reach the app endpoint' : 'only your wallet token can reach the app') + '">' + (d.public ? 'public' : 'private') + '</span>' +
          '<button class="enc-id" data-copy="' + esc(d.id) + '">' + esc(d.id) + ' ⧉</button>' +
          '<span class="enc-br" aria-hidden="true"></span>' +
          '<span class="enc-meta">' + esc(encTier(d)) + ((d.image && d.image.reference) ? ' · <span class="dim">' + esc(slugOfRef(d.image.reference) || shortImg(d.image.reference)) + '</span>' : '') + '</span>' +
          '<span class="enc-spend">' + bud + '</span>' +
          '<span class="enc-acts">' +
            '<button class="btn btn-sm enc-outbtn" data-id="' + esc(d.id) + '">Output</button>' +
            (live ? '<button class="btn btn-sm enc-fundbtn" data-id="' + esc(d.id) + '" title="Add runtime - a gas-free USDC signature credits the deployment’s on-chain balance">Top up</button>' : '') +
            '<button class="btn btn-sm enc-verify" data-id="' + esc(d.id) + '">Verify</button>' +
            (live ? '<button class="btn btn-sm danger enc-kill" data-id="' + esc(d.id) + '">Terminate</button>' : '') +
          '</span>' +
        '</div>' +
        ((st === "failed" || st === "expired") && d.error ? '<div class="enc-err" title="why this deployment ' + esc(st) + '">⚠ ' + esc(d.error) + '</div>' : '') +
        (ep ? '<button class="enc-ep" data-ep="' + esc(ep) + '">' + esc(ep) + ' ⧉</button>'
              + (d.public && st === "running" ? '<a class="enc-open" href="' + esc(ep) + '/" target="_blank" rel="noopener">open ↗</a>' : '') : '') +
        depIp6Row(d) +
        '<div class="enc-fund" hidden></div>' +
        '<div class="enc-out" data-id="' + esc(d.id) + '" hidden></div>' +
        '<div class="enc-att" hidden></div>' +
      '</div>';
    }).join("");
    $$(".enc-id", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
    $$(".enc-ep", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.ep)));
    $$(".enc-outbtn", body).forEach(b => b.addEventListener("click", () => this._output(b.dataset.id, b)));
    $$(".enc-fundbtn", body).forEach(b => b.addEventListener("click", () => this._fund(b.dataset.id, b)));
    $$(".enc-verify", body).forEach(b => b.addEventListener("click", () => this._verify(b.dataset.id, b)));
    $$(".enc-kill", body).forEach(b => b.addEventListener("click", () => this._kill(b.dataset.id, b)));
    // finished runs' strips yield to their rows the moment those render
    [...this._strips.keys()].forEach(r => this._retireStrip(r));
    // a just-deployed row opens its Output panel so the narrative continues in place
    if (highlight) {
      const b = body.querySelector('.enc-outbtn[data-id="' + highlight + '"]');
      if (b && runlog.runFor(highlight)) this._output(highlight, b);
    }
  }

  /* ---- per-row Top up: extend a deployment's runtime in place. One amount,
     the runtime it adds at this deployment's own rate, one gas-free USDC
     signature (EIP-3009 -> fundWithAuthorization; same flow as deploying). ---- */
  _fund(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-fund"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; return; }
    const d = (this._list || []).find(x => x.id === id) || {};
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
      +   '<label for="efAmt">Add runtime (USDC)</label>'
      +   '<input class="ef-amt" id="efAmt" type="number" value="5" min="0.01" step="any" inputmode="decimal" />'
      +   '<span class="ef-est"></span>'
      +   '<button class="btn btn-sm btn-primary ef-go" type="button">Sign &amp; pay</button>'
      + '</div>'
      + '<div class="term enc-fund-status"></div>';
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

  /* ---- per-row Output panel: recorded deploy narrative + live app logs ---- */
  _output(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-out"); if (!box) return;
    if (!box.hidden) { box.hidden = true; box.innerHTML = ""; this._stopLogPoll(id); return; }
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">output · ' + esc(id) + '</div>'
      + '<div class="term enc-out-term">'
      +   '<div class="enc-out-info"></div>'
      +   '<div class="enc-out-nar"></div>'
      +   '<div class="enc-out-logs"><span class="ln dimln">// fetching app logs…</span></div>'
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
          + "   (served at these real port numbers)", scroller);
      paintLine(info, "dimln", "// any 127.0.0.1:<port> below is the app's internal bind inside the enclave - from outside, use the endpoints above", scroller);
    }
    const run = runlog.runFor(id);
    if (run) {
      paintLine(nar, "dimln", "// deploy narrative · " + run.label + " (recorded in this browser)", scroller);
      run.lines.forEach(l => paintLine(nar, l[0], l[1], scroller));
    }
    if (Enclave.authed()) this._startLogs(id, box);
    else this._lockedLogs(id, box);
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
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
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
          badge.title = "AMD SEV-SNP report → AMD root, Sigstore release provenance, measurement match and cert binding, checked client-side against " + r.repo + " (enclave " + r.host + ")";
        } else {
          badge.className = "enc-vbadge bad"; badge.textContent = "✗ not verified: " + (r.error || "check failed");
        }
      } catch(e){ if (badge && !box.hidden){ badge.className = "enc-vbadge bad"; badge.textContent = "✗ could not verify: " + (e.message || e); } }
    }
    catch(e){ const pre = box.querySelector(".ap-attpre"); if (pre) pre.textContent = e.message; if (badge) badge.textContent = ""; }
  }

  async _kill(id, btn) {
    if (btn){ btn.disabled = true; btn.textContent = "terminating…"; }
    try {
      // On-chain deployments (bytes32 ids) are WORK ITEMS: the enclave DELETE
      // only releases the current lease - any enclave would re-claim while the
      // record stays active and funded. A real stop is the owner's
      // setActive(false) on the ledger (one wallet tx), then the enclave release.
      if (/^0x[0-9a-f]{64}$/i.test(id)){
        showToast("confirm setActive(false) in your wallet - this takes it off the queue");
        await ensureBaseChain();
        const th = await sendTx(DEPLOYMENTS_ADDRESS, "0x" + DEP_SEL.setActive + pad32(id.replace(/^0x/, "")) + encUint(0));
        await waitReceipt(th);
      }
      const r = await Enclave.terminateDeployment(id).catch(e => {
        // the enclave's owner-stop watcher may already have torn it down
        if (/^0x[0-9a-f]{64}$/i.test(id)) return null;
        throw e;
      });
      showToast((r && r.status === "terminated" ? "terminated " : "terminating ") + id);
      setTimeout(() => this.refresh(), 900);
    }
    catch(e){ showToast(e.message); if (btn){ btn.disabled = false; btn.textContent = "Terminate"; } }
  }

  _startPoll() {
    if (this._poll) return;
    this._poll = setInterval(() => {
      if (!Enclave.address){ this._stopPoll(); return; }
      if (this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden])")) return;   // don't clobber an open attestation/output/top-up view
      this.refresh();
    }, 10000);
  }
  _stopPoll() { if (this._poll){ clearInterval(this._poll); this._poll = null; } }
}
register("c-deployments", Deployments);
