/* ============================================================
   Apps page — the on-chain catalog store. Each listing renders
   as a <c-app-card>; the page owns the toolbar (filter/search),
   the publish form, and the wallet transactions the cards
   request via `card-action` events.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/app-card/app-card.js";
import { $, $$, esc, short, blen, showToast, on } from "../core/util.js";
import { APP_CATALOG_ADDRESS, APP_CATALOG_CHAIN, IPFS_UPLOAD_URL, MAX_WASM_MB, MAX_WASM_BYTES, BASE_CHAIN } from "../core/config.js";
import { Nan, NanError } from "../core/api.js";
import { catConfigured, catExplorer, encCall, CAT_SEL, CAT_MAX, APPROVAL, waitReceipt } from "../core/chain.js";
import { connectWallet, ensureBaseChain, sendTx } from "../core/wallet.js";
import { STORE, loadCatalog, selIdx, appVerified, validPortsCsv, REF_CACHE, PORTS_CACHE, MINS_CACHE } from "../core/catalog.js";
import { minPctsOf } from "../core/pricing.js";
import { navigate } from "../boot.js";

/* ---- render: filter + sort the catalog into <c-app-card>s ---- */
function renderApps(){
  const grid = $("#storeGrid"), count = $("#storeCount"); if (!grid) return;
  if (!catConfigured()){
    grid.innerHTML = '<div class="store-note">The on-chain catalog isn’t wired up on this deployment yet.<br><span class="dim">Deploy <code>NanAppCatalog</code> with <code>scripts/deploy-app-catalog.mjs</code>; it writes the address in for you.</span></div>';
    if (count) count.textContent = ""; return;
  }
  if (!STORE.loaded){ grid.innerHTML = '<div class="store-note">reading catalog from Base…</div>'; return; }
  const q = ($("#storeSearch") && $("#storeSearch").value || "").trim().toLowerCase();
  // Delisted apps are hidden from the public store, but their PUBLISHER (and
  // the catalog owner) still see them - that's the only path back: relist, or
  // publish a new version to the slug (which auto-relists).
  const me = (Nan.address || "").toLowerCase();
  const canSeeDelisted = (a) => me && (a.publisher.toLowerCase() === me || (STORE.owner && me === STORE.owner));
  let apps = STORE.apps.filter(a => a.versions.length && (a.active || canSeeDelisted(a)));
  if (STORE.filter === "verified") apps = apps.filter(appVerified);
  if (q) apps = apps.filter(a => (a.name + " " + a.description + " " + a.slug + " " + a.publisher + " " + a.versions.map(v => v.cid + " " + v.version).join(" ")).toLowerCase().includes(q));
  apps.sort((x, y) => (Number(appVerified(y)) - Number(appVerified(x))) || (y.updatedAt - x.updatedAt));
  if (count) count.textContent = apps.length + (apps.length === 1 ? " app" : " apps") + (STORE.filter === "verified" ? " · verified" : "");
  if (!apps.length){
    grid.innerHTML = '<div class="store-note">' + (STORE.apps.length ? "No apps match your filter." : "No apps published yet. Be the first with <b>+ Publish app</b>.") + '</div>';
    return;
  }
  grid.replaceChildren(...apps.map(a => {
    const el = document.createElement("c-app-card");
    el.app = a;
    return el;
  }));
}

// Hand the picked version to the Deploy page: stash everything it needs
// (sessionStorage survives the navigation; the ?app= param makes the link
// shareable - a fresh visitor's deploy page re-resolves it from the catalog).
function useInDeploy(app, v){
  const friendly = app.slug + ":" + v.version;      // human-friendly; resolves to the CID at deploy
  REF_CACHE[friendly] = "ipfs://" + v.cid;
  PORTS_CACHE[friendly] = v.ports || "";
  MINS_CACHE[friendly] = minPctsOf(v);
  try {
    sessionStorage.setItem("nan_use_in_deploy", JSON.stringify({
      friendly, cid: v.cid, ports: v.ports || "", mins: MINS_CACHE[friendly] }));
  } catch(e){}
  navigate("deploy.html?app=" + encodeURIComponent(friendly), { push: true });
}

/* ---- write side: IPFS upload + publish/verify/yank/delist txs ---- */
// Client-side sanity checks (UX + catch mistakes). NOT a security control: the
// /add endpoint is public, so Caddy's request_body max_size is the real ceiling,
// and the attested wasm-manager is the authoritative "is it a runnable component"
// gate at deploy. WebAssembly.validate() can't help: it only validates core
// modules, and Enclave apps are components, so we check the binary preamble by hand.
async function validateWasm(file){
  if (!/\.wasm$/i.test(file.name || "")) throw new NanError("Pick a .wasm file.", 0);
  if (file.size < 8) throw new NanError("That file is too small to be a WebAssembly module.", 0);
  if (file.size > MAX_WASM_BYTES) throw new NanError("Too large: max " + MAX_WASM_MB + " MB (this file is " + (file.size / 1048576).toFixed(1) + " MB).", 0);
  const h = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!(h[0] === 0x00 && h[1] === 0x61 && h[2] === 0x73 && h[3] === 0x6d))    // "\0asm" magic
    throw new NanError("Not a WebAssembly file (missing the \\0asm magic bytes).", 0);
  // Preamble after the magic is version:u16 + layer:u16. Key on the layer, which is
  // stable across component-version bumps: 0 = core module, 1 = component.
  const layer = h[6] | (h[7] << 8);
  if (layer === 0) throw new NanError("This is a core wasm module, but Enclave runs wasi:http *components*. Rebuild with cargo-component (target wasm32-wasip2).", 0);
  if (layer !== 1) throw new NanError("Unrecognized wasm preamble (layer " + layer + "); expected a wasi:http component.", 0);
  return true;
}
// In-flight publish upload (XHR so we get upload progress - fetch can't report
// it). Tracked module-wide: a new file pick aborts the old upload, and the
// publish path refuses to run while one is active.
let pubXhr = null, pubSeq = 0;
function putWasm(file, onProgress){
  return new Promise((resolve, reject) => {
    if (!IPFS_UPLOAD_URL) return reject(new NanError("Direct upload isn’t configured here; paste a CID you’ve pinned (e.g. `ipfs add app.wasm`).", 0));
    if (file.size > MAX_WASM_BYTES) return reject(new NanError("Too large: max " + MAX_WASM_MB + " MB.", 0));
    // raw bytes to the validating gateway; it re-checks size + wasm component preamble
    // server-side, pins to IPFS, and returns { cid }. (The browser checks are just UX.)
    const xhr = new XMLHttpRequest();
    xhr.open("POST", IPFS_UPLOAD_URL);
    xhr.setRequestHeader("content-type", "application/wasm");
    xhr.responseType = "json";
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded, ev.total); };
    xhr.onerror = () => reject(new NanError("upload failed: network error", 0));
    xhr.onabort = () => reject(new NanError("upload canceled", 0));
    xhr.onload = () => {
      const j = xhr.response || {};
      if (xhr.status < 200 || xhr.status >= 300) return reject(new NanError("upload rejected: " + (j.error || ("HTTP " + xhr.status)), 0));
      if (!j.cid) return reject(new NanError("gateway returned no CID", 0));
      resolve(j.cid);
    };
    pubXhr = xhr;
    xhr.send(file);
  });
}
// Lock the publish path while bytes are in flight: an enabled button next to a
// CID field still holding the PREVIOUS upload's CID is how a stale CID lands
// on-chain.
function setPubUploading(on){
  const btn = $("#pubSubmit"); if (btn){ btn.disabled = on; btn.textContent = on ? "uploading…" : "Publish to Base"; }
  const cidEl = $("#pubCid"); if (cidEl) cidEl.disabled = on;
}
async function ensureCatalogChain(){
  if (APP_CATALOG_CHAIN === BASE_CHAIN) return ensureBaseChain();
  const hex = "0x" + APP_CATALOG_CHAIN.toString(16);
  let cur; try { cur = await Nan.provider.request({ method: "eth_chainId" }); } catch { cur = null; }
  if (cur && String(cur).toLowerCase() === hex) return;
  try { await Nan.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch(e){ throw new NanError("Switch your wallet to chain " + APP_CATALOG_CHAIN + " to publish.", 0); }
}
function pubStatus(msg, err){ const el = $("#pubStatus"); if (!el) return; el.textContent = msg || ""; el.className = "pub-status" + (err ? " err" : ""); }
async function onPubFile(e){
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const seq = ++pubSeq;                                     // supersedes any in-flight upload
  if (pubXhr){ try { pubXhr.abort(); } catch(_){} pubXhr = null; }
  $("#pubCid").value = "";                                  // never leave the previous CID publishable
  const hint = $("#pubFileHint"), bar = $("#pubUpBar");
  const mb = (f.size / 1048576).toFixed(2);
  hint.textContent = f.name + " · " + mb + " MB";
  try { await validateWasm(f); }
  catch(err){ if (seq !== pubSeq) return; pubStatus(err.message || String(err), true); e.target.value = ""; return; }
  if (seq !== pubSeq) return;
  setPubUploading(true);
  if (bar){ bar.hidden = false; bar.firstElementChild.style.width = "0%"; }
  pubStatus("valid component · uploading to IPFS… 0%");
  try {
    const cid = await putWasm(f, (done, total) => {
      if (seq !== pubSeq || !total) return;
      const pct = Math.min(100, Math.floor(done / total * 100));
      if (bar) bar.firstElementChild.style.width = pct + "%";
      // 100% sent != done: the gateway still validates + pins before answering
      const label = done >= total ? "upload sent · gateway validating + pinning…"
                                  : "uploading to IPFS… " + pct + "% (" + (done / 1048576).toFixed(1) + " / " + mb + " MB)";
      pubStatus(label);
      hint.textContent = f.name + " · " + mb + " MB · " + (done >= total ? "pinning…" : pct + "%");
    });
    if (seq !== pubSeq) return;
    $("#pubCid").value = cid;
    hint.textContent = f.name + " · " + mb + " MB · pinned";
    pubStatus("pinned · CID " + cid);
  } catch(err){
    if (seq !== pubSeq) return;
    hint.textContent = f.name + " · " + mb + " MB · upload failed";
    pubStatus(err.message || String(err), true);
  } finally {
    if (seq === pubSeq){ setPubUploading(false); pubXhr = null; if (bar) bar.hidden = true; }
  }
}
async function publishApp(){
  if (pubXhr) return pubStatus("the wasm is still uploading - wait for the CID to fill in before publishing", true);
  const slug = $("#pubSlug").value.trim(), version = $("#pubVersion").value.trim();
  const cid = $("#pubCid").value.trim(), name = $("#pubName").value.trim(), desc = $("#pubDesc").value.trim();
  // the app's EXACT minimum resources on four axes, published on-chain in MB /
  // GFLOPS (runners calculate the allocation shares from them)
  const vramMb = Math.round((parseFloat($("#pubVram").value) || 0) * 1024);
  const gpuGflops = Math.round((parseFloat($("#pubGpuT").value) || 0) * 1000);
  const memMb = Math.round(parseFloat($("#pubMem").value) || 0);
  const cpuGflops = Math.round(parseFloat($("#pubCpuG").value) || 0);
  const ports = $("#pubPorts").value.split(",").map(x => x.trim().toLowerCase()).filter(Boolean).join(",");
  if (!catConfigured()) return pubStatus("catalog contract address isn’t set on this site yet", true);
  if (!slug || blen(slug) > CAT_MAX.slug) return pubStatus("app slug is required (≤ 40 bytes)", true);
  if (!version || blen(version) > CAT_MAX.version) return pubStatus("version label is required (≤ 32 bytes)", true);
  if (!cid || blen(cid) > CAT_MAX.cid) return pubStatus("enter a valid IPFS CID (≤ 100 bytes)", true);
  if (!name || blen(name) > CAT_MAX.name) return pubStatus("name is required (≤ 80 bytes)", true);
  if (blen(desc) > CAT_MAX.desc) return pubStatus("description too long (≤ 500 bytes)", true);
  if (!(memMb > 0 && memMb <= CAT_MAX.mb)) return pubStatus("memory must be at least 1 MB", true);
  if (!(vramMb >= 0 && vramMb <= CAT_MAX.mb)) return pubStatus("VRAM must be 0 or more GB", true);
  if (!(gpuGflops >= 0 && gpuGflops <= CAT_MAX.gflops))
    return pubStatus("GPU compute must be 0 or more TFLOPS (0 = CPU-only)", true);
  if (!(cpuGflops >= 1 && cpuGflops <= CAT_MAX.gflops))
    return pubStatus("CPU compute must be at least 1 GFLOPS - every app computes something", true);
  if (blen(ports) > 96) return pubStatus("firewall config too long (≤ 96 bytes)", true);
  const pErr = validPortsCsv(ports); if (pErr) return pubStatus(pErr, true);
  // Pre-flight against the loaded catalog. Both cases REVERT on-chain, which a
  // wallet surfaces as a gas-estimation hang and the form as a bare timeout -
  // refuse here with the actual reason instead.
  // 1) A CID belongs to the app that FIRST listed it: no other app can ever
  //    list the same bytes. The owning app re-listing its own CID is the
  //    metadata-fix path (same bytes, corrected specs/ports) and is allowed;
  //    the deploy gate then follows the newest listing.
  if (STORE.apps){
    const me = (Nan.address || "").toLowerCase();
    for (const a of STORE.apps){
      const hit = (a.versions || []).find(v => v.cid === cid);
      if (!hit) continue;
      const sameApp = a.slug === slug && me && (a.publisher || "").toLowerCase() === me;
      if (!sameApp) return pubStatus("this exact .wasm is already on-chain as " + a.slug + " " + hit.version
        + " - a CID belongs to the app that first listed it. Publish the fix as a new version of that app, or rebuild so the bytes (and CID) change.", true);
      break;
    }
    // 2) version labels are immutable history within an app (your namespace)
    const mine = STORE.apps.find(a => a.slug === slug && Nan.address && (a.publisher || "").toLowerCase() === Nan.address.toLowerCase());
    if (mine && (mine.versions || []).some(v => v.version === version))
      return pubStatus("version " + version + " of " + slug + " already exists - labels are immutable history; bump it (e.g. 1.0.1).", true);
  }
  const btn = $("#pubSubmit"); btn.disabled = true; const lbl = btn.textContent; btn.textContent = "working…";
  try {
    if (!Nan.provider) await connectWallet();
    await ensureCatalogChain();
    pubStatus("confirm the transaction in your wallet…");
    // uint32[4] is a STATIC array: it ABI-encodes as four inline words, exactly
    // like four consecutive uint params, so the hand-rolled encoder just takes them in order
    const data = encCall(CAT_SEL.publishVersion, [
      {t:"str",v:slug},{t:"str",v:name},{t:"str",v:desc},{t:"str",v:version},{t:"str",v:cid},
      {t:"uint",v:vramMb},{t:"uint",v:gpuGflops},{t:"uint",v:memMb},{t:"uint",v:cpuGflops},{t:"str",v:ports},
    ]);
    const hash = await sendTx(APP_CATALOG_ADDRESS, data);
    pubStatus("sent · " + hash + " · waiting for confirmation…");
    await waitReceipt(hash);
    pubStatus("live on-chain ✓ " + hash);
    showToast("published " + slug + " " + version);
    await loadCatalog(true);
    togglePublish(false); resetPublish();
  } catch(e){
    const m = e.message || String(e);
    pubStatus(/cid (already listed|listed by another app)/i.test(m)
      ? "rejected on-chain: this CID already belongs to another app (a CID is owned by the app that first listed it) - publish the fix under that app, or rebuild so the bytes change"
      : m, true);
  }
  finally { btn.disabled = false; btn.textContent = lbl; }
}
async function catTx(data, verb){
  try {
    if (!Nan.provider) await connectWallet();
    await ensureCatalogChain();
    const hash = await sendTx(APP_CATALOG_ADDRESS, data);
    showToast(verb + " · " + hash.slice(0, 12) + "…");
    await waitReceipt(hash); await loadCatalog(true);
  } catch(e){ showToast(e.message || String(e)); }
}
const setActiveTx   = (slug, active) => catTx(encCall(CAT_SEL.setActive,   [{t:"str",v:slug},{t:"bool",v:active}]), active ? "relisting" : "delisting");
const yankTx        = (slug, idx)    => catTx(encCall(CAT_SEL.yankVersion, [{t:"str",v:slug},{t:"uint",v:idx}]),   "yanking");
const setVerifiedTx = (appId, idx, v) => catTx(encCall(CAT_SEL.setVerified, [{t:"bytes32",v:appId},{t:"uint",v:idx},{t:"bool",v:v}]), v ? "verifying" : "unverifying");
// owner-only deploy gate: the wallet signature on this tx IS the approval/rejection
const setApprovalTx = (appId, idx, st) => catTx(encCall(CAT_SEL.setApproval, [{t:"bytes32",v:appId},{t:"uint",v:idx},{t:"uint",v:st}]), st === APPROVAL.approved ? "approving" : "rejecting");

function resetPublish(){
  pubSeq++;                                                  // orphan any in-flight upload's callbacks
  if (pubXhr){ try { pubXhr.abort(); } catch(_){} pubXhr = null; }
  setPubUploading(false);
  const bar = $("#pubUpBar"); if (bar) bar.hidden = true;
  ["#pubSlug","#pubCid","#pubName","#pubDesc","#pubPorts"].forEach(s => { const el = $(s); if (el) el.value = ""; });
  const f = $("#pubFile"); if (f) f.value = ""; const h = $("#pubFileHint"); if (h) h.textContent = "";
  $("#pubVersion").value = "1.0.0"; $("#pubVram").value = "0"; $("#pubGpuT").value = "0";
  $("#pubMem").value = "128"; $("#pubCpuG").value = "1"; pubStatus("");
}
// "1.0.0" -> "1.0.1", "v2" -> "v3", "2.1.0-beta" -> "2.1.1-beta": bump the last
// number in the label; it's a suggestion, the field stays editable.
function bumpVersion(s){
  const m = /^(.*?)(\d+)(\D*)$/.exec(s || "");
  return m ? m[1] + (parseInt(m[2], 10) + 1) + m[3] : (s ? s + ".1" : "1.0.1");
}
// version labels are unique per app FOREVER (yanked ones stay taken), so the
// suggested next version must skip every existing label - including yanked
// versions above the selected one - until it lands on a free label.
function nextFreeVersion(app, from){
  const taken = new Set((app.versions || []).map(v => v && v.version));
  let cand = bumpVersion(from);
  for (let i = 0; i < 1000 && taken.has(cand); i++) cand = bumpVersion(cand);
  return cand;
}
// "add version": open the publish form pre-filled from an app's current
// version - INCLUDING its CID. Re-listing your own CID is the metadata-fix
// path (same bytes, corrected specs/ports); picking a new .wasm replaces it.
function prefillPublish(app){
  const v = app.versions[selIdx(app)] || app.versions[app.versions.length - 1] || {};
  resetPublish();
  $("#pubSlug").value = app.slug;
  $("#pubName").value = app.name || "";
  $("#pubDesc").value = app.description || "";
  $("#pubVersion").value = nextFreeVersion(app, v.version);
  $("#pubCid").value = v.cid || "";
  $("#pubVram").value = String((Number(v.vramMb) || 0) / 1024);
  $("#pubGpuT").value = String((Number(v.gpuGflops) || 0) / 1000);
  $("#pubMem").value = String(Number(v.memMb) || 128);
  $("#pubCpuG").value = String(Math.max(1, Number(v.cpuGflops) || 1));
  $("#pubPorts").value = v.ports || "";
  openPublish();
  pubStatus("pre-filled from " + app.slug + " " + (v.version || "") + " - fix specs/ports and publish (same bytes), or pick a new .wasm if the code changed"
          + (app.active ? "" : " · publishing relists the app"));
}
/* ============================================================
   The publish page: apps.html#publish — a hash-routed view that
   replaces the store content (deliberately not a header tab).
   Plain hash navigation gives us history, back/forward, and
   shareable links for free; the soft-nav router ignores '#'
   hrefs, so there's no double handling.
   ============================================================ */
function applyView(){
  const store = $("#storeView"), pub = $("#publishView"); if (!store || !pub) return;
  const publish = location.hash === "#publish";
  store.hidden = publish; pub.hidden = !publish;
  document.title = publish ? "Publish · Enclave" : "Apps · Enclave";
  scrollTo(0, 0);
}
function openPublish(){
  if (location.hash === "#publish") applyView();
  else location.hash = "publish";                 // -> hashchange -> applyView
}
function closePublish(){
  history.pushState(null, "", location.pathname + location.search);   // clean URL, no #
  applyView();
}
// module-load-once; inert while another page's <main> is mounted
addEventListener("hashchange", () => { if (document.getElementById("publishView")) applyView(); });
function initStore(){
  const grid = $("#storeGrid"); if (!grid) return;
  const link = $("#catAddrLink"), sh = $("#catAddrShort"), ch = $("#catChain");
  if (ch) ch.textContent = (APP_CATALOG_CHAIN === 84532 ? "Base Sepolia · " : "Base · ") + APP_CATALOG_CHAIN;
  if (link && sh){
    if (catConfigured()){ link.href = catExplorer() + "/address/" + APP_CATALOG_ADDRESS; sh.textContent = short(APP_CATALOG_ADDRESS); }
    else { link.removeAttribute("href"); sh.textContent = "not deployed"; }
  }
  $$("#storeFilter button").forEach(b => b.addEventListener("click", () => {
    $$("#storeFilter button").forEach(x => x.classList.remove("on")); b.classList.add("on");
    STORE.filter = b.dataset.filter; renderApps();
  }));
  const s = $("#storeSearch"); if (s) s.addEventListener("input", renderApps);
  const rf = $("#storeRefresh"); if (rf) rf.addEventListener("click", () => loadCatalog(true));
  $("#pubCancel").addEventListener("click", closePublish);   // (+ Publish app is a plain <a href="#publish">)
  $("#pubSubmit").addEventListener("click", publishApp);
  const pf = $("#pubFile"); if (pf) pf.addEventListener("change", onPubFile);
  const row = $("#pubFileRow");
  if (row && !IPFS_UPLOAD_URL){ row.classList.add("disabled"); $("#pubFileHint").textContent = "upload disabled here; paste a CID below"; }

  // wallet-tx / navigation actions the cards bubble up (data down, events up)
  grid.addEventListener("card-action", (e) => {
    const { app, act, idx, verified } = e.detail;
    if (act === "deploy") useInDeploy(app, app.versions[idx]);
    else if (act === "delist"){ if (confirm("Delist this whole app? It stays on-chain but is hidden from the store - you (and the catalog owner) still see it here, with a relist button.")) setActiveTx(app.slug, false); }
    else if (act === "relist") setActiveTx(app.slug, true);
    else if (act === "newver") prefillPublish(app);
    else if (act === "yank"){ if (confirm("Yank version " + app.versions[idx].version + "? It stays on-chain but readers hide it.")) yankTx(app.slug, idx); }
    else if (act === "verify") setVerifiedTx(app.appId, idx, verified);
    else if (act === "approve") setApprovalTx(app.appId, idx, APPROVAL.approved);
    else if (act === "reject"){ if (confirm("Reject version " + app.versions[idx].version + "? The enclave will refuse to deploy it until you approve it.")) setApprovalTx(app.appId, idx, APPROVAL.rejected); }
  });
}

/* ============================================================
   boot
   ============================================================ */
on("nan:catalog", (d) => {
  if (d.type === "error"){
    if (STORE.apps && STORE.apps.length)          // stale view beats an error wall
      showToast("catalog refresh failed (" + d.message + ") · showing the last good read");
    else {
      const grid = $("#storeGrid");
      if (grid) grid.innerHTML = '<div class="store-note">Couldn’t read the catalog: ' + esc(d.message)
        + '<br><span class="dim">All public Base RPC endpoints refused - usually a transient rate limit; try Refresh in a moment.</span></div>';
    }
    return;
  }
  renderApps();
});
on("nan:wallet", () => { if (STORE.loaded) renderApps(); });   // publisher/owner buttons follow the connected wallet
// (both subscriptions are module-load-once; renderApps null-guards #storeGrid,
// so they're inert while another page's <main> is mounted)

/* called by the router every time this page's <main> is swapped in */
export function boot() {
  initStore();
  applyView();          // direct entries and soft-navs to apps.html#publish land on the publish view
  renderApps();
  loadCatalog();
}
