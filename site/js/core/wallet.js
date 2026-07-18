/* ============================================================
   Wallet + auth - EIP-6963 discovery, Privy email fallback,
   SIWE sign-in, session persistence, the header wallet button
   and popover, deposits / card purchases.

   Page-facing signals (see util.js): every state change emits
   `enclave:wallet`; sign-in/out edges also emit `enclave:auth`. Pages
   never get called into directly - they subscribe.
   ============================================================ */
import { BASE_CHAIN, BASE_CHAIN_HEX, USDC_BASE, PRIVY_APP_ID, PRIVY_CLIENT_ID, PRIVY_RDNS } from "./config.js";
import { Enclave, EnclaveError } from "./api.js";
import { baseRpc, encCall, waitReceipt } from "./chain.js";
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

/* ---- Privy embedded wallet: email-login fallback when no extension wallet is available ----
   Setup (one-time, dashboard.privy.io): create an app, enable Email login and embedded
   Ethereum wallets (Base), add this site's origins to Allowed origins, paste the App ID
   into config.js. An empty PRIVY_APP_ID disables the option and the site behaves exactly
   as before. The SDK (@privy-io/js-sdk-core) is imported on demand - no Privy bytes load
   until a user actually picks the email option (or returns with a saved Privy session). */
export const PrivyWallet = {
  privy: null, provider: null, user: null, _msgWired: false,
  enabled(){ return !!PRIVY_APP_ID; },
  emailOf(user){
    const accs = (user && (user.linked_accounts || user.linkedAccounts)) || [];
    const em = accs.find(a => a && a.type === "email");
    return (em && (em.address || em.email)) || null;
  },
  entry(provider){ return { info: { uuid: "privy-embedded", name: "Email (Privy)", rdns: PRIVY_RDNS, icon: null, email: this.emailOf(this.user) }, provider }; },
  async load(){
    if (this.privy) return this.privy;
    if (!this.enabled()) throw new EnclaveError("Privy is not configured on this deployment.", 0);
    let mod;
    // Same-origin, version-pinned bundle (scripts/build-vendor.mjs ->
    // site/vendor/privy-core.js). Was an UNPINNED esm.sh import — a wallet-path
    // dependency must not hot-load unversioned code from a third-party CDN.
    try { mod = await import("/vendor/privy-core.js"); }
    catch(e){ throw new EnclaveError("Could not load the Privy SDK: " + (e.message || e), 0); }
    const Privy = mod.default || mod.Privy;
    if (!Privy) throw new EnclaveError("Unexpected Privy SDK shape (no default export).", 0);
    // js-sdk-core requires an explicit storage adapter (the React SDK bundles one)
    const store = mod.LocalStorage ? new mod.LocalStorage() : {
      get(k){ try { const v = localStorage.getItem(k); if (v == null) return undefined; try { return JSON.parse(v); } catch(_){ return v; } } catch(e){ return undefined; } },
      put(k, v){ try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
      del(k){ try { localStorage.removeItem(k); } catch(e){} },
      getKeys(){ try { return Object.keys(localStorage); } catch(e){ return []; } }
    };
    const cfg = { appId: PRIVY_APP_ID, storage: store };
    if (PRIVY_CLIENT_ID) cfg.clientId = PRIVY_CLIENT_ID;
    this.privy = new Privy(cfg);
    this._mod = mod;
    // the embedded wallet lives in a hidden Privy iframe; the SDK drives it over postMessage
    const ew = this.privy.embeddedWallet;
    const url = ew && (ew.getURL ? ew.getURL() : (ew.getUrl ? ew.getUrl() : null));
    if (url){
      const f = document.createElement("iframe");
      f.id = "privyWalletFrame"; f.src = url; f.setAttribute("aria-hidden", "true");
      f.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;";
      document.body.appendChild(f);
      await new Promise(r => { f.onload = () => r(); setTimeout(r, 8000); });
      if (this.privy.setMessagePoster) this.privy.setMessagePoster(f.contentWindow);
      if (!this._msgWired){
        this._msgWired = true;
        window.addEventListener("message", (e) => { try { if (ew.onMessage) ew.onMessage(e.data); } catch(_){} });
      }
    }
    return this.privy;
  },
  embeddedOf(user){
    const accs = (user && (user.linked_accounts || user.linkedAccounts)) || [];
    return accs.find(a => a && a.type === "wallet"
      && ((a.wallet_client_type || a.walletClientType) === "privy")
      && (((a.chain_type || a.chainType) || "ethereum") === "ethereum")) || null;
  },
  async currentUser(){
    try { const r = await this.privy.user.get(); return (r && (r.user || r)) || null; } catch(e){ return null; }
  },
  // resolve the embedded wallet (creating it on first login) and hand back its EIP-1193 provider
  async ensureProvider(user){
    const ew = this.privy.embeddedWallet;
    let wallet = this.embeddedOf(user);
    if (!wallet){
      const create = ew.create || ew.createEthereumWallet || ew.createWallet;
      if (!create) throw new EnclaveError("This Privy SDK build exposes no wallet-create call.", 0);
      const res = await create.call(ew, {});
      const u2 = (res && (res.user || res)) || user;
      this.user = u2;
      wallet = this.embeddedOf(u2) || (res && res.wallet) || null;
    }
    if (!wallet) throw new EnclaveError("Privy login succeeded but no embedded wallet came back.", 0);
    const getProv = ew.getEthereumProvider || ew.getProvider;
    if (!getProv) throw new EnclaveError("This Privy SDK build exposes no EIP-1193 provider.", 0);
    let provider;
    try { provider = await getProv.call(ew, { wallet, chainId: BASE_CHAIN }); }
    catch(e){ provider = await getProv.call(ew, wallet); }
    if (!provider || !provider.request) throw new EnclaveError("Privy returned an unusable provider.", 0);
    try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_HEX }] }); } catch(_){}
    this.provider = provider;
    return provider;
  },
  // silent page-load reconnect for a returning Privy user (their auth persists in localStorage)
  async restore(){
    await this.load();
    const user = await this.currentUser();
    if (!user) return null;
    this.user = user;
    return this.entry(await this.ensureProvider(user));
  },
  async logout(){
    try { if (this.privy && this.privy.auth && this.privy.auth.logout) await this.privy.auth.logout(); } catch(_){}
    this.provider = null; this.user = null;
  }
};

/* the email → one-time-code flow, rendered inside the #walletPick modal card */
function privyCard(host, inner){ host.innerHTML = '<div class="wp-card">' + inner + '</div>'; }
async function privyPickFlow(host){
  privyCard(host, '<div class="wp-h">Sign in</div><div class="wp-note">Loading…</div>');
  await PrivyWallet.load();
  const existing = await PrivyWallet.currentUser();
  if (existing){
    privyCard(host, '<div class="wp-h">Sign in</div><div class="wp-note">Restoring your session…</div>');
    PrivyWallet.user = existing;
    return PrivyWallet.entry(await PrivyWallet.ensureProvider(existing));
  }
  // self-custody nudge for users with no extension wallet (they never saw the
  // chooser's recommendation); chooser arrivals already read it there
  const noExt = !Wallet.list().length;
  const email = await new Promise((res, rej) => {
    privyCard(host,
      '<div class="wp-h">Sign in with email</div>' +
      '<div class="wp-note">We’ll email you a one-time code. No password needed.</div>' +
      '<input class="wp-input" id="pvEmail" aria-label="Email address" type="email" autocomplete="email" spellcheck="false" placeholder="you@example.com" />' +
      '<div class="wp-err" id="pvErr" role="alert" hidden></div>' +
      '<button class="wp-item wp-go" id="pvSend" type="button">Continue</button>' +
      '<button class="wp-cancel" type="button">Cancel</button>' +
      (noExt ? '<div class="wp-rec wp-rec-foot">Prefer to hold your own keys? We <b>recommend a browser wallet</b> (MetaMask, Rabby, Coinbase…) — install one, reload, and sign in with it instead.</div>' : "") +
      '<div class="wp-foot">Protected by Privy</div>');
    const inp = $("#pvEmail"); if (inp) inp.focus();
    const go = () => {
      const v = (inp.value || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)){ const er = $("#pvErr"); er.textContent = "That doesn’t look like an email address."; er.hidden = false; return; }
      res(v);
    };
    $("#pvSend").onclick = go;
    inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
    host.querySelector(".wp-cancel").onclick = () => rej(new EnclaveError("Wallet selection cancelled.", 0));
  });
  privyCard(host, '<div class="wp-h">Sign in with email</div><div class="wp-note">Sending a login code to <b>' + esc(email) + '</b>…</div>');
  await PrivyWallet.privy.auth.email.sendCode(email);
  return await new Promise((res, rej) => {
    privyCard(host,
      '<div class="wp-h">Check your email</div>' +
      '<div class="wp-note">We sent a 6-digit code to <b>' + esc(email) + '</b>.</div>' +
      '<input class="wp-input" id="pvCode" aria-label="One-time code from the email" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" placeholder="123456" maxlength="6" />' +
      '<div class="wp-err" id="pvErr" role="alert" hidden></div>' +
      '<button class="wp-item wp-go" id="pvGo" type="button">Sign in</button>' +
      '<button class="wp-cancel" type="button">Cancel</button>');
    const inp = $("#pvCode"); if (inp) inp.focus();
    let busy = false;
    const fail = (msg) => { const er = $("#pvErr"); er.textContent = msg; er.hidden = false; busy = false; const b = $("#pvGo"); if (b) b.textContent = "Sign in"; };
    const submit = async () => {
      if (busy) return; busy = true;
      const code = (inp.value || "").trim();
      if (!/^\d{6}$/.test(code)){ fail("Enter the 6-digit code from the email."); return; }
      const b = $("#pvGo"); if (b) b.textContent = "Signing in…";
      try {
        const r = await PrivyWallet.privy.auth.email.loginWithCode(email, code);
        const user = (r && (r.user || r)) || null;
        if (!user) throw new Error("login returned no user");
        PrivyWallet.user = user;
        privyCard(host, '<div class="wp-h">Almost there</div><div class="wp-note">Setting up your account…</div>');
        res(PrivyWallet.entry(await PrivyWallet.ensureProvider(user)));
      } catch(e){
        if (host.querySelector("#pvErr")) fail("Sign-in failed: " + (e && (e.message || e)));
        else rej(new EnclaveError("Privy sign-in failed: " + (e && (e.message || e)), 0));
      }
    };
    $("#pvGo").onclick = submit;
    inp.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    host.querySelector(".wp-cancel").onclick = () => rej(new EnclaveError("Wallet selection cancelled.", 0));
  });
}

/* ---- assemble a canonical SIWE message only if the server didn't send one ---- */
function buildSiwe(ch){
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
   teardown; the caller's close() must run it. */
function modalize(host, onDismiss){
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  const h = host.querySelector(".wp-h");
  if (h){ h.id = h.id || "wpTitle"; host.setAttribute("aria-labelledby", h.id); }
  const prev = document.activeElement;
  const focusables = () => [...host.querySelectorAll("button,input,select,textarea,a[href]")].filter(el => !el.disabled && el.offsetParent !== null);
  // content may be rendered a tick after open (privy flow): retry once
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

/* ---- funding: card purchases (Privy-brokered onramps) + plain deposits ---- */
// small modal reusing the #walletPick overlay; backdrop / .wp-cancel close it
function fundModal(inner){
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

// Send USDC out to any address. This is the ONLY way an embedded-wallet (email)
// user gets funds back off the platform: their wallet is self-custodial but has
// no send UI of its own, so a bought-but-unspent balance would otherwise be
// stranded. Reuses sendTx (Privy gas sponsorship + gas-0 handling), so it works
// for injected wallets too. USDC.transfer(to, amount) on Base.
export function openSendModal(){
  if (!Enclave.address) return;
  const m = fundModal(
    '<div class="wp-h">Send USDC</div>' +
    '<div class="wp-note">Move <b>USDC on Base</b> from your wallet to any address. This leaves Enclave and is <b>final</b> - double-check the address, and send only on the Base network.</div>' +
    '<input class="wp-input" id="sendTo" aria-label="Recipient address" placeholder="0x… recipient address" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" />' +
    '<div class="wp-sendrow">' +
      '<input class="wp-input" id="sendAmt" aria-label="Amount in USDC" inputmode="decimal" placeholder="0.00" autocomplete="off" />' +
      '<button class="wp-mini" id="sendMax" type="button">Max</button>' +
    '</div>' +
    '<div class="wp-note">Balance: <span id="sendBal">…</span> USDC</div>' +
    '<div class="wp-status" id="sendStatus" role="status" hidden></div>' +
    '<button class="wp-item wp-go" id="sendGo" type="button">Send USDC</button>' +
    '<button class="wp-cancel" type="button">Close</button>');
  if (!m) return;
  let bal = 0;
  const balEl = $("#sendBal"), status = $("#sendStatus"), go = $("#sendGo");
  const setStatus = (cls, msg) => { if (!status) return; status.hidden = false; status.className = "wp-status " + cls; status.textContent = msg; };
  usdcBalanceOf(Enclave.address).then(
    (v) => { bal = v; if (balEl) balEl.textContent = v.toFixed(2); },
    ()  => { if (balEl) balEl.textContent = "unavailable"; });
  const maxB = $("#sendMax"); if (maxB) maxB.addEventListener("click", () => { const a = $("#sendAmt"); if (a) a.value = String(bal); });
  if (go) go.addEventListener("click", async () => {
    const to = ($("#sendTo").value || "").trim();
    const amt = Number(($("#sendAmt").value || "").trim());
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return setStatus("err", "Enter a valid recipient address (0x + 40 hex characters).");
    if (!(amt > 0)) return setStatus("err", "Enter an amount greater than zero.");
    if (amt > bal + 1e-9) return setStatus("err", "That's more than your balance (" + bal.toFixed(2) + " USDC).");
    const amt6 = BigInt(Math.round(amt * 1e6));
    if (amt6 <= 0n) return setStatus("err", "Amount is too small to send.");
    if (Enclave.chainId && Enclave.chainId !== BASE_CHAIN){
      setStatus("pend", "Switching your wallet to Base…");
      try { await ensureBaseChainOnConnect(Enclave.provider); } catch(_){}
      if (Enclave.chainId !== BASE_CHAIN) return setStatus("err", "Switch your wallet to the Base network, then retry.");
    }
    go.disabled = true;
    setStatus("pend", "Confirm the transfer in your wallet…");
    try {
      const data = encCall("a9059cbb", [{ t: "addr", v: to }, { t: "uint", v: amt6 }]);   // transfer(address,uint256)
      const hash = await sendTx(USDC_BASE, data);
      setStatus("pend", "Sent " + short(hash) + " · waiting for confirmation…");
      try { await waitReceipt(hash); } catch(_){}
      setStatus("ok", "✓ Sent " + amt.toFixed(2) + " USDC to " + short(to) + ".");
      refreshWallet();
      usdcBalanceOf(Enclave.address).then((v) => { bal = v; if (balEl) balEl.textContent = v.toFixed(2); }, () => {});
    } catch(e){
      setStatus("err", (e && e.message) || String(e));
    } finally { go.disabled = false; }
  });
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

// Card purchases run in /buy.html: a same-origin popup that hosts Privy's
// fiat onramp. It inherits this page's Privy session via localStorage, so it
// opens straight into checkout. The 129a7709 (2026-07-06, last verified-
// working) opener, adapted twice: Nan->Enclave (global renamed repo-wide in
// 7dbee4f1) and the ?v= cache key dropped (Steven, 2026-07-10) - bare URL.
export function openBuyModal(){
  if (!Enclave.address) return;
  const w = window.open("/buy.html", "enclaveBuy", "popup,width=480,height=780");
  if (!w){ showToast("Popup blocked - allow popups for this site and try again."); return; }
  showToast("Complete your purchase in the checkout window.");
}

async function pickWallet(){
  let wallets = Wallet.list();
  if (!wallets.length) wallets = await Wallet.discover();
  const privyOk = PrivyWallet.enabled();
  if (!wallets.length && !privyOk) throw new EnclaveError(noWalletReason(), 0);
  if (wallets.length === 1) return wallets[0];   // an extension wallet wins outright; Privy is the fallback
  if (!wallets.length){
    // no extension wallet: a plain email sign-in form, no wallet vocabulary -
    // the embedded wallet is created behind the scenes
    const host = $("#walletPick"); if (!host) throw new EnclaveError(noWalletReason(), 0);
    host.hidden = false;
    const close = () => { unmodal(); host.hidden = true; host.innerHTML = ""; };
    // Escape routes through the flow's own Cancel so its promise settles
    const unmodal = modalize(host, () => { const c = host.querySelector(".wp-cancel"); if (c) c.click(); });
    try { const entry = await privyPickFlow(host); close(); return entry; }
    catch(err){ close(); throw (err instanceof EnclaveError ? err : new EnclaveError("Sign-in failed: " + (err && (err.message || err)), 0)); }
  }
  return await new Promise((resolve, reject) => {
    const host = $("#walletPick"); if (!host){ resolve(wallets[0]); return; }
    host.innerHTML = '<div class="wp-card"><div class="wp-h">Choose a wallet</div>' +
      (privyOk ? '<div class="wp-rec"><b>Recommended</b> — with a browser wallet, your keys stay on your device and only you control them.</div>' : "") +
      wallets.map((w, i) => '<button class="wp-item" data-i="' + i + '">' +
        (w.info.icon ? '<img src="' + esc(w.info.icon) + '" alt=""/>' : '<span class="wp-dot"></span>') +
        esc(w.info.name) + '</button>').join("") +
      (privyOk ? '<div class="wp-or"><span>or</span></div>' +
        '<button class="wp-item wp-privy" type="button"><span class="wp-dot wp-dot-iris"></span>Continue with email</button>' +
        '<div class="wp-hint">Easiest start — creates a wallet whose keys are held for you by Privy.</div>' : "") +
      '<button class="wp-cancel">Cancel</button></div>';
    host.hidden = false;
    const close = () => { unmodal(); host.hidden = true; host.innerHTML = ""; };
    let privyBusy = false;
    const unmodal = modalize(host, () => {
      // during the email flow, route Escape through ITS Cancel (settles its promise)
      if (privyBusy){ const c = host.querySelector(".wp-cancel"); if (c) c.click(); return; }
      close(); reject(new EnclaveError("Wallet selection cancelled.", 0));
    });
    // backdrop dismissal on pointerDOWN (see fundModal): selection drags out
    // of the card must not cancel the wallet pick
    host.onpointerdown = (e) => {
      if (privyBusy) return;
      if (e.target === host){ close(); reject(new EnclaveError("Wallet selection cancelled.", 0)); }
    };
    host.onclick = (e) => {
      if (e.target.closest(".wp-privy")){
        if (privyBusy) return; privyBusy = true;
        privyPickFlow(host).then((entry) => { close(); resolve(entry); },
                               (err) => { close(); reject(err instanceof EnclaveError ? err : new EnclaveError("Privy sign-in failed: " + (err && (err.message || err)), 0)); });
        return;
      }
      const it = e.target.closest(".wp-item");
      if (it && it.dataset.i != null){ const w = wallets[+it.dataset.i]; close(); resolve(w); return; }
      if (privyBusy) return;   // during the email flow, only its own Cancel button closes
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
  Enclave.walletEmail = (chosen.info && chosen.info.email) || null;
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
  if (Enclave.walletRdns === PRIVY_RDNS) PrivyWallet.logout();   // fire-and-forget; clears the Privy auth session too
  Enclave.token = null; Enclave.address = null; Enclave.provider = null; Enclave.chainId = null; Enclave.walletRdns = null; Enclave.walletEmail = null;
  clearSession();
  runlog.clear();   // don't leave the prior user's deploy narratives in localStorage / on-screen
  const pop = $("#walletPop"); if (pop){ pop.hidden = true; pop.innerHTML = ""; popExpanded(false); }
  refreshWallet();
  emit("enclave:auth", { authed: false });
}

/* ---- session persistence: survive a page refresh (localStorage bearer token) ---- */
export function saveSession(){
  if (!Enclave.address){ lsSet("enclave_session", ""); return; }
  try { lsSet("enclave_session", JSON.stringify({ address: Enclave.address, rdns: Enclave.walletRdns || null, email: Enclave.walletEmail || null, token: Enclave.token || null })); } catch(e){}
}
export function clearSession(){ lsSet("enclave_session", ""); }
// pull the exp (seconds) out of a JWT; null if not a JWT / no exp
function jwtExp(token){
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
  // paint the header button IMMEDIATELY from the cached session (email for Privy
  // users) - the real restore below can take seconds (wallet discovery + the
  // extension round-trip) and the button said "Sign in" the whole time. Render
  // the EXACT final connected look, so the later refreshWallet repaint is
  // pixel-identical and the header stays still through view transitions. In
  // production the page's inline wallet-paint script (scripts/build-site.mjs)
  // already did this during parse - don't repaint over it.
  const early = $("#walletBtn");
  if (early && s.address && !early.dataset.painted){
    const who = s.email ? (s.email.length > 24 ? s.email.slice(0, 21) + "…" : s.email) : short(s.address);
    early.classList.add("connected");
    early.innerHTML = '<span class="wdot"></span>' + esc(who);
  }
  try {
  let chosen = null;
  if (s.rdns === PRIVY_RDNS){                                     // prior session was a Privy embedded wallet
    if (!PrivyWallet.enabled()) return;
    try { chosen = await PrivyWallet.restore(); } catch(e){ return; }
    if (!chosen) return;                                          // Privy auth expired; leave it to a manual Connect
  } else {
    let wallets = Wallet.list(); if (!wallets.length) wallets = await Wallet.discover();
    chosen = s.rdns ? wallets.find(w => w.info && w.info.rdns === s.rdns) : null;
    if (!chosen && wallets.length === 1) chosen = wallets[0];
    if (!chosen) return;                                          // can't reconnect silently; leave it to a manual Connect
  }
  const provider = chosen.provider;
  let accounts = []; try { accounts = await provider.request({ method: "eth_accounts" }); } catch(e){ return; }
  const addr = accounts && accounts[0];
  if (!addr || addr.toLowerCase() !== String(s.address).toLowerCase()) return;   // permission revoked / different account
  let cid; try { cid = await provider.request({ method: "eth_chainId" }); } catch(e){}
  Enclave.provider = provider; Enclave.address = addr; Enclave.chainId = cid ? parseInt(cid, 16) : null;
  Enclave.walletRdns = (chosen.info && chosen.info.rdns) || null;
  Enclave.walletEmail = (chosen.info && chosen.info.email) || s.email || null;
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
      const who = Enclave.walletEmail ? (Enclave.walletEmail.length > 24 ? Enclave.walletEmail.slice(0, 21) + "…" : Enclave.walletEmail) : short(Enclave.address);
      btn.classList.add("connected");
      btn.innerHTML = '<span class="wdot"></span>' + esc(who);
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
  const pop = $("#walletPop"); if (!pop || !Enclave.address) return;
  const offBase = Enclave.chainId && Enclave.chainId !== BASE_CHAIN;
  pop.innerHTML =
    (Enclave.walletEmail ? '<div class="wp-row"><span class="wp-k">Account</span><span class="wp-v">' + esc(Enclave.walletEmail) + '</span></div>' : "") +
    '<div class="wp-row"><span class="wp-k">' + (Enclave.walletEmail ? "Address" : "Wallet") + '</span><button class="wp-addr" id="wpCopy">' + esc(short(Enclave.address)) + ' ⧉</button></div>' +
    '<div class="wp-row"><span class="wp-k">Network</span><span class="wp-v">' + (Enclave.chainId === BASE_CHAIN ? "Base" : ("chain " + (Enclave.chainId || "–"))) + (offBase ? ' <button class="wp-mini" id="wpSwitch">switch to Base</button>' : "") + '</span></div>' +
    '<div class="wp-row"><span class="wp-k">Session</span><span class="wp-v">' + (Enclave.authed() ? '<span class="ok">signed in</span>' : '<button class="wp-mini" id="wpAuth">sign in</button>') + '</span></div>' +
    '<div class="wp-bal"><div class="bl"><span>USDC balance</span><span id="wpBalUsdc">…</span></div></div>' +
    '<div class="wp-bal" id="wpBal">' + (Enclave.authed() ? "loading deployments…" : "sign in to load deployments") + '</div>' +
    '<div class="wp-fund">' +
      ((Enclave.walletRdns === PRIVY_RDNS && PrivyWallet.enabled()) ? '<button class="wp-mini wp-buy" id="wpBuy">Buy USDC · card</button>' : "") +
      '<button class="wp-mini" id="wpDep">Deposit</button>' +
      '<button class="wp-mini" id="wpSend">Send</button>' +
    '</div>' +
    '<button class="wp-disc" id="wpDisc">Sign out</button>';
  pop.hidden = false;
  popExpanded(true);
  const c = $("#wpCopy"); if (c) c.addEventListener("click", () => copyText(Enclave.address));
  const d = $("#wpDisc"); if (d) d.addEventListener("click", disconnectWallet);
  const bb = $("#wpBuy"); if (bb) bb.addEventListener("click", () => { pop.hidden = true; popExpanded(false); openBuyModal(); });
  const dep = $("#wpDep"); if (dep) dep.addEventListener("click", () => { pop.hidden = true; popExpanded(false); openDepositModal(); });
  const snd = $("#wpSend"); if (snd) snd.addEventListener("click", () => { pop.hidden = true; popExpanded(false); openSendModal(); });
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

/* ---- Privy native gas sponsorship ----
   Embedded-wallet (email) users hold only card-bought USDC - with 0 ETH every
   send dies at broadcast ("insufficient funds for gas"). Privy can front the
   gas itself (dashboard: Gas sponsorship -> App pays + Base + "Allow
   transactions from the client"): the wallet API accepts eth_sendTransaction
   with sponsor:true for wallets on their TEE stack (linked account carries a
   wallet id + recovery_method "privy-v2"), executes it via an EIP-7702
   delegation and bills the app - the tx still comes FROM the user's address,
   so on-chain ownership (create()'s msg.sender) is untouched.
   Returns the tx hash, or null when the sponsored path isn't available
   (old-stack wallet, sponsorship not configured, no credit) - the caller
   falls back to the normal self-paid send. */
let _sponsorReason = "";   // why the last sponsored attempt fell through (folded into gas errors)
async function privySponsoredSend(tx){
  const mod = PrivyWallet._mod, privy = PrivyWallet.privy;
  if (!mod || !privy || !mod.rpc || !mod.isUnifiedWallet || !mod.toWalletApiUnsignedEthTransaction
      || !privy.embeddedWallet || !privy.embeddedWallet.signWithUserSigner){
    _sponsorReason = "no live Privy SDK session"; return null;
  }
  const acct = PrivyWallet.embeddedOf(PrivyWallet.user);
  if (!acct || !mod.isUnifiedWallet(acct)){
    _sponsorReason = "this wallet predates Privy's TEE stack"; return null;
  }
  try {
    const transaction = mod.toWalletApiUnsignedEthTransaction({
      from: tx.from, to: tx.to, data: tx.data, value: tx.value, chainId: BASE_CHAIN });
    const r = await mod.rpc(privy, (m) => privy.embeddedWallet.signWithUserSigner(m), {
      wallet_id: acct.id, chain_type: "ethereum", method: "eth_sendTransaction",
      caip2: "eip155:" + BASE_CHAIN, sponsor: true, params: { transaction } });
    const hash = r && r.data && r.data.hash;
    if (!hash) throw new Error("no tx hash in the sponsored-send response");
    _sponsorReason = "";
    return hash;
  } catch(e){
    _sponsorReason = String((e && (e.message || e)) || "sponsored send failed").slice(0, 200);
    console.warn("[wallet] sponsored send unavailable, falling back to self-paid gas:", _sponsorReason);
    return null;
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
  // Embedded-wallet users pay gas from a wallet that never holds ETH: try
  // Privy's sponsored send first (app pays; same from-address). Null means
  // "unavailable", never "failed to send" - falling through is safe.
  if (Enclave.walletRdns === PRIVY_RDNS){
    const sponsored = await privySponsoredSend(tx);
    if (sponsored) return sponsored;
  }
  // Privy's embedded signer signs the request verbatim - without an explicit
  // gas field it produces a gas-0 tx every node rejects ("intrinsic gas too
  // low"). Injected wallets accept a provided limit too, so estimate for both:
  // provider first, public Base RPC as fallback.
  let est = null;
  try { est = await Enclave.provider.request({ method: "eth_estimateGas", params: [tx] }); }
  catch(_){ try { est = await baseRpc("eth_estimateGas", [tx]); } catch(_2){} }
  if (est) {
    tx.gas = "0x" + (BigInt(est) + BigInt(est) / 4n).toString(16);
    // Privy's legacy iframe signer (the pinned era bundle) skips its populate
    // step when wallet UIs are on and reads the limit ONLY under its
    // ethers-style name - without gasLimit it signs the tx with gas 0.
    if (Enclave.walletRdns === PRIVY_RDNS) tx.gasLimit = tx.gas;
  }
  // an injected wallet estimates for itself, so a gasless send is fine there;
  // for the embedded wallet it is a guaranteed gas-0 failure - say so instead
  else if (Enclave.walletRdns === PRIVY_RDNS)
    throw new EnclaveError("Could not estimate gas for this transaction - it may revert (check your balance and inputs), or the RPC is unreachable. Nothing was sent.", 0);
  try {
    return await Enclave.provider.request({ method: "eth_sendTransaction", params: [tx] });
  } catch(e){
    // a 0-ETH embedded wallet dies exactly here, at broadcast - name the real
    // problem (gas) instead of surfacing the RPC's wall of hex
    if (Enclave.walletRdns === PRIVY_RDNS && /insufficient funds/i.test((e && e.message) || ""))
      throw new EnclaveError("Your wallet has no ETH on Base to cover this transaction's network fee (a fraction of a cent)"
        + (_sponsorReason ? "; gas sponsorship didn't cover it (" + _sponsorReason + ")" : "")
        + ". Send a little ETH on Base to " + Enclave.address + " and retry.", 0);
    throw e;
  }
}
