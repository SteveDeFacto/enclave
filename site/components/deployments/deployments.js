/* ============================================================
   <c-deployments> — the "My Apps" panel: the signed-in
   wallet's deployments, each with status, spend, its app origin,
   its dedicated IPv6 (when the deployment declares tcp/udp
   ports), in-browser attestation verification, and terminate.
   Polls while authed; repaints on `enclave:auth` sign-in/out edges.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { $$, esc, hlJson, fmtDur, statusCls, copyText, showToast } from "../../js/core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { pad32, encUint, DEP_SEL, waitReceipt } from "../../js/core/chain.js";
import { authenticate, refreshWallet, saveSession, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { slugOfRef } from "../../js/core/catalog.js";
import { vspecOf, verifyEnclaveInBrowser } from "../../js/core/verify.js";
import { runlog, paintLine } from "../../js/core/runlog.js";

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
  return '<button class="enc-ep" data-ep="' + esc(net.address) + '" title="dedicated IPv6 — this deployment\'s own address: tcp/udp ports are served on it at their real port numbers, and its outbound traffic egresses from it">'
    + 'ip6 [' + esc(net.address) + ']' + esc(ports) + ' ⧉</button>';
}

class Deployments extends EnclaveElement {
  static templateUrl = new URL("./deployments.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._logPolls = {};                       // open Output panels' log timers, by id
    this.querySelector(".enc-refresh").addEventListener("click", () => this.refresh({ spinner: true }));
    // document-level listeners must be removable: the soft-nav router mounts a
    // fresh instance per visit, and detached ones must not keep refreshing
    this._onAuth = (e) => this.refresh({ spinner: !!(e.detail && e.detail.spinner) });
    document.addEventListener("enclave:auth", this._onAuth);
    this._onLog = (e) => this._onRunlog(e.detail || {});
    document.addEventListener("enclave:runlog", this._onLog);
    const x = this.querySelector(".enc-live-x");
    if (x) x.addEventListener("click", () => { const s = this.querySelector(".enc-live"); if (s) s.hidden = true; });
    // arriving mid-deploy (soft-nav away and back): replay the live run
    const live = runlog.current();
    if (live) { this._showLive(live); live.lines.forEach(l => paintLine(this.querySelector(".enc-live-out"), l[0], l[1])); }
    this.refresh();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPoll();
    Object.keys(this._logPolls || {}).forEach(id => this._stopLogPoll(id));
    if (this._onAuth) document.removeEventListener("enclave:auth", this._onAuth);
    if (this._onLog) document.removeEventListener("enclave:runlog", this._onLog);
    this._wired = false; this._onAuth = null; this._onLog = null;
  }

  /* ---- the live-deploy strip: a run streaming with no row to live in ---- */
  _showLive(run) {
    this._liveRun = run;
    const s = this.querySelector(".enc-live"), out = this.querySelector(".enc-live-out"), lbl = this.querySelector(".enc-live-lbl");
    if (!s) return;
    s.hidden = false; if (out) out.innerHTML = "";
    if (lbl) lbl.textContent = run.id || run.label || "";
  }
  _onRunlog(d) {
    const s = this.querySelector(".enc-live");
    if (d.type === "start") this._showLive(d.run);
    else if (d.type === "id") {
      const lbl = this.querySelector(".enc-live-lbl"); if (lbl && this._liveRun === d.run) lbl.textContent = d.run.id;
    }
    else if (d.type === "line") {
      if (this._liveRun === d.run) paintLine(this.querySelector(".enc-live-out"), d.cls, d.txt);
      // a row's open Output panel for this deployment follows the narrative too
      if (d.run.id) { const nar = this._openNar(d.run.id); if (nar) paintLine(nar.box, d.cls, d.txt, nar.scroller); }
    }
    else if (d.type === "end") {
      // the row (with its Output panel) carries the history from here; keep
      // the strip only for runs that died before an id existed
      if (d.run.id && s) { s.hidden = true; this._liveRun = null; }
    }
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
    const setCount = t => { if (count) count.textContent = t || ""; };
    if (!Enclave.address){
      setCount(""); this._stopPoll();
      body.innerHTML = '<div class="enc-empty">Connect your wallet (above) to see your enclaves.</div>'; return;
    }
    if (!Enclave.authed()){
      setCount(""); this._stopPoll();
      body.innerHTML = '<div class="enc-empty">Sign in with your wallet to load your enclaves: <button class="wp-mini enc-signin" type="button">sign in</button></div>';
      const b = body.querySelector(".enc-signin"); if (b) b.addEventListener("click", async () => { try { await authenticate(); } catch(e){ showToast(e.message); } });
      return;
    }
    if (!body.querySelector(".enc-row") || opts.spinner) body.innerHTML = '<div class="enc-empty">loading your enclaves…</div>';
    try {
      const res = await Enclave.listDeployments();
      const list = Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || []);
      this._renderRows(list, opts.highlight);
      this._startPoll();
    } catch(e){
      if (e.status === 401){ Enclave.token = null; saveSession(); refreshWallet(); this._stopPoll();
        body.innerHTML = '<div class="enc-empty">session expired: <button class="wp-mini enc-signin" type="button">sign in</button></div>';
        const b = body.querySelector(".enc-signin"); if (b) b.addEventListener("click", async () => { try { await authenticate(); } catch(_){} });
        return;
      }
      body.innerHTML = '<div class="enc-empty">couldn’t load enclaves: ' + esc(e.message || String(e)) + '</div>';
    }
  }

  _renderRows(list, highlight) {
    const body = this.querySelector(".enc-body"), count = this.querySelector(".enc-count");
    list = (list || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const running = list.filter(d => d.status === "running").length;
    if (count) count.textContent = list.length ? (running + " running · " + list.length + " total") : "";
    if (!list.length){ body.innerHTML = '<div class="enc-empty">No enclaves yet. <a href="apps.html#deploy">Deploy one →</a></div>'; return; }
    body.innerHTML = list.map(d => {
      const ep = appEndpoint(d), st = d.status || "–";
      const bud = (d.paidUsdc != null)
        ? (esc(d.paidUsdc) + " USDC paid" + (d.timeRemainingSec != null ? " · " + esc(fmtDur(d.timeRemainingSec)) + " left" : "")
           + (d.paused ? " · ⏸ time frozen (" + esc(d.pauseReason || "outage") + ", resumes when service is restored)" : ""))
        : "–";
      const live = ["running", "provisioning", "queued", "pending"].indexOf(st) !== -1;
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
            '<button class="btn btn-sm enc-verify" data-id="' + esc(d.id) + '">Verify</button>' +
            (live ? '<button class="btn btn-sm danger enc-kill" data-id="' + esc(d.id) + '">Terminate</button>' : '') +
          '</span>' +
        '</div>' +
        ((st === "failed" || st === "expired") && d.error ? '<div class="enc-err" title="why this deployment ' + esc(st) + '">⚠ ' + esc(d.error) + '</div>' : '') +
        (ep ? '<button class="enc-ep" data-ep="' + esc(ep) + '">' + esc(ep) + ' ⧉</button>'
              + (d.public && st === "running" ? '<a class="enc-open" href="' + esc(ep) + '/" target="_blank" rel="noopener">open ↗</a>' : '') : '') +
        depIp6Row(d) +
        '<div class="enc-out" data-id="' + esc(d.id) + '" hidden></div>' +
        '<div class="enc-att" hidden></div>' +
      '</div>';
    }).join("");
    $$(".enc-id", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
    $$(".enc-ep", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.ep)));
    $$(".enc-outbtn", body).forEach(b => b.addEventListener("click", () => this._output(b.dataset.id, b)));
    $$(".enc-verify", body).forEach(b => b.addEventListener("click", () => this._verify(b.dataset.id, b)));
    $$(".enc-kill", body).forEach(b => b.addEventListener("click", () => this._kill(b.dataset.id, b)));
    // a just-deployed row opens its Output panel so the narrative continues in place
    if (highlight) {
      const b = body.querySelector('.enc-outbtn[data-id="' + highlight + '"]');
      if (b && runlog.runFor(highlight)) this._output(highlight, b);
    }
  }

  /* ---- per-row Output panel: recorded deploy narrative + live app logs ---- */
  _output(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-out"); if (!box) return;
    if (!box.hidden) { box.hidden = true; box.innerHTML = ""; this._stopLogPoll(id); return; }
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">output · ' + esc(id) + '</div>'
      + '<div class="term enc-out-term">'
      +   '<div class="enc-out-nar"></div>'
      +   '<div class="enc-out-logs"><span class="ln dimln">// fetching app logs…</span></div>'
      + '</div>';
    const nar = box.querySelector(".enc-out-nar"), scroller = box.querySelector(".enc-out-term");
    const run = runlog.runFor(id);
    if (run) {
      paintLine(nar, "dimln", "// deploy narrative · " + run.label + " (recorded in this browser)", scroller);
      run.lines.forEach(l => paintLine(nar, l[0], l[1], scroller));
    }
    this._fetchLogs(id, box);
    this._logPolls[id] = setInterval(() => {
      if (box.hidden || !box.isConnected) { this._stopLogPoll(id); return; }
      this._fetchLogs(id, box);
    }, 5000);
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
      for (const ln of lines) { const s = document.createElement("span"); s.className = "ln logln"; s.textContent = ln; el.appendChild(s); }
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
      if (!Enclave.authed()){ this._stopPoll(); return; }
      if (this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden])")) return;   // don't clobber an open attestation/output view
      this.refresh();
    }, 10000);
  }
  _stopPoll() { if (this._poll){ clearInterval(this._poll); this._poll = null; } }
}
register("c-deployments", Deployments);
