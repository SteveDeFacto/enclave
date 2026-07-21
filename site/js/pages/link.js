/* ============================================================
   /link - the phone side of the device flow. The other screen
   (a browser with no passkey path) shows a QR that lands here
   with ?code=…; this page authenticates the user normally
   (passkey or wallet), shows WHO is asking (browser, IP, age),
   and posts the approve/deny. The desktop's poll then claims
   its session. Without ?code the page offers manual entry -
   the same door a future CLI device flow walks through.

   Phishing note (no proximity proof, unlike the browser-native
   hybrid flow): the warning copy and requester context ARE the
   defense - never soften them.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { ACCOUNTS_ENABLED } from "../core/config.js";
import { Enclave } from "../core/api.js";
import { $, esc, showToast } from "../core/util.js";
import { openSignIn, passkeySupported, registerPasskey, signInWithPasskey } from "../core/account.js";

const normalize = (s) => String(s || "").toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 8);
let autoOpened = false;   // auto-open the sign-in chooser only once per load

// coarse, honest UA summary - display only, never trusted
function uaSummary(ua){
  const b = /firefox/i.test(ua) ? "Firefox" : /edg/i.test(ua) ? "Edge" : /chrom/i.test(ua) ? "Chrome"
    : /safari/i.test(ua) ? "Safari" : "a browser";
  const o = /windows/i.test(ua) ? "Windows" : /android/i.test(ua) ? "Android" : /iphone|ipad|ios/i.test(ua) ? "iOS"
    : /mac os|macintosh/i.test(ua) ? "macOS" : /linux|x11/i.test(ua) ? "Linux" : "an unknown OS";
  return b + " on " + o;
}

function mount(){
  const body = $("#lkBody"); if (!body) return;
  if (!ACCOUNTS_ENABLED){ const g = $("#lkGate"); if (g) g.hidden = false; return; }

  const code = normalize(new URL(location.href).searchParams.get("code"));
  if (code) return showRequest(body, code);

  body.innerHTML =
    '<div class="lk-card"><p class="co-note">Enter the code shown on your other screen.</p>' +
    '<form id="lkForm" class="lk-row"><input id="lkCode" class="ac-in" inputmode="text" autocomplete="off" ' +
    'autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" aria-label="Device code" />' +
    '<button class="btn btn-primary" type="submit">Continue</button></form></div>';
  $("#lkForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const c = normalize($("#lkCode").value);
    if (c.length !== 8) return showToast("Codes are 8 letters and digits.");
    history.replaceState(null, "", "link?code=" + c);
    showRequest(body, c);
  });
}

async function showRequest(body, code){
  body.innerHTML = '<p class="co-note">Looking up the request…</p>';
  let info;
  try { info = await Enclave.accountDeviceInfo(code); }
  catch(e){
    body.innerHTML = '<div class="lk-card"><p class="co-note">' +
      esc(e && e.status === 404 ? "This code is expired or unknown. Start again on your other screen." : (e.message || String(e))) +
      '</p></div>';
    return;
  }
  if (info.state !== "pending"){
    body.innerHTML = '<div class="lk-card"><p class="co-note">This request was already answered.</p></div>';
    return;
  }

  const age = Math.max(0, Math.round((Date.now() - Date.parse(info.createdAt)) / 1000));
  const facts =
    '<dl class="lk-facts"><div><dt>Screen</dt><dd>' + esc(uaSummary(info.ua)) + '</dd></div>' +
    '<div><dt>Network</dt><dd><code>' + esc(info.ip || "unknown") + '</code></dd></div>' +
    '<div><dt>Started</dt><dd>' + (age < 90 ? age + " seconds" : Math.round(age / 60) + " minutes") + ' ago</dd></div>' +
    '<div><dt>Code</dt><dd><code>' + esc(code.slice(0, 4) + "-" + code.slice(4)) + '</code></dd></div></dl>';

  if (!Enclave.accountAuthed()){
    body.innerHTML = '<div class="lk-card">' + facts +
      '<p class="co-note">Sign in to answer this request.</p>' +
      '<button class="btn btn-primary" id="lkAuth" type="button">Sign in</button></div>';
    const gate = async () => {
      try { await openSignIn(); showRequest(body, code); }
      catch(e){ if (!/cancelled/i.test((e && e.message) || "")) showToast((e && e.message) || String(e)); }
    };
    $("#lkAuth").addEventListener("click", gate);
    // straight into the passkey ceremony itself: sign in, and when that
    // fails, REGISTER - a QR scan is unambiguous sign-in intent, and WebAuthn
    // deliberately hides whether "no passkey" or "user dismissed" happened,
    // so the chain is the only way to serve first-timers without a tap.
    // A user with an account elsewhere cancels the create sheet and lands in
    // the chooser (wallet et al); iOS Safari refuses activation-less WebAuthn
    // entirely and goes straight there, where buttons carry the real tap.
    if (!autoOpened){
      autoOpened = true;
      if (passkeySupported())
        signInWithPasskey().then(() => showRequest(body, code))
          .catch(() => registerPasskey().then(() => showRequest(body, code))
            .catch(() => gate()));
      else gate();
    }
    return;
  }

  body.innerHTML = '<div class="lk-card">' + facts +
    '<p class="co-note"><b>Only approve if you just started this yourself</b> on the screen described above. ' +
    'Approving signs that screen in to your account. If anyone sent you this code or QR, deny it.</p>' +
    '<div class="lk-row"><button class="btn btn-primary" id="lkApprove" type="button">Approve sign-in</button>' +
    '<button class="btn" id="lkDeny" type="button">Deny</button></div></div>';
  const answer = async (approve) => {
    try {
      await Enclave.accountDeviceApprove(code, approve);
      body.innerHTML = '<div class="lk-card"><p class="co-note">' +
        (approve ? "Approved. Your other screen signs itself in within a few seconds - you can close this page."
                 : "Denied. The other screen stays signed out.") + '</p></div>';
    } catch(e){
      showToast((e && e.message) || String(e));
      if (e && (e.status === 404 || e.status === 409)) showRequest(body, code);
    }
  };
  $("#lkApprove").addEventListener("click", () => answer(true));
  $("#lkDeny").addEventListener("click", () => answer(false));
}

mount();
