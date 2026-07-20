/* ============================================================
   Wallet + auth - EIP-6963 discovery, SIWE sign-in, session
   persistence, the header wallet button and popover, deposits.

   Page-facing signals (see util.js): every state change emits
   `enclave:wallet`; sign-in/out edges also emit `enclave:auth`. Pages
   never get called into directly - they subscribe.

   Wallets here are the user's OWN (injected extensions). There is no
   embedded/custodial wallet and no card-to-crypto purchase on this
   site: cards go through the order checkout (hosted Stripe page,
   zero crypto exposure) and crypto payments come from the user's
   wallet. Account-level sign-in (passkeys + SIWE against the relay)
   lives in account.js; this module keeps the ENCLAVE session (the
   in-CVM SIWE token that gates deployment-private reads).
   ============================================================ */
import { BASE_CHAIN, BASE_CHAIN_HEX, USDC_BASE } from "./config.js";
import { Enclave, EnclaveError } from "./api.js";
import { baseRpc } from "./chain.js";
import { $, $$, esc, short, lsGet, lsSet, fmtDur, copyText, showToast, emit } from "./util.js";
import { qrSvg } from "../lib/qr.js";
import { runlog } from "./runlog.js";

/* ---- wallet discovery: EIP-6963 multi-wallet, EIP-1193 fallback ---- */
export const Wallet = {
  found: [],
  started: false,
  init(){
    if (this.started) return; this.started = true;
    window.addEventListener("eip6963:announceProvider", (e) => {
      const d = e.detail; if (!d || !d.info || !d.provider) return;
      const i = this.found.findIndex(x => x.info.uuid === d.info.uuid);
      if (i === -1) this.found.push(d); else this.found[i] = d;
    });
    this.request();
  },
  request(){ try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch(e){} },
  async discover(){
    // wallets that weren't ready at page-load announce when we re-ask
    this.request(); await new Promise(r => setTimeout(r, 180));
    this.request(); await new Promise(r => setTimeout(r, 80));
    return this.list();
  },
  list(){
    const arr = this.found.slice();
    const seen = new Set(arr.map(w => w.provider));
    if (typeof window !== "undefined" && window.ethereum){
      const eth = window.ethereum;
      const provs = (eth.providers && eth.providers.length) ? eth.providers : [eth];
      provs.forEach((p, i) => { if (p && !seen.has(p)){ seen.add(p); arr.push({
        info: { uuid: "injected-" + i, name: p.isMetaMask ? "MetaMask" : p.isRabby ? "Rabby" : p.isCoinbaseWallet ? "Coinbase Wallet" : p.isBraveWallet ? "Brave Wallet" : "Injected wallet", icon: null },
        provider: p
      }); } });
    }
    return arr;
  }
};

/* ---- assemble a canonical SIWE message only if the server didn't send one ----
   (exported: account.js signs the same shape against the relay) */
export function buildSiwe(ch){
  const L = [];
  L.push((ch.domain || location.host) + " wants you to sign in with your Ethereum account:");
  L.push(ch.address);
  L.push("");
  if (ch.statement) L.push(ch.statement);
  L.push("");
  L.push("URI: " + (ch.uri || location.origin));
  L.push("Version: " + (ch.version || "1"));
  L.push("Chain ID: " + (ch.chainId != null ? ch.chainId : BASE_CHAIN));
  L.push("Nonce: " + ch.nonce);
  if (ch.issuedAt) L.push("Issued At: " + ch.issuedAt);
  if (ch.expirationTime) L.push("Expiration Time: " + ch.expirationTime);
  return L.join("\n");
}

function noWalletReason(){
  if (typeof location !== "undefined" && location.protocol === "file:")
    return "This page is open as a local file (file://). Wallet extensions don't inject there. Serve it over http(s): run a local server, or open it from your enclave.host / IPFS gateway.";
  let framed = false; try { framed = window.top !== window.self; } catch(e){ framed = true; }
  if (framed)
    return "This page is in a sandboxed preview frame, where wallets can't be injected. Open it in its own browser tab.";
  return "No Ethereum wallet detected. Install MetaMask, Rabby, Coinbase, or any EIP-6963 wallet, unlock it, and reload.";
}

/* modal a11y for every #walletPick use: dialog semantics, focus moved in,
   Tab trapped, Escape = dismiss, focus restored on close. Returns the
   teardown; the caller's close() must run it. (Exported: account.js renders
   the sign-in chooser through the same overlay.) */
export function modalize(host, onDismiss){
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  const h = host.querySelector(".wp-h");
  if (h){ h.id = h.id || "wpTitle"; host.setAttribute("aria-labelledby", h.id); }
  const prev = document.activeElement;
  const focusables = () => [...host.querySelectorAll("button,input,select,textarea,a[href]")].filter(el => !el.disabled && el.offsetParent !== null);
  // content may be rendered a tick after open: retry once
  const f0 = focusables()[0];
  if (f0) f0.focus(); else requestAnimationFrame(() => { const f = focusables()[0]; if (f) f.focus(); });
  const onKey = (e) => {
    if (e.key === "Escape"){ e.preventDefault(); onDismiss(); return; }
    if (e.key !== "Tab") return;
    const f = focusables(); if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0){ e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)){ e.preventDefault(); f[0].focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    host.removeAttribute("role"); host.removeAttribute("aria-modal"); host.removeAttribute("aria-labelledby");
    if (prev && prev.focus) try { prev.focus(); } catch(e){}
  };
}

/* ---- deposits ----
   small modal reusing the #walletPick overlay; backdrop / .wp-cancel close it
   (exported: account.js and the checkout page reuse the same shell) */
export function fundModal(inner){
  const host = $("#walletPick"); if (!host) return null;
  host.innerHTML = '<div class="wp-card">' + inner + '</div>';
  host.hidden = false;
  const close = () => { unmodal(); host.hidden = true; host.innerHTML = ""; host.onclick = null; host.onpointerdown = null; };
  const unmodal = modalize(host, close);
  // backdrop closes on pointerDOWN so a text selection started inside the
  // card and released over the backdrop doesn't dismiss; buttons stay on click
  host.onpointerdown = (e) => { if (e.target === host) close(); };
  host.onclick = (e) => { if (e.target.closest(".wp-cancel")) close(); };
  return { host, close };
}

export function openDepositModal(){
  if (!Enclave.address) return;
  const m = fundModal(
    '<div class="wp-h">Deposit</div>' +
    '<div class="wp-note">Send <b>USDC on the Base network</b> to your address below - from Coinbase, Kraken, Binance, or any wallet. It shows up here once the transfer confirms, usually under a minute.</div>' +
    '<div class="wp-qr" aria-label="deposit address as a QR code">' + qrSvg(Enclave.address) + '</div>' +
    '<div class="wp-addr-full">' + esc(Enclave.address) + '</div>' +
    '<button class="wp-item wp-go" id="depCopy" type="button">Copy address</button>' +
    '<div class="wp-err">Base network only - transfers sent on other networks are lost.</div>' +
    '<button class="wp-cancel" type="button">Close</button>');
  if (!m) return;
  const b = $("#depCopy"); if (b) b.addEventListener("click", () => copyText(Enclave.address, b));
}

export async function usdcBalanceOf(addr){
  const call = { to: USDC_BASE, data: "0x70a08231" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0") };
  try {
    const hex = await Enclave.provider.request({ method: "eth_call", params: [call, "latest"] });
    if (hex && hex !== "0x") return parseInt(hex, 16) / 1e6;
  } catch(_){}
  const r = await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }) });
  const j = await r.json(); const hex = j && j.result;
  return (hex && hex !== "0x") ? parseInt(hex, 16) / 1e6 : 0;
}
export async function ethBalanceOf(addr){
  const params = [addr, "latest"];
  try {
    const hex = await Enclave.provider.request({ method: "eth_getBalance", params });
    if (hex && hex !== "0x") return Number(BigInt(hex)) / 1e18;
  } catch(_){}
  const r = await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params }) });
  const j = await r.json(); const hex = j && j.result;
  return (hex && hex !== "0x") ? Number(BigInt(hex)) / 1e18 : 0;
}

async function pickWallet(){
  let wallets = Wallet.list();
  if (!wallets.length) wallets = await Wallet.discover();
  if (!wallets.length) throw new EnclaveError(noWalletReason(), 0);
  if (wallets.length === 1) return wallets[0];
  return await new Promise((resolve, reject) => {
    const host = $("#walletPick"); if (!host){ resolve(wallets[0]); return; }
    host.innerHTML = '<div class="wp-card"><div class="wp-h">Choose a wallet</div>' +
      wallets.map((w, i) => '<button class="wp-item" data-i="' + i + '">' +
        (w.info.icon ? '<img src="' + esc(w.info.icon) + '" alt=""/>' : '<span class="wp-dot"></span>') +
        esc(w.info.name) + '</button>').join("") +
      '<button class="wp-cancel">Cancel</button></div>';
    host.hidden = false;
    const close = () => { unmodal(); host.hidden = true; host.innerHTML = ""; };
    const unmodal = modalize(host, () => { close(); reject(new EnclaveError("Wallet selection cancelled.", 0)); });
    // backdrop dismissal on pointerDOWN (see fundModal): selection drags out
    // of the card must not cancel the wallet pick
    host.onpointerdown = (e) => {
      if (e.target === host){ close(); reject(new EnclaveError("Wallet selection cancelled.", 0)); }
    };
    host.onclick = (e) => {
      const it = e.target.closest(".wp-item");
      if (it && it.dataset.i != null){ const w = wallets[+it.dataset.i]; close(); resolve(w); return; }
      if (e.target.closest(".wp-cancel")){ close(); reject(new EnclaveError("Wallet selection cancelled.", 0)); }
    };
  });
}

async function ensureBaseChainOnConnect(provider){
  let cid;
  try { cid = await provider.request({ method: "eth_chainId" }); } catch(e){ return; }
  if (parseInt(cid, 16) === BASE_CHAIN) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch(e){
    if (e && e.code === 4902){
      try {
        await provider.request({ method: "wallet_addEthereumChain", params: [{
          chainId: BASE_CHAIN_HEX, chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"]
        }] });
      } catch(_){}
    }
  }
}

// wire provider events once per provider (survives silent reconnect on refresh)
function wireProviderEvents(provider){
  if (!provider || !provider.on || provider._enclaveWired) return;
  provider._enclaveWired = true;
  provider.on("accountsChanged", (acc) => {
    if (!acc || !acc.length){ disconnectWallet(); }
    else { Enclave.address = acc[0]; Enclave.token = null; saveSession(); refreshWallet(); }
  });
  provider.on("chainChanged", (c) => { Enclave.chainId = parseInt(c, 16); refreshWallet(); });
}

export async function connectWallet(){
  const chosen = await pickWallet();
  const provider = chosen.provider;
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts || !accounts.length) throw new EnclaveError("Wallet returned no accounts.", 0);
  await ensureBaseChainOnConnect(provider);
  let cid; try { cid = await provider.request({ method: "eth_chainId" }); } catch(e){}
  Enclave.provider = provider; Enclave.address = accounts[0]; Enclave.chainId = cid ? parseInt(cid, 16) : null;
  Enclave.walletRdns = (chosen.info && chosen.info.rdns) || null;
  wireProviderEvents(provider);
  saveSession();
  refreshWallet();
  return provider;
}

export async function authenticate(){
  if (!Enclave.provider) await connectWallet();
  const ch = await Enclave.getNonce(Enclave.address);
  const message = (ch && ch.message) ? ch.message : buildSiwe(ch);
  let signature;
  try {
    signature = await Enclave.provider.request({ method: "personal_sign", params: [message, Enclave.address] });
  } catch(e){
    throw new EnclaveError((e && e.code === 4001) ? "Signature rejected." : ("Could not sign in: " + (e.message || e)), 0);
  }
  const sess = await Enclave.login(message, signature);
  Enclave.token = sess && sess.token;
  if (!Enclave.token) throw new EnclaveError("Login did not return a token.", 0);
  saveSession();
  refreshWallet();
  emit("enclave:auth", { authed: true, spinner: true });
  return sess;
}

export function disconnectWallet(){
  Enclave.token = null; Enclave.address = null; Enclave.provider = null; Enclave.chainId = null; Enclave.walletRdns = null;
  clearSession();
  Enclave.clearAccountSession();   // "Sign out" means BOTH domains: wallet/enclave session and the relay account
  runlog.clear();   // don't leave the prior user's deploy narratives in localStorage / on-screen
  const pop = $("#walletPop"); if (pop){ pop.hidden = true; pop.innerHTML = ""; popExpanded(false); }
  refreshWallet();
  emit("enclave:auth", { authed: false });
}

/* ---- session persistence: survive a page refresh (localStorage bearer token) ---- */
export function saveSession(){
  if (!Enclave.address){ lsSet("enclave_session", ""); return; }
  try { lsSet("enclave_session", JSON.stringify({ address: Enclave.address, rdns: Enclave.walletRdns || null, token: Enclave.token || null })); } catch(e){}
}
export function clearSession(){ lsSet("enclave_session", ""); }
// pull the exp (seconds) out of a JWT; null if not a JWT / no exp
// (exported: account.js expiry-checks its own token the same way)
export function jwtExp(token){
  try {
    let s = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - s.length % 4) % 4);
    const p = JSON.parse(atob(s));
    return typeof p.exp === "number" ? p.exp : null;
  } catch(e){ return null; }
}
// on load: silently reconnect the prior wallet (no popup) and restore a still-valid token
export async function restoreSession(){
  // one-time migration from the pre-rename key so signed-in users stay signed in
  try { const old = lsGet("nan_session"); if (old && !lsGet("enclave_session")) { lsSet("enclave_session", old); lsSet("nan_session", ""); } } catch(e){}
  let raw; try { raw = lsGet("enclave_session"); } catch(e){ return; }
  if (!raw) return;
  let s; try { s = JSON.parse(raw); } catch(e){ clearSession(); return; }
  if (!s || !s.address) return;
  if (s.token){ const exp = jwtExp(s.token); if (exp && exp * 1000 <= Date.now()) s.token = null; }  // drop an expired token
  // paint the header button IMMEDIATELY from the cached session - the real
  // restore below can take seconds (wallet discovery + the extension
  // round-trip) and the button said "Sign in" the whole time. Render the
  // EXACT final connected look, so the later refreshWallet repaint is
  // pixel-identical and the header stays still through view transitions. In
  // production the page's inline wallet-paint script (scripts/build-site.mjs)
  // already did this during parse - don't repaint over it.
  const early = $("#walletBtn");
  if (early && s.address && !early.dataset.painted){
    early.classList.add("connected");
    early.innerHTML = '<span class="wdot"></span>' + esc(short(s.address));
  }
  try {
  let wallets = Wallet.list(); if (!wallets.length) wallets = await Wallet.discover();
  let chosen = s.rdns ? wallets.find(w => w.info && w.info.rdns === s.rdns) : null;
  if (!chosen && wallets.length === 1) chosen = wallets[0];
  if (!chosen) return;                                          // can't reconnect silently; leave it to a manual Connect
  const provider = chosen.provider;
  let accounts = []; try { accounts = await provider.request({ method: "eth_accounts" }); } catch(e){ return; }
  const addr = accounts && accounts[0];
  if (!addr || addr.toLowerCase() !== String(s.address).toLowerCase()) return;   // permission revoked / different account
  let cid; try { cid = await provider.request({ method: "eth_chainId" }); } catch(e){}
  Enclave.provider = provider; Enclave.address = addr; Enclave.chainId = cid ? parseInt(cid, 16) : null;
  Enclave.walletRdns = (chosen.info && chosen.info.rdns) || null;
  Enclave.token = s.token || null;
  wireProviderEvents(provider);
  saveSession();                                                  // re-persist (drops any expired token, refreshes rdns)
  if (Enclave.token) emit("enclave:auth", { authed: true, spinner: true });
  } finally { refreshWallet(); }   // settles the early paint whether restore connected or not
}

/* ---- wallet button + popover ---- */
// disclosure state of the account popover, mirrored on the button (WCAG 4.1.2)
function popExpanded(open){ const b = $("#walletBtn"); if (b) b.setAttribute("aria-expanded", String(!!open)); }
export function refreshWallet(){
  const btn = $("#walletBtn");
  if (btn){
    if (Enclave.address){
      btn.classList.add("connected");
      btn.innerHTML = '<span class="wdot"></span>' + esc(short(Enclave.address));
      if (!btn.hasAttribute("aria-expanded")) btn.setAttribute("aria-expanded", "false");
    } else if (Enclave.accountAuthed()){
      // account-only (passkey user, no wallet connected): still signed in
      btn.classList.add("connected");
      btn.innerHTML = '<span class="wdot"></span>Signed in';
      if (!btn.hasAttribute("aria-expanded")) btn.setAttribute("aria-expanded", "false");
    } else {
      btn.classList.remove("connected");
      btn.removeAttribute("aria-expanded");   // signed out: the button starts sign-in, no popover
      btn.innerHTML = 'Sign in <span class="arr">→</span>';
    }
  }
  emit("enclave:wallet", { address: Enclave.address, authed: Enclave.authed() });
}

export function toggleWalletPop(){
  const pop = $("#walletPop"); if (!pop) return;
  if (!pop.hidden){ pop.hidden = true; pop.innerHTML = ""; popExpanded(false); return; }
  renderWalletPop();
}

export async function renderWalletPop(){
  const pop = $("#walletPop"); if (!pop) return;
  if (!Enclave.address){
    // account-only popover (passkey user, no wallet): account card + sign out
    if (!Enclave.accountAuthed()) return;
    pop.innerHTML =
      '<div class="wp-row"><span class="wp-k">Account</span><span class="wp-v">signed in' + (Enclave.accountMethod ? " · " + esc(Enclave.accountMethod) : "") + '</span></div>' +
      '<div class="wp-fund">' +
        '<button class="wp-mini" id="wpOrders">Buy runtime</button>' +
      '</div>' +
      '<button class="wp-disc" id="wpDisc">Sign out</button>';
    pop.hidden = false;
    popExpanded(true);
    const o = $("#wpOrders"); if (o) o.addEventListener("click", async () => {
      pop.hidden = true; popExpanded(false);
      (await import("../boot.js")).navigate("checkout", { push: true });
    });
    const d = $("#wpDisc"); if (d) d.addEventListener("click", disconnectWallet);
    return;
  }
  const offBase = Enclave.chainId && Enclave.chainId !== BASE_CHAIN;
  pop.innerHTML =
    '<div class="wp-row"><span class="wp-k">Wallet</span><button class="wp-addr" id="wpCopy">' + esc(short(Enclave.address)) + ' ⧉</button></div>' +
    '<div class="wp-row"><span class="wp-k">Network</span><span class="wp-v">' + (Enclave.chainId === BASE_CHAIN ? "Base" : ("chain " + (Enclave.chainId || "–"))) + (offBase ? ' <button class="wp-mini" id="wpSwitch">switch to Base</button>' : "") + '</span></div>' +
    '<div class="wp-row"><span class="wp-k">Session</span><span class="wp-v">' + (Enclave.authed() ? '<span class="ok">signed in</span>' : '<button class="wp-mini" id="wpAuth">sign in</button>') + '</span></div>' +
    '<div class="wp-bal"><div class="bl"><span>USDC balance</span><span id="wpBalUsdc">…</span></div></div>' +
    '<div class="wp-bal" id="wpBal">' + (Enclave.authed() ? "loading deployments…" : "sign in to load deployments") + '</div>' +
    '<div class="wp-fund">' +
      '<button class="wp-mini" id="wpDep">Deposit</button>' +
    '</div>' +
    '<button class="wp-disc" id="wpDisc">Sign out</button>';
  pop.hidden = false;
  popExpanded(true);
  const c = $("#wpCopy"); if (c) c.addEventListener("click", () => copyText(Enclave.address));
  const d = $("#wpDisc"); if (d) d.addEventListener("click", disconnectWallet);
  const dep = $("#wpDep"); if (dep) dep.addEventListener("click", () => { pop.hidden = true; popExpanded(false); openDepositModal(); });
  usdcBalanceOf(Enclave.address).then(
    (b) => { const u = $("#wpBalUsdc"); if (u) u.textContent = b.toFixed(2) + " USDC"; },
    ()  => { const u = $("#wpBalUsdc"); if (u) u.textContent = "unavailable"; });
  const s = $("#wpSwitch"); if (s) s.addEventListener("click", () => Enclave.provider && ensureBaseChainOnConnect(Enclave.provider).then(renderWalletPop));
  const a = $("#wpAuth"); if (a) a.addEventListener("click", async () => { try { await authenticate(); renderWalletPop(); } catch(e){ showToast(e.message); } });
  if (Enclave.authed()){
    try {
      const acc = await Enclave.getAccount();
      const dp = acc.deployments || {};
      const rows = '<div class="bl"><span>running</span><span>' + esc(String(dp.running != null ? dp.running : 0)) + '</span></div>'
                 + '<div class="bl"><span>awaiting payment</span><span>' + esc(String(dp.awaitingPayment != null ? dp.awaitingPayment : 0)) + '</span></div>'
                 + '<div class="bl"><span>time funded</span><span>' + esc(fmtDur(dp.totalTimeRemainingSec || 0)) + '</span></div>';
      const el = $("#wpBal"); if (el) el.innerHTML = '<div class="bl-h">Deployments</div>' + rows;
    } catch(e){ const el = $("#wpBal"); if (el) el.textContent = e.message; }
  }
}

/* ---- on-chain tx helpers used by both the deploy console and the store ---- */
export async function ensureBaseChain(){
  let cur;
  try { cur = await Enclave.provider.request({ method: "eth_chainId" }); } catch { cur = null; }
  if (cur && String(cur).toLowerCase() === BASE_CHAIN_HEX) return;
  try { await Enclave.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_HEX }] }); }
  catch(e){ throw new EnclaveError("Switch your wallet to Base to pay.", 0); }
}
export async function sendTx(to, data, value){
  const tx = { from: Enclave.address, data, value: value || "0x0" };
  if (to) tx.to = to; // omitted = contract creation
  // Injected wallets accept a provided limit: estimate (provider first, public
  // Base RPC as fallback) and pad 25% so a wallet that trusts our limit never
  // under-provisions. A failed estimate falls through - the wallet estimates
  // for itself.
  let est = null;
  try { est = await Enclave.provider.request({ method: "eth_estimateGas", params: [tx] }); }
  catch(_){ try { est = await baseRpc("eth_estimateGas", [tx]); } catch(_2){} }
  if (est) tx.gas = "0x" + (BigInt(est) + BigInt(est) / 4n).toString(16);
  return await Enclave.provider.request({ method: "eth_sendTransaction", params: [tx] });
}
