/* ============================================================
   Relay account sign-in - passkeys (primary) + wallet SIWE
   (secondary), against api.enclave.host /v1/account/*.

   A THIRD state domain on the Enclave global, orthogonal to the
   wallet connection and the enclave session (wallet.js):
     Enclave.accountToken/accountId/accountMethod - ES256 JWT the
     RELAY minted; gates billing/orders/checkout only. Every edge
     emits `enclave:account` {authed, method}; existing consumers
     of enclave:wallet / enclave:auth are untouched.

   Passkeys: username-less discoverable credentials via
   @simplewebauthn/browser, lazy-loaded same-origin from
   /vendor/webauthn.js (scripts/build-vendor.mjs pin) - no
   WebAuthn bytes load until the user picks the option. The
   private key lives in the user's authenticator; the relay
   stores only the public key + credential id + counter.

   Session persists in localStorage "enclave_account" - a
   DIFFERENT key from "enclave_session" (the enclave token):
   the two trust domains never share storage.
   ============================================================ */
import { ACCOUNTS_ENABLED } from "./config.js";
import { Enclave, EnclaveError } from "./api.js";
import { modalize, buildSiwe, jwtExp, connectWallet, refreshWallet } from "./wallet.js";
import { $, esc, lsGet, lsSet, showToast, emit } from "./util.js";
import { qrSvg } from "../lib/qr.js";

export function passkeySupported(){
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/* ---- session lifecycle ---- */
function adoptAccountSession(sess){
  Enclave.accountToken = sess.token;
  Enclave.accountId = sess.accountId;
  Enclave.accountMethod = sess.method || null;
  saveAccountSession();
  emit("enclave:account", { authed: true, method: Enclave.accountMethod });
  refreshWallet();
  return sess;
}
export function saveAccountSession(){
  if (!Enclave.accountToken){ lsSet("enclave_account", ""); return; }
  try { lsSet("enclave_account", JSON.stringify({ token: Enclave.accountToken, accountId: Enclave.accountId, method: Enclave.accountMethod })); } catch(e){}
}
export function restoreAccountSession(){
  let raw; try { raw = lsGet("enclave_account"); } catch(e){ return; }
  if (!raw) return;
  let s; try { s = JSON.parse(raw); } catch(e){ lsSet("enclave_account", ""); return; }
  if (!s || !s.token) return;
  const exp = jwtExp(s.token);
  if (exp && exp * 1000 <= Date.now()){ lsSet("enclave_account", ""); return; }
  Enclave.accountToken = s.token;
  Enclave.accountId = s.accountId || null;
  Enclave.accountMethod = s.method || null;
  emit("enclave:account", { authed: true, method: Enclave.accountMethod });
  refreshWallet();
}
export function signOutAccount(){
  Enclave.clearAccountSession();
  refreshWallet();
}

/* ---- passkey ceremonies (lazy same-origin WebAuthn client) ---- */
async function webauthn(){
  try { return await import("/vendor/webauthn.js"); }
  catch(e){ throw new EnclaveError("Could not load the passkey client: " + (e.message || e), 0); }
}
export async function registerPasskey(){
  const wa = await webauthn();
  const { challengeId, options } = await Enclave.accountRegisterOptions();
  let credential;
  try { credential = await wa.startRegistration({ optionsJSON: options }); }
  catch(e){ throw ceremonyError(e, "create"); }
  return adoptAccountSession(await Enclave.accountRegisterVerify(challengeId, credential));
}
export async function signInWithPasskey(){
  const wa = await webauthn();
  const { challengeId, options } = await Enclave.accountLoginOptions();
  let credential;
  try { credential = await wa.startAuthentication({ optionsJSON: options }); }
  catch(e){ throw ceremonyError(e, "use"); }
  return adoptAccountSession(await Enclave.accountLoginVerify(challengeId, credential));
}
// browser ceremony errors, translated once: cancelled/timed out is retryable
// (the modal keeps both options up), anything else names itself
function ceremonyError(e, verb){
  const name = e && e.name;
  if (name === "NotAllowedError")
    return Object.assign(new EnclaveError("That was cancelled or timed out. Try again.", 0), { retryable: true });
  if (name === "InvalidStateError" && verb === "create")
    return Object.assign(new EnclaveError("This device already has a passkey for Enclave. Use \"Continue with passkey\" instead.", 0), { retryable: true });
  return new EnclaveError("Passkey " + verb + " failed: " + ((e && (e.message || e.name)) || e), 0);
}

/* ---- wallet SIWE against the RELAY (account sign-in) ----
   Distinct from wallet.js authenticate(), which mints the ENCLAVE session;
   a wallet user typically ends up with both, each doing its own job. */
export async function signInWalletAccount(){
  if (!Enclave.provider) await connectWallet();
  const ch = await Enclave.accountSiweNonce(Enclave.address);
  const message = (ch && ch.message) ? ch.message : buildSiwe(ch);
  let signature;
  try {
    signature = await Enclave.provider.request({ method: "personal_sign", params: [message, Enclave.address] });
  } catch(e){
    throw new EnclaveError((e && e.code === 4001) ? "Signature rejected." : ("Could not sign in: " + (e.message || e)), 0);
  }
  return adoptAccountSession(await Enclave.accountSiweVerify(message, signature));
}

/* ---- the sign-in chooser (renders into the #walletPick overlay) ----
   Resolves with the session on success, rejects on cancel. Passkey errors
   that are retryable stay INSIDE the modal (inline role=alert); terminal
   ones toast and keep the modal up so the other option remains. */
export function openAuthModal(){
  if (!ACCOUNTS_ENABLED) return Promise.reject(new EnclaveError("Accounts are not enabled yet.", 0));
  let host = $("#walletPick");
  if (!host){
    // same portal wallet-button.js creates on wire-up; making it here too
    // means the modal never races component connection (auto-open on /link)
    host = document.createElement("div");
    host.className = "wallet-pick"; host.id = "walletPick"; host.hidden = true;
    document.body.appendChild(host);
  }
  const pk = passkeySupported();
  return new Promise((resolve, reject) => {
    host.innerHTML = '<div class="wp-card"><div class="wp-h">Sign in to Enclave</div>' +
      '<div class="wp-note">Your apps, orders, and receipts live on your account.</div>' +
      (pk ? '<button class="wp-item wp-go" id="authPasskey" type="button">Continue with passkey</button>' +
            '<div class="wp-hint">Signs you in - or creates your account if you\'re new. Uses your device\'s screen lock; no password, no email.</div>' +
            '<div class="wp-or"><span>or</span></div>'
          : '<div class="wp-note">This browser does not support passkeys, so wallet sign-in it is.</div>') +
      '<button class="wp-item" id="authWallet" type="button"><span class="wp-dot"></span>Connect a wallet</button>' +
      '<button class="wp-item" id="authPhone" type="button">Use your phone</button>' +
      '<div class="wp-err" id="authErr" role="alert" hidden></div>' +
      '<button class="wp-cancel" type="button">Cancel</button></div>';
    host.hidden = false;
    let done = false, stopPhone = null;
    const close = () => { if (stopPhone) stopPhone(); unmodal(); host.hidden = true; host.innerHTML = ""; host.onclick = null; host.onpointerdown = null; };
    const cancel = () => { if (done) return; done = true; close(); reject(new EnclaveError("Sign-in cancelled.", 0)); };
    const unmodal = modalize(host, cancel);
    host.onpointerdown = (e) => { if (e.target === host) cancel(); };
    const fail = (e) => {
      const el = host.querySelector("#authErr");
      if (el && e && e.retryable){ el.textContent = e.message; el.hidden = false; return; }
      showToast((e && e.message) || String(e));
      if (el){ el.textContent = (e && e.message) || String(e); el.hidden = false; }
    };
    const attempt = (fn) => async () => {
      if (done) return;
      const el = host.querySelector("#authErr"); if (el) el.hidden = true;
      try {
        const sess = await fn();
        if (done) return;
        done = true; close(); resolve(sess);
      } catch(e){ if (!done) fail(e); }
    };
    // "Use your phone": the self-hosted device flow for browsers with no
    // passkey path (Linux Firefox, no Bluetooth). The QR carries only the
    // one-time code; the claim secret never leaves this browser. Polls until
    // the phone approves on /link, then adopts the session like any other.
    const phoneView = async () => {
      if (done) return;
      const card = host.querySelector(".wp-card"); if (!card) return;
      let dead = false, timer = 0;
      stopPhone = () => { dead = true; clearTimeout(timer); stopPhone = null; };
      card.innerHTML = '<div class="wp-h">Sign in with your phone</div><div class="wp-note">Starting…</div>';
      let d;
      try { d = await Enclave.accountDeviceStart(); }
      catch(e){ if (!dead){ stopPhone(); fail(e); } return; }
      if (dead) return;
      const url = location.origin + "/link?code=" + encodeURIComponent(d.code);
      card.innerHTML =
        '<div class="wp-h">Sign in with your phone</div>' +
        '<div class="wp-note">Scan with your phone camera, then approve there. Only approve a code you started yourself.</div>' +
        '<div class="wp-qr" aria-label="sign-in link as a QR code">' + qrSvg(url) + '</div>' +
        '<div class="wp-note">or open <b>enclave.host/link</b> on your phone and enter <code class="wp-code">' +
          esc(d.code.slice(0, 4) + "-" + d.code.slice(4)) + '</code></div>' +
        '<div class="wp-err" id="authErr" role="alert" hidden></div>' +
        '<button class="wp-cancel" type="button">Cancel</button>';
      const poll = async () => {
        if (dead || done) return;
        try {
          const r = await Enclave.accountDeviceClaim(d.code, d.secret);
          if (dead || done) return;
          if (r.status === "ok"){ done = true; close(); resolve(adoptAccountSession(r)); return; }
          if (r.status === "denied"){ stopPhone(); fail(new EnclaveError("The request was denied on your phone.", 0)); return; }
        } catch(e){
          if (dead || done) return;
          if (e && e.status === 404){ stopPhone(); fail(new EnclaveError("The code expired. Try again.", 0)); return; }
          // transient network errors: keep polling
        }
        timer = setTimeout(poll, (d.interval || 3) * 1000);
      };
      timer = setTimeout(poll, (d.interval || 3) * 1000);
    };
    // one passkey button, the /link chain: sign in, and when that fails
    // (no credential / dismissed - WebAuthn hides which) roll into register.
    // Safari grants ONE user activation per tap and the failed get() can eat
    // it, so when the whole chain dies the button converts to a direct
    // "Create a passkey" - the next tap runs register alone, fresh activation.
    let passkeyDirect = false;
    const passkeyFlow = async () => {
      if (passkeyDirect) return registerPasskey();
      try { return await signInWithPasskey(); }
      catch(_) {
        try { return await registerPasskey(); }
        catch(e2){
          if (e2 && /already has a passkey/i.test(e2.message || "")) throw e2;   // InvalidStateError: sign-in is what they need
          passkeyDirect = true;
          const btn = host.querySelector("#authPasskey");
          if (btn) btn.textContent = "Create a passkey";
          throw Object.assign(new EnclaveError("That didn't finish. Tap \"Create a passkey\" to make one on this device.", 0), { retryable: true });
        }
      }
    };
    host.onclick = (e) => {
      if (e.target.closest("#authPasskey")) return attempt(passkeyFlow)();
      if (e.target.closest("#authPhone")) return void phoneView();
      if (e.target.closest("#authWallet")){
        // connectWallet's own chooser needs the #walletPick host - hand it
        // over, then finish the relay SIWE and settle this modal's promise
        if (done) return;
        done = true; close();
        signInWalletAccount().then(resolve, (err) => { showToast((err && err.message) || String(err)); reject(err); });
        return;
      }
      if (e.target.closest(".wp-cancel")) cancel();
    };
  });
}
