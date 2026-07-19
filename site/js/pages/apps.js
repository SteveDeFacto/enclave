/* ============================================================
   Apps page - the on-chain catalog store. Each listing renders
   as a <c-app-card>; the page owns the toolbar (filter/search),
   the publish form, and the wallet transactions the cards
   request via `card-action` events.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/app-card/app-card.js";
import "../../components/app-detail/app-detail.js";
import { $, $$, esc, short, blen, fmtDur, showToast, on, tosAccepted, setTosAccepted } from "../core/util.js";
import { APP_CATALOG_ADDRESS, APP_CATALOG_CHAIN, IPFS_UPLOAD_URL, IPFS_IMAGE_UPLOAD_URL, IPFS_IMG_GATEWAY, MAX_WASM_MB, MAX_WASM_BYTES, MAX_IMAGE_MB, MAX_IMAGE_BYTES, BASE_CHAIN, PRIVY_RDNS } from "../core/config.js";
import { Enclave, EnclaveError } from "../core/api.js";
import { catConfigured, catExplorer, encCall, CAT_SEL, CAT_MAX, APPROVAL, depPrices6, depMaxGpuMilli, rate6Of, waitReceipt, catSchemaRev, catMaxFeePerSec6, catVersionFee } from "../core/chain.js";
import { connectWallet, authenticate, ensureBaseChain, sendTx, usdcBalanceOf, openBuyModal } from "../core/wallet.js";
import { STORE, loadCatalog, selIdx, defaultIdx, appVerified, appPrivileged, visibleVerIdxs, validPortsCsv, REF_CACHE, PORTS_CACHE, SPECS_CACHE, specOf, CONFIG_CACHE, catalogRef, mediaOf, appMedia, stripMedia, withMedia } from "../core/catalog.js";
import { minPctsOf, shareRates } from "../core/pricing.js";
import { navigate } from "../boot.js";

/* ---- render: filter + sort the catalog into <c-app-card>s ---- */
function renderApps(){
  const grid = $("#storeGrid"); if (!grid) return;
  if (!catConfigured()){
    grid.innerHTML = '<div class="store-note">The on-chain catalog isn’t wired up on this deployment yet.<br><span class="dim">Deploy <code>EnclaveAppCatalog</code> with <code>scripts/deploy-app-catalog.mjs</code>; it writes the address in for you.</span></div>';
    return;
  }
  if (!STORE.loaded){ grid.innerHTML = '<div class="loading" role="status">reading catalog from Base…</div>'; return; }
  const q = ($("#storeSearch") && $("#storeSearch").value || "").trim().toLowerCase();
  // Delisted apps are hidden from the public store, but their PUBLISHER (and
  // the catalog owner) still see them - that's the only path back: relist, or
  // publish a new version to the slug (which auto-relists).
  const me = (Enclave.address || "").toLowerCase();
  const isOwner = !!(STORE.owner && me && me === STORE.owner);
  const myApp = (a) => !!me && a.publisher.toLowerCase() === me;
  syncModTabs(me, isOwner);
  let apps;
  if (STORE.filter === "delisted"){
    // moderation view: the catalog owner sees EVERY delisted app; a publisher
    // sees only their own - their one path back (relist, or republish the slug).
    apps = STORE.apps.filter(a => a.versions.length && !a.active && (isOwner || myApp(a)));
  } else if (STORE.filter === "pending"){
    // the to-review queue: active apps not yet endorsed, with no verdict on
    // their latest release. The owner sees every one; a publisher sees only
    // their own - where their app waits while the owner reviews it.
    apps = STORE.apps.filter(a => a.versions.length && a.active && !appVerified(a) && !appRejected(a)
                               && (isOwner || myApp(a)));
  } else if (STORE.filter === "rejected"){
    // moderation view: apps whose latest release was rejected (appRejected).
    // The owner sees every one (their rejection record); a publisher sees only
    // their own - the cue to yank the release or publish a fixed version.
    // Listing state doesn't matter here: a delisted app still shows.
    apps = STORE.apps.filter(a => appRejected(a) && (isOwner || myApp(a)));
  } else {
    // Approved - the public store and the default tab: active, owner-endorsed
    // apps with something visible (an app whose every version is yanked/
    // rejected has nothing to show a normal browser). Everything else lives in
    // the moderation tabs above, each scoped to the owner + the affected
    // publisher.
    apps = STORE.apps.filter(a => a.versions.length && a.active && visibleVerIdxs(a).length && appVerified(a));
  }
  // search matches only what the viewer can see - a yanked version's CID must
  // not surface an app to someone who'd then find no trace of that version
  if (q) apps = apps.filter(a => (a.name + " " + a.description + " " + a.slug + " " + a.publisher + " " + visibleVerIdxs(a).map(i => a.versions[i].cid + " " + a.versions[i].version).join(" ")).toLowerCase().includes(q));
  apps.sort((x, y) => (Number(appVerified(y)) - Number(appVerified(x))) || (y.updatedAt - x.updatedAt));
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

// the Rejected tab's membership: the app's LATEST release was rejected.
// Latest = newest non-yanked entry, so both cleanup paths clear the app from
// the tab: publish a fixed version (a newer latest, pending) or yank the
// rejected one. Older rejected versions under a newer release are history,
// not the app's current state.
const appRejected = (a) => {
  const vs = a.versions || [];
  for (let i = vs.length - 1; i >= 0; i--) if (!vs[i].yanked) return vs[i].approval === APPROVAL.rejected;
  return false;
};

/* The Pending, Rejected and Delisted tabs are the catalog owner's moderation
   surface - always visible to them - and each is ALSO shown to a publisher
   with an app in that state; only their own appear there (pending = where
   their app waits for the owner's verdict; rejected = fix or yank the release;
   delisted = their path back to relist). Everyone else never sees any of them;
   a tab that just became hidden falls back to Approved. */
function syncModTabs(me, isOwner){
  const delisted = document.querySelector('#storeFilter button[data-filter="delisted"]');
  const pending = document.querySelector('#storeFilter button[data-filter="pending"]');
  const rejected = document.querySelector('#storeFilter button[data-filter="rejected"]');
  const mine = (a) => !!me && a.publisher.toLowerCase() === me;
  const hasOwnDelisted = STORE.apps.some(a => a.versions.length && !a.active && mine(a));
  const hasOwnPending = STORE.apps.some(a => a.versions.length && a.active && !appVerified(a) && !appRejected(a) && mine(a));
  const hasOwnRejected = STORE.apps.some(a => appRejected(a) && mine(a));
  if (delisted) delisted.hidden = !(isOwner || hasOwnDelisted);
  if (pending) pending.hidden = !(isOwner || hasOwnPending);
  if (rejected) rejected.hidden = !(isOwner || hasOwnRejected);
  const cur = document.querySelector('#storeFilter button[data-filter="' + STORE.filter + '"]');
  if (cur && cur.hidden){
    STORE.filter = "approved";
    $$("#storeFilter button").forEach(x => { const on = x.dataset.filter === "approved"; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
  }
}

// Hand the picked version to the deploy view: stash everything it needs
// (sessionStorage survives the navigation; the ?app= param makes the link
// shareable - a fresh visitor's deploy console re-resolves it from the catalog).
function useInDeploy(app, v, idx){
  const friendly = app.slug + ":" + v.version;      // human-friendly; resolves to the version RECORD at deploy
  REF_CACHE[friendly] = catalogRef(app.appId, idx);
  PORTS_CACHE[friendly] = v.ports || "";
  SPECS_CACHE[friendly] = specOf(v);
  const cfgPreview = stripMedia(v.config || "");    // hide the _media block from the deploy config preview
  CONFIG_CACHE[friendly] = cfgPreview;               // the VERSION's config -> shown read-only on the deploy form
  try {
    // the RAW specs ride along - the deploy page derives the dial floors from
    // them against the fleet hardware IT has adopted (percents minted here
    // could divide by a different, staler server spec)
    sessionStorage.setItem("enclave_use_in_deploy", JSON.stringify({
      friendly, appId: app.appId, index: idx, ports: v.ports || "", spec: SPECS_CACHE[friendly], config: cfgPreview }));
  } catch(e){}
  // the console's own URL, share-friendly: /deploy?app=hello-world_1.0.0
  // (the "_" form keeps the query un-percent-encoded; deploy.js normalizes it
  // back to slug:version). New search -> the router re-swaps <main>, and
  // boot()'s applyUseInDeploy prefills from ?app=.
  navigate("deploy?app=" + encodeURIComponent(friendly.replace(/:(?=[^:]*$)/, "_")), { push: true });
}

/* ---- quick deploy: the store card's one-decision modal. Wallet balance,
   an amount, the runtime it buys at the app's MINIMUM shares - then the
   shared deployOnChain flow (public endpoint, catalog ports, USDC).
   "Advanced settings" is the full console (useInDeploy). ---- */
let qdEsc = null;
function closeQuick(){
  const host = $("#quickDeploy"); if (host) host.remove();
  if (qdEsc){ document.removeEventListener("keydown", qdEsc); qdEsc = null; }
}
function quickDeploy(app, v, idx){
  closeQuick();
  const mins = minPctsOf(v);
  // constants first paint; the CONTRACT's live prices (incl. its ceil-to-a-
  // micro-USDC floor) replace them the moment the cached read lands - the
  // rate shown here must match what the deployment actually burns. A paid
  // app's publisher fee rides on top, exactly as create() adds it.
  let baseRate = shareRates(mins.gpuPct, mins.cpuPct).rate, fee = 0;
  let rate = baseRate;
  const perHr = (rate * 3600).toFixed(2);
  const host = document.createElement("div");
  host.id = "quickDeploy"; host.className = "qd-overlay";
  host.innerHTML =
    '<div class="qd-card" role="dialog" aria-modal="true" aria-label="Deploy ' + esc(app.name || app.slug) + '">' +
      '<div class="qd-h">Deploy <b>' + esc(app.name || app.slug) + '</b> <span class="qd-ver">' + esc(v.version) + '</span></div>' +
      '<p class="qd-sub">Runs in its own confidential enclave at <b class="qd-rate">$' + perHr + '/hr</b>. Fund it from your wallet - it runs until the time you bought is used up, and you can top up or stop it whenever you like.</p>' +
      '<p class="qd-sub qd-fee" hidden></p>' +
      '<div class="qd-bal"><span>Your wallet</span><b class="qd-balv">…</b><button class="qd-buy" type="button" hidden>Buy USDC →</button><button class="qd-connect btn btn-sm" type="button" hidden>Connect wallet</button></div>' +
      '<label class="qd-lbl" for="qdAmt">Amount to fund (USDC)</label>' +
      '<input class="qd-amt" id="qdAmt" type="number" value="5" min="0.01" step="any" inputmode="decimal" />' +
      '<div class="qd-est">buys ≈ <b class="qd-estv"></b> of runtime</div>' +
      '<div class="qd-note" hidden></div>' +
      // the ToS gate: assent persists per terms version (core/util TOS_VERSION),
      // so returning deployers find it pre-checked. target=_blank keeps the
      // modal (and its amount) alive while the terms are read.
      '<label class="qd-tos"><input type="checkbox" class="qd-tosck"' + (tosAccepted() ? " checked" : "") + ' /> <span>I have read and agree to the <a href="terms" target="_blank" rel="noopener">Terms of Service</a> - payments are crypto-only, non-custodial and final, and uptime isn’t guaranteed.</span></label>' +
      '<div class="qd-actions">' +
        '<button class="btn btn-primary qd-go" type="button">▸ Deploy</button>' +
        '<button class="btn qd-adv" type="button" title="Pick shares, open ports, app config, and payment options on the full console">Advanced →</button>' +
        '<button class="btn qd-cancel" type="button">Cancel</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(host);
  qdEsc = (e) => { if (e.key === "Escape") closeQuick(); };
  document.addEventListener("keydown", qdEsc);
  // pointerDOWN, not click: a text selection that starts inside the card and
  // releases over the backdrop registers as a backdrop click and would dismiss
  host.addEventListener("pointerdown", (e) => { if (e.target === host) closeQuick(); });
  const amt = host.querySelector(".qd-amt"), estv = host.querySelector(".qd-estv"), note = host.querySelector(".qd-note");
  const go = host.querySelector(".qd-go"), balv = host.querySelector(".qd-balv");
  const buy = host.querySelector(".qd-buy"), conn = host.querySelector(".qd-connect");
  const tos = host.querySelector(".qd-tosck");
  let bal = null, capMsg = null;
  const est = () => {
    const usd = parseFloat(amt.value) || 0;
    estv.textContent = (usd > 0 && rate > 0) ? fmtDur(usd / rate) : "–";
    const shortOnFunds = bal != null && usd > bal;
    // capMsg is fatal (the contract refuses the create); it outranks the
    // adjustable short-on-funds note and pins the Deploy button off
    note.hidden = !shortOnFunds && !capMsg;
    if (capMsg) note.textContent = capMsg;
    else if (shortOnFunds) note.textContent = "That’s more than your wallet holds ($" + bal.toFixed(2) + " USDC).";
    go.disabled = !(usd >= 0.01) || shortOnFunds || !tos.checked || !!capMsg;
    go.title = capMsg ? "" : tos.checked ? "" : "Agree to the Terms of Service above to deploy";
  };
  // quick-deploy buys the app's MINIMUM shares, so the on-chain per-deployment
  // GPU cap decides right at open whether this app is deployable at all -
  // say so here, in the modal, not after a redirect to the dashboard
  depMaxGpuMilli().then(cap => {
    if (mins.gpuPct * 10 > cap){
      capMsg = "This app needs at least a " + mins.gpuPct + "% GPU share, but the platform currently caps deployments at "
        + (cap / 10) + "% of a card - it can’t be deployed right now.";
      est();
    }
  }).catch(() => {});
  amt.addEventListener("input", est);
  tos.addEventListener("change", () => { setTosAccepted(tos.checked); est(); });
  const paintRate = () => {
    rate = baseRate + fee;
    const rEl = host.querySelector(".qd-rate"); if (rEl) rEl.textContent = "$" + (rate * 3600).toFixed(2) + "/hr";
    est();
  };
  depPrices6().then(pr => {
    baseRate = Number(rate6Of(pr, mins.gpuPct * 10, mins.cpuPct * 10)) / 1e6;
    paintRate();
  }).catch(() => {});
  // the version's publisher fee (rev-5 catalogs; 0 = free) - shown up front
  // and folded into the burn rate, since create() snapshots it into the record
  catVersionFee(app.appId, idx).then(f => {
    if (!(f > 0n)) return;
    fee = Number(f) / 1e6;
    const fEl = host.querySelector(".qd-fee");
    if (fEl){ fEl.hidden = false; fEl.textContent = "The rate includes a $" + (fee * 3600).toFixed(2) + "/hr publisher fee, paid straight to this app's publisher."; }
    paintRate();
  }).catch(() => {});
  const loadBal = async () => {
    if (!Enclave.address || !Enclave.provider){ balv.textContent = "not connected"; conn.hidden = false; return; }
    conn.hidden = true;
    try { bal = await usdcBalanceOf(Enclave.address); balv.textContent = bal.toFixed(2) + " USDC"; } catch(e){}
    if (buy) buy.hidden = !(Enclave.walletRdns === PRIVY_RDNS);
    est();
  };
  conn.addEventListener("click", async () => {
    conn.disabled = true;
    try { if (!Enclave.token) await authenticate(); else await connectWallet(); }
    catch(e){ showToast(e.message || String(e)); }
    conn.disabled = false; loadBal();
  });
  if (buy) buy.addEventListener("click", () => openBuyModal());
  host.querySelector(".qd-cancel").addEventListener("click", closeQuick);
  host.querySelector(".qd-adv").addEventListener("click", () => { closeQuick(); useInDeploy(app, v, idx); });
  go.addEventListener("click", async () => {
    const usd = parseFloat(amt.value) || 0; if (!(usd >= 0.01)) return;
    // the flow lives in the deploy chunk; it navigates to the dashboard and
    // narrates into the run log (deployOnChain never throws)
    const m = await import("./deploy.js");
    // shares are re-derived NOW: the availability fetch may have adopted the
    // fleet's real hardware after this modal opened, and a share below the
    // runners' floor mints an unclaimable deployment (created shares are
    // immutable, funding unrecoverable)
    const m2 = minPctsOf(specOf(v));
    // full fleet? the queue-confirm overlay stacks over this modal; cancel
    // keeps the user here with their amount intact
    if (!(await m.confirmQueuedDeploy(m2.gpuPct, m2.cpuPct))) return;
    closeQuick();
    // the appRef IS the version record: the enclave applies its config,
    // volumes and ports from the chain - nothing rides the deployment
    m.deployOnChain({ reference: catalogRef(app.appId, idx), gpuMilli: m2.gpuPct * 10, cpuMilli: m2.cpuPct * 10,
      ports: v.ports || "", isPublic: true, fundUsd: usd, asset: "USDC" });
  });
  est(); loadBal();
}

/* ---- write side: IPFS upload + publish/verify/yank/delist txs ---- */
// Client-side sanity checks (UX + catch mistakes). NOT a security control: the
// /add endpoint is public, so Caddy's request_body max_size is the real ceiling,
// and the attested wasm-manager is the authoritative "is it a runnable component"
// gate at deploy. WebAssembly.validate() can't help: it only validates core
// modules, and Enclave apps are components, so we check the binary preamble by hand.
async function validateWasm(file){
  if (!/\.wasm$/i.test(file.name || "")) throw new EnclaveError("Pick a .wasm file.", 0);
  if (file.size < 8) throw new EnclaveError("That file is too small to be a WebAssembly module.", 0);
  if (file.size > MAX_WASM_BYTES) throw new EnclaveError("Too large: max " + MAX_WASM_MB + " MB (this file is " + (file.size / 1048576).toFixed(1) + " MB).", 0);
  const h = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!(h[0] === 0x00 && h[1] === 0x61 && h[2] === 0x73 && h[3] === 0x6d))    // "\0asm" magic
    throw new EnclaveError("Not a WebAssembly file (missing the \\0asm magic bytes).", 0);
  // Preamble after the magic is version:u16 + layer:u16. Key on the layer, which is
  // stable across component-version bumps: 0 = core module, 1 = component.
  const layer = h[6] | (h[7] << 8);
  if (layer === 0) throw new EnclaveError("This is a core wasm module, but Enclave runs wasi:http *components*. Rebuild with cargo-component (target wasm32-wasip2).", 0);
  if (layer !== 1) throw new EnclaveError("Unrecognized wasm preamble (layer " + layer + "); expected a wasi:http component.", 0);
  return true;
}
// In-flight publish upload (XHR so we get upload progress - fetch can't report
// it). Tracked module-wide: a new file pick aborts the old upload, and the
// publish path refuses to run while one is active.
let pubXhr = null, pubSeq = 0;
async function putWasm(file, onProgress){
  if (!IPFS_UPLOAD_URL) throw new EnclaveError("Direct upload isn’t configured here; paste a CID you’ve pinned (e.g. `ipfs add app.wasm`).", 0);
  if (file.size > MAX_WASM_BYTES) throw new EnclaveError("Too large: max " + MAX_WASM_MB + " MB.", 0);
  // The pin is WALLET-AUTHORIZED (closes the open-pin storage DoS): read the
  // bytes, get a one-time token bound to them (signedUploadToken), hand it to
  // the gateway. Publishing needs a wallet anyway.
  let buf;
  try { buf = await file.arrayBuffer(); }
  catch(_){ throw new EnclaveError("Couldn’t read this file to sign it" + (file.size > 500*1048576 ? " (very large files: publish with the CLI instead)." : "."), 0); }
  const { token, address: upAddr, expiry } = await signedUploadToken(buf);
  return await new Promise((resolve, reject) => {
    // raw bytes to the validating gateway; it re-checks the wasm preamble, verifies
    // the upload token authorizes exactly these bytes, pins, and returns { cid }.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", IPFS_UPLOAD_URL);
    xhr.setRequestHeader("content-type", "application/wasm");
    xhr.setRequestHeader("x-upload-address", upAddr);
    xhr.setRequestHeader("x-upload-expiry", String(expiry));
    xhr.setRequestHeader("x-upload-token", token);
    xhr.responseType = "json";
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded, ev.total); };
    xhr.onerror = () => reject(new EnclaveError("upload failed: network error", 0));
    xhr.onabort = () => reject(new EnclaveError("upload canceled", 0));
    xhr.onload = () => {
      const j = xhr.response || {};
      if (xhr.status < 200 || xhr.status >= 300) return reject(new EnclaveError("upload rejected: " + (j.error || ("HTTP " + xhr.status)), 0));
      if (!j.cid) return reject(new EnclaveError("gateway returned no CID", 0));
      resolve(j.cid);
    };
    pubXhr = xhr;
    xhr.send(file);
  });
}

/* Wallet-authorize a pin: sign enclave-upload:<sha256(bytes)>:<expiry>, trade it
   at the API for a one-time HMAC token bound to exactly these bytes. Shared by
   the wasm upload and the image (thumbnail/banner) uploads. */
async function signedUploadToken(bytes){
  if (!Enclave.address){ try { await connectWallet(); } catch(_){} }
  if (!Enclave.address || !Enclave.provider) throw new EnclaveError("Connect your wallet to upload; your signature authorizes the pin.", 0);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  const expiry = Math.floor(Date.now() / 1000) + 300;
  try {
    const signature = await Enclave.provider.request({ method: "personal_sign", params: [`enclave-upload:${hash}:${expiry}`, Enclave.address] });
    const r = await fetch(Enclave.base + "/apps/upload-token", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash, expiry, signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new EnclaveError("upload authorization failed: " + (j.message || j.error || ("HTTP " + r.status)), 0);
    return { token: j.token, address: j.address, expiry };
  } catch(err){
    if (err && (err.code === 4001 || /reject|denied|declin|cancell/i.test(err.message || ""))) throw new EnclaveError("upload canceled: you declined the wallet signature.", 0);
    throw (err instanceof EnclaveError) ? err : new EnclaveError("upload authorization failed: " + (err.message || err), 0);
  }
}

/* Upload an app image (thumbnail/banner) to the validating gateway; returns its
   CID. Small + wallet-signed like the wasm; the gateway re-checks the raster
   magic bytes and pins. */
async function putImage(file){
  if (!IPFS_IMAGE_UPLOAD_URL) throw new EnclaveError("Image upload isn’t configured here.", 0);
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name || "") && !/^image\/(png|jpeg|webp|gif)$/i.test(file.type || ""))
    throw new EnclaveError("Pick a PNG, JPEG, WebP, or GIF image.", 0);
  if (file.size > MAX_IMAGE_BYTES) throw new EnclaveError("Image too large: max " + MAX_IMAGE_MB + " MB (this is " + (file.size / 1048576).toFixed(1) + " MB).", 0);
  let buf; try { buf = await file.arrayBuffer(); } catch(_){ throw new EnclaveError("Couldn’t read this image to sign it.", 0); }
  const { token, address, expiry } = await signedUploadToken(buf);
  const r = await fetch(IPFS_IMAGE_UPLOAD_URL, { method: "POST", headers: {
    "content-type": file.type || "application/octet-stream",
    "x-upload-address": address, "x-upload-expiry": String(expiry), "x-upload-token": token,
  }, body: buf });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.cid) throw new EnclaveError("image upload rejected: " + (j.error || ("HTTP " + r.status)), 0);
  return j.cid;
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
  let cur; try { cur = await Enclave.provider.request({ method: "eth_chainId" }); } catch { cur = null; }
  if (cur && String(cur).toLowerCase() === hex) return;
  try { await Enclave.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch(e){ throw new EnclaveError("Switch your wallet to chain " + APP_CATALOG_CHAIN + " to publish.", 0); }
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
  if (bar){ bar.hidden = false; bar.firstElementChild.style.width = "0%"; bar.setAttribute("aria-valuenow", "0"); }
  pubStatus("valid component · uploading to IPFS… 0%");
  try {
    const cid = await putWasm(f, (done, total) => {
      if (seq !== pubSeq || !total) return;
      const pct = Math.min(100, Math.floor(done / total * 100));
      if (bar){ bar.firstElementChild.style.width = pct + "%"; bar.setAttribute("aria-valuenow", String(pct)); }
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
  // your hourly fee, published on-chain in USDC 6dp per SECOND (deployers'
  // fundings pay it straight to your wallet, pro-rata; immutable per version)
  const feeUsdHr = parseFloat($("#pubFee") && $("#pubFee").value) || 0;
  const feePerSec6 = Math.round(feeUsdHr * 1e6 / 3600);
  if (feePerSec6 < 0) return pubStatus("the hourly fee can't be negative", true);
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
  if (blen(ports) > 96) return pubStatus("open-ports config too long (≤ 96 bytes)", true);
  const pErr = validPortsCsv(ports); if (pErr) return pubStatus(pErr, true);
  const cfg = readPubConfig(); if (cfg.err) return pubStatus(cfg.err, true);
  // fold the (already-uploaded) thumbnail/banner CIDs into the version config
  // under _media - they ride in the config since the catalog contract has no
  // media field. Re-check the ceiling: media adds ~150 bytes over the app config.
  const thumbCid = ($("#pubThumbCid") && $("#pubThumbCid").value || "").trim();
  const bannerCid = ($("#pubBannerCid") && $("#pubBannerCid").value || "").trim();
  const finalConfig = withMedia(cfg.val, thumbCid, bannerCid);
  if (blen(finalConfig) > CAT_MAX.config) return pubStatus("app config + image references exceed " + CAT_MAX.config + " bytes - shorten the config", true);
  // Pre-flight against the loaded catalog. Both cases REVERT on-chain, which a
  // wallet surfaces as a gas-estimation hang and the form as a bare timeout -
  // refuse here with the actual reason instead.
  // 1) A CID belongs to the app that FIRST listed it: no other app can ever
  //    list the same bytes. The owning app re-listing its own CID is the
  //    metadata-fix path (same bytes, new config/specs/ports) and is allowed;
  //    each version is its own deployable record (deploys reference it as
  //    catalog://appId/index, so shared bytes never make versions ambiguous).
  if (STORE.apps){
    const me = (Enclave.address || "").toLowerCase();
    for (const a of STORE.apps){
      const hit = (a.versions || []).find(v => v.cid === cid);
      if (!hit) continue;
      const sameApp = a.slug === slug && me && (a.publisher || "").toLowerCase() === me;
      if (!sameApp) return pubStatus("this exact .wasm is already on-chain as " + a.slug + " " + hit.version
        + " - a CID belongs to the app that first listed it. Publish the fix as a new version of that app, or rebuild so the bytes (and CID) change.", true);
      break;
    }
    // 2) version labels are immutable history within an app (your namespace)
    const mine = STORE.apps.find(a => a.slug === slug && Enclave.address && (a.publisher || "").toLowerCase() === Enclave.address.toLowerCase());
    if (mine && (mine.versions || []).some(v => v.version === version))
      return pubStatus("version " + version + " of " + slug + " already exists - labels are immutable history; bump it (e.g. 1.0.1).", true);
  }
  const btn = $("#pubSubmit"); btn.disabled = true; const lbl = btn.textContent; btn.textContent = "working…";
  try {
    if (!Enclave.provider) await connectWallet();
    await ensureCatalogChain();
    // the live catalog's struct revision decides the publish encoding (the
    // site ships ahead of the contract cutover; all revisions must keep
    // working). Version-level config needs rev 4 - rev 3 (the retired
    // app-level layout) would silently store it where nothing reads it.
    const rev = await catSchemaRev();
    if (rev < 4 && finalConfig){
      pubStatus("this catalog revision doesn't store per-version configs - clear the App config box and images (or publish after the rev-4 catalog cutover)", true);
      btn.disabled = false; btn.textContent = lbl; return;
    }
    if (rev < 5 && feePerSec6 > 0){
      pubStatus("this catalog revision predates publisher fees - set the hourly fee to 0 (or publish after the rev-5 catalog cutover)", true);
      btn.disabled = false; btn.textContent = lbl; return;
    }
    if (feePerSec6 > 0){
      // publishVersion reverts above the on-chain cap; refuse here with the
      // actual ceiling instead of a wallet gas-estimation hang
      const max = Number(await catMaxFeePerSec6());
      if (feePerSec6 > max){
        pubStatus("the hourly fee is capped at $" + (max * 3600 / 1e6).toFixed(2) + "/hr right now - lower it", true);
        btn.disabled = false; btn.textContent = lbl; return;
      }
    }
    pubStatus("confirm the transaction in your wallet…");
    // uint32[4] is a STATIC array: it ABI-encodes as four inline words, exactly
    // like four consecutive uint params, so the hand-rolled encoder just takes them in order
    const args = [
      {t:"str",v:slug},{t:"str",v:name},{t:"str",v:desc},{t:"str",v:version},{t:"str",v:cid},
      {t:"uint",v:vramMb},{t:"uint",v:gpuGflops},{t:"uint",v:memMb},{t:"uint",v:cpuGflops},{t:"str",v:ports},
    ];
    const data = rev >= 5
      ? encCall(CAT_SEL.publishVersion, [...args, {t:"str",v:finalConfig}, {t:"uint",v:feePerSec6}])
      : rev >= 3
      ? encCall(CAT_SEL.publishVersionV4, [...args, {t:"str",v:finalConfig}])
      : encCall(CAT_SEL.publishVersionV2, args);
    const hash = await sendTx(APP_CATALOG_ADDRESS, data);
    pubStatus("sent · " + hash + " · waiting for confirmation…");
    await waitReceipt(hash);
    pubStatus("live on-chain ✓ " + hash);
    showToast("published " + slug + " " + version);
    await loadCatalog(true);
    closePublish(); resetPublish();
  } catch(e){
    const m = e.message || String(e);
    pubStatus(/cid (already listed|listed by another app)/i.test(m)
      ? "rejected on-chain: this CID already belongs to another app (a CID is owned by the app that first listed it) - publish the fix under that app, or rebuild so the bytes change"
      : m, true);
  }
  finally { btn.disabled = false; btn.textContent = lbl; }
}
/* the App config box: a default/template ENCLAVE_CONFIG JSON published WITH
   the version (immutable, covered by the version's approval - publishers can
   never change an approved release's behavior; a new config = a new version =
   Pending again). Empty is fine; otherwise a JSON object within the cap. */
/* ---- publish-form image pickers (thumbnail + banner) ----
   Each picker uploads on select (putImage -> CID, wallet-signed), shows a live
   preview, and parks the CID in a hidden input; publishApp folds both into the
   version config under _media. `kind` is "Thumb" | "Banner" (the id fragment). */
const IMG_KIND = { thumb: "Thumb", banner: "Banner" };
async function onPubImage(e, kind){
  const K = IMG_KIND[kind]; const f = e.target.files && e.target.files[0]; if (!f) return;
  const cidEl = $("#pub" + K + "Cid"), prev = $("#pub" + K + "Prev"), hint = $("#pub" + K + "Hint"), clr = $("#pub" + K + "Clear");
  let objUrl = ""; try { objUrl = URL.createObjectURL(f); prev.classList.add("has"); prev.style.backgroundImage = "url('" + objUrl + "')"; } catch(_){}
  if (hint) hint.textContent = "uploading…";
  try {
    const cid = await putImage(f);
    if (cidEl) cidEl.value = cid;
    prev.classList.add("has");
    prev.style.backgroundImage = "url('" + IPFS_IMG_GATEWAY + encodeURIComponent(cid) + "')";
    if (hint){ hint.textContent = "pinned"; hint.className = "hint ok"; }
    if (clr) clr.hidden = false;
  } catch(err){
    if (cidEl) cidEl.value = "";
    prev.classList.remove("has"); prev.style.backgroundImage = "";
    if (hint){ hint.textContent = err.message || String(err); hint.className = "hint err"; }
    e.target.value = "";
  } finally { if (objUrl) try { URL.revokeObjectURL(objUrl); } catch(_){} }
}
function clearPubImage(kind){
  const K = IMG_KIND[kind];
  const cidEl = $("#pub"+K+"Cid"); if (cidEl) cidEl.value = "";
  const prev = $("#pub"+K+"Prev"); if (prev){ prev.classList.remove("has"); prev.style.backgroundImage = ""; }
  const f = $("#pub"+K+"File"); if (f) f.value = "";
  const hint = $("#pub"+K+"Hint"); if (hint){ hint.textContent = ""; hint.className = "hint"; }
  const clr = $("#pub"+K+"Clear"); if (clr) clr.hidden = true;
}
// prefill a picker from an existing CID (add-version keeps the current media)
function setPubImage(kind, cid){
  const K = IMG_KIND[kind];
  const cidEl = $("#pub"+K+"Cid"); if (cidEl) cidEl.value = cid || "";
  const prev = $("#pub"+K+"Prev");
  if (prev){ prev.classList.toggle("has", !!cid); prev.style.backgroundImage = cid ? "url('" + IPFS_IMG_GATEWAY + encodeURIComponent(cid) + "')" : ""; }
  const clr = $("#pub"+K+"Clear"); if (clr) clr.hidden = !cid;
}
function readPubConfig(){
  const raw = ($("#pubConfig") && $("#pubConfig").value || "").trim();
  if (!raw) return { val: "" };
  let o;
  try {
    o = JSON.parse(raw);
    if (!o || Array.isArray(o) || typeof o !== "object") return { err: "app config must be a JSON object, e.g. {\"api_key\":\"…\"}" };
  } catch(e){ return { err: "app config isn't valid JSON (" + e.message + ")" }; }
  // measure the minified form - withMedia re-serializes before publishing, so
  // pretty-printed whitespace in the editor never counts against the ceiling
  const val = JSON.stringify(o);
  if (blen(val) > CAT_MAX.config) return { err: "app config too long (≤ " + CAT_MAX.config + " bytes)" };
  return { val };
}
// pretty-print a config JSON string for the editor (on-chain configs are
// minified); non-JSON passes through untouched
function prettyConfig(s){
  if (!s) return "";
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch(e){ return s; }
}

async function catTx(data, verb){
  try {
    if (!Enclave.provider) await connectWallet();
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
  ["#pubSlug","#pubCid","#pubName","#pubDesc","#pubPorts","#pubConfig"].forEach(s => { const el = $(s); if (el) el.value = ""; });
  const f = $("#pubFile"); if (f) f.value = ""; const h = $("#pubFileHint"); if (h) h.textContent = "";
  clearPubImage("thumb"); clearPubImage("banner");
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
  const media = mediaOf(v);
  // stash, then navigate: "add version" fires from the app's own page
  // (apps?app=…), whose URL search differs from /apps/publish, so the router
  // SWAPS <main> - a form filled before the swap would be wiped. Persist the
  // prefill and let the publish view apply it after it mounts (like useInDeploy).
  const stash = {
    slug: app.slug, name: app.name || "", desc: app.description || "",
    version: nextFreeVersion(app, v.version), cid: v.cid || "",
    vram: String((Number(v.vramMb) || 0) / 1024), gpuT: String((Number(v.gpuGflops) || 0) / 1000),
    mem: String(Number(v.memMb) || 128), cpuG: String(Math.max(1, Number(v.cpuGflops) || 1)),
    ports: v.ports || "", config: prettyConfig(stripMedia(v.config || "")),
    thumb: media.thumbnail || "", banner: media.banner || "",
    note: "pre-filled from " + app.slug + " " + (v.version || "") + " - fix specs/ports and publish (same bytes), or pick a new .wasm if the code changed"
          + (app.active ? "" : " · publishing relists the app"),
  };
  try { sessionStorage.setItem("enclave_prefill_publish", JSON.stringify(stash)); } catch(e){}
  openPublish();   // applyView applies the stash once the publish view is active (swap or fast-path)
}
// apply a stashed "add version" prefill onto the publish form (once), whenever
// the publish view becomes active - covers both the swap and fast-path routes.
function applyPrefillPublish(){
  let s; try { s = JSON.parse(sessionStorage.getItem("enclave_prefill_publish") || "null"); } catch(e){}
  if (!s || !$("#pubSlug")) return;
  sessionStorage.removeItem("enclave_prefill_publish");
  resetPublish();
  $("#pubSlug").value = s.slug || ""; $("#pubName").value = s.name || ""; $("#pubDesc").value = s.desc || "";
  $("#pubVersion").value = s.version || "1.0.0"; $("#pubCid").value = s.cid || "";
  $("#pubVram").value = s.vram || "0"; $("#pubGpuT").value = s.gpuT || "0";
  $("#pubMem").value = s.mem || "128"; $("#pubCpuG").value = s.cpuG || "1"; $("#pubPorts").value = s.ports || "";
  const pc = $("#pubConfig"); if (pc) pc.value = s.config || "";
  setPubImage("thumb", s.thumb || ""); setPubImage("banner", s.banner || "");
  pubStatus(s.note || "");
}
/* ============================================================
   Hash-routed sub-pages that replace the store content
   (deliberately not header tabs):
     apps.html#publish - the publish form
     apps.html#deploy - the deploy console (usually arriving as
                         ?app=slug:ver from a card's Use in deploy)
   Plain hash navigation gives us history, back/forward, and
   shareable links for free; the soft-nav router ignores '#'
   hrefs, so there's no double handling.
   ============================================================ */
function applyView(){
  const store = $("#storeView"), pub = $("#publishView"), dep = document.getElementById("deploy"), det = $("#appDetailView");
  if (!store || !pub || !dep) return;
  // the PATHNAME names the view now (/apps/deploy and /apps/publish are
  // router aliases of this page); the legacy #deploy/#publish hashes stay
  // honored and canonicalize in place to the pretty nested pathname
  // (document.baseURI = the site root - the alias documents carry <base>)
  const sub = location.pathname.split("/").pop();
  const view = sub === "deploy" || location.hash === "#deploy" ? "deploy"
             : sub === "publish" || location.hash === "#publish" ? "publish" : "store";
  if (sub !== view && (location.hash === "#deploy" || location.hash === "#publish"))
    history.replaceState(history.state, "", new URL(".", document.baseURI).pathname + "apps/" + view + location.search);
  // the base Apps view splits into the grid and a single app's page: apps?app=<appId>
  const appId = view === "store" ? new URLSearchParams(location.search).get("app") : null;
  const detail = !!appId;
  store.closest("section").hidden = view === "deploy";
  dep.hidden = view !== "deploy";
  store.hidden = view !== "store" || detail;
  if (det) det.hidden = !detail;
  pub.hidden = view !== "publish";
  document.title = view === "publish" ? "Publish · Enclave" : view === "deploy" ? "Deploy · Enclave" : "Apps · Enclave";
  if (view === "deploy") ensureDeployBooted();
  else if (view === "publish") applyPrefillPublish();   // apply a stashed "add version" prefill, if any
  else if (detail) renderDetail(appId);
  scrollTo(0, 0);
}
/* one app's full page (apps?app=<appId>) - renders <c-app-detail> into the
   detail wrap; re-run on catalog/wallet edges like the grid (renderActiveView) */
function renderDetail(appId){
  const host = $("#appDetailView"); if (!host) return;
  appId = appId || new URLSearchParams(location.search).get("app");
  if (!appId){ navigate("apps", { push: false }); return; }
  if (!catConfigured()){ host.innerHTML = '<div class="store-note">The on-chain catalog isn’t wired up on this deployment yet.</div>'; return; }
  if (!STORE.loaded){ host.innerHTML = '<div class="loading" role="status">reading catalog from Base…</div>'; return; }
  const app = STORE.byId[appId] || (STORE.apps || []).find(a => a.appId === appId);
  // a direct link to an app with nothing the viewer may see (every version
  // yanked/rejected, or the app is unverified and the viewer is neither its
  // publisher nor the catalog owner) reads as absent, same as the grid - not
  // as an empty page
  if (!app || !visibleVerIdxs(app).length || !(appVerified(app) || appPrivileged(app))){ host.innerHTML = '<div class="store-note">That app isn’t in the catalog. <a href="apps">← all apps</a></div>'; document.title = "Apps · Enclave"; return; }
  document.title = app.name + " · Enclave";
  let el = host.querySelector("c-app-detail");
  if (!el){ host.innerHTML = ""; el = document.createElement("c-app-detail"); host.appendChild(el); }
  el.app = app;
}
/* pick the renderer for whichever view is live (grid vs a single app's page),
   so catalog/wallet refreshes repaint the right one */
function renderActiveView(){
  const sub = location.pathname.split("/").pop();
  const onStore = sub !== "deploy" && sub !== "publish";
  const appId = onStore ? new URLSearchParams(location.search).get("app") : null;
  if (appId) renderDetail(appId); else renderApps();
}
/* the console's logic lives in the code-split deploy module; boot it the
   first time the view opens on each <main> mount (fresh DOM per swap) */
let deployMount = null;
function ensureDeployBooted(){
  const el = document.getElementById("deploy");
  if (!el || deployMount === el) return;
  deployMount = el;
  import("./deploy.js").then(m => {
    if (document.getElementById("deploy") === el) m.boot();
    else deployMount = null;                      // mount swapped mid-import; boot on next entry
  }).catch(e => console.warn("[apps] deploy console failed to boot:", e));
}
function openPublish(){
  // same-document pathname flip: the router pushes /publish and re-signals
  // the view (no fetch, no <main> swap - apps/deploy/publish share one)
  navigate("publish", { push: true });
}
function closePublish(){
  navigate("apps", { push: true });
}
// module-load-once; inert while another page's <main> is mounted
addEventListener("hashchange", () => { if (document.getElementById("publishView")) applyView(); });
function initStore(){
  const grid = $("#storeGrid"); if (!grid) return;
  // provenance mark: one icon straight to the catalog contract on Basescan
  // (Steven's call); full name + address in the tooltip
  const link = $("#catAddrLink");
  if (link){
    if (catConfigured()){ link.href = catExplorer() + "/address/" + APP_CATALOG_ADDRESS; link.title = "EnclaveAppCatalog · " + APP_CATALOG_ADDRESS; }
    else link.hidden = true;
  }
  $$("#storeFilter button").forEach(b => b.addEventListener("click", () => {
    $$("#storeFilter button").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
    STORE.filter = b.dataset.filter; renderApps();
  }));
  const s = $("#storeSearch"); if (s) s.addEventListener("input", renderApps);
  const rf = $("#storeRefresh"); if (rf) rf.addEventListener("click", () => loadCatalog(true));
  $("#pubCancel").addEventListener("click", closePublish);   // (+ Publish app is a plain <a href="#publish">)
  $("#pubSubmit").addEventListener("click", publishApp);
  const pf = $("#pubFile"); if (pf) pf.addEventListener("change", onPubFile);
  const row = $("#pubFileRow");
  if (row && !IPFS_UPLOAD_URL){ row.classList.add("disabled"); $("#pubFileHint").textContent = "upload disabled here; paste a CID below"; }
  const tf = $("#pubThumbFile"); if (tf) tf.addEventListener("change", (e) => onPubImage(e, "thumb"));
  const bf = $("#pubBannerFile"); if (bf) bf.addEventListener("change", (e) => onPubImage(e, "banner"));
  const tc = $("#pubThumbClear"); if (tc) tc.addEventListener("click", () => clearPubImage("thumb"));
  const bc = $("#pubBannerClear"); if (bc) bc.addEventListener("click", () => clearPubImage("banner"));
  const pm = $(".pub-media"); if (pm && !IPFS_IMAGE_UPLOAD_URL) pm.hidden = true;   // no image gateway here

  // wallet-tx / navigation actions the cards + detail page bubble up (data
  // down, events up) - the grid tile opens the page, the page carries the rest
  grid.addEventListener("card-action", onCardAction);
  const det = $("#appDetailView"); if (det) det.addEventListener("card-action", onCardAction);
}
function onCardAction(e){
  const { app, act, idx, verified } = e.detail;
  if (act === "open"){ navigate("apps?app=" + encodeURIComponent(app.appId), { push: true }); return; }
  if (act === "deploy") quickDeploy(app, app.versions[idx], idx);
  else if (act === "delist"){ if (confirm("Delist this whole app? It stays on-chain but is hidden from the store - you (and the catalog owner) still see it here, with a relist button.")) setActiveTx(app.slug, false); }
  else if (act === "relist") setActiveTx(app.slug, true);
  else if (act === "newver") prefillPublish(app);
  else if (act === "yank"){ if (confirm("Yank version " + app.versions[idx].version + "? It stays on-chain but readers hide it.")) yankTx(app.slug, idx); }
  else if (act === "verify") setVerifiedTx(app.appId, idx, verified);
  else if (act === "approve") setApprovalTx(app.appId, idx, APPROVAL.approved);
  else if (act === "reject"){ if (confirm("Reject version " + app.versions[idx].version + "? The enclave will refuse to deploy it until you approve it.")) setApprovalTx(app.appId, idx, APPROVAL.rejected); }
}

/* ============================================================
   boot
   ============================================================ */
on("enclave:catalog", (d) => {
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
  renderActiveView();
});
on("enclave:wallet", () => { if (STORE.loaded) renderActiveView(); });   // publisher/owner buttons follow the connected wallet
// (both subscriptions are module-load-once; renderApps null-guards #storeGrid,
// so they're inert while another page's <main> is mounted)

/* called by the router every time this page's <main> is swapped in */
export function boot() {
  initStore();
  applyView();          // direct entries and soft-navs to apps.html#publish land on the publish view
  renderActiveView();   // grid, or a single app's page when apps?app=<appId>
  loadCatalog();
  // adopt the fleet's real hardware into the share math before anyone opens
  // quick-deploy - minimum dials divide by these numbers (see core/pricing.js)
  Enclave.getAvailability().catch(() => {});
}
