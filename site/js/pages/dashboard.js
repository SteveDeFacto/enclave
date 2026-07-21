/* ============================================================
   Dashboard page - the signed-in view: <c-deployments> (the My
   Apps panel) with per-run live-deploy strips and a per-row
   Output panel (deploy narrative + app logs). The page module
   wires the EnclaveDeployments contract chips (the ledger every
   row lives on) and bounces signed-out visitors to Overview.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/deployments/deployments.js";
import "../../components/fleet-list/fleet-list.js";
import { $, esc, fmtDur, lsGet, on } from "../core/util.js";
import { DEPLOYMENTS_ADDRESS } from "../core/config.js";
import { catExplorer } from "../core/chain.js";
import { Enclave } from "../core/api.js";
import { navigate } from "../boot.js";

/* Signed-out visitors have nothing here - bounce to Overview. "Signed out"
   means NO connected address and NO persisted session either: the wallet
   restore is ASYNC (provider discovery takes seconds), so a stored session
   holds the page while it settles; sign-out clears the store and the next
   wallet edge bounces. */
function gate(){
  if (!document.querySelector('section[data-view="dashboard"]')) return;   // another page's <main> is mounted
  if (Enclave.address || Enclave.accountAuthed()) return;
  let stored = null, acct = null;
  try { stored = JSON.parse(lsGet("enclave_session") || "null"); } catch(e){}
  try { acct = JSON.parse(lsGet("enclave_account") || "null"); } catch(e){}
  if ((!stored || !stored.address) && (!acct || !acct.token)) navigate("./");
}
on("enclave:wallet", gate);   // module-load-once: restore-settle and sign-out edges
on("enclave:account", (d) => {
  gate();
  // passkey/card sign-in lands here with no wallet: swap in the account view
  if (d && d.authed && !Enclave.address && document.querySelector('section[data-view="dashboard"]')) mountAccountView();
});

/* account-only view: passkey/card customers. Their deployments are owned
   on-chain by the relay's provisioner wallet, so <c-deployments> (a wallet
   ledger reader) has nothing to show - the relay's account-scoped join
   (GET /v1/billing/deployments) is the source instead. Read-only v1:
   status, runtime left, spend; logs/attestation for account customers is
   tracked follow-up work. */
function mountAccountView(){
  const cd = document.querySelector("c-deployments"); if (!cd) return;
  if (!$("#acctDeps")){
    cd.hidden = true;
    const div = document.createElement("div");
    div.id = "acctDeps"; div.className = "acct-deps";
    div.innerHTML = '<p class="acct-note">Loading your deployments…</p>';
    cd.parentNode.insertBefore(div, cd);
  }
  refreshAccountDeps();
}
let _acctRetry = 0;
async function refreshAccountDeps(){
  const el = $("#acctDeps"); if (!el) return;
  let rows;
  try { rows = (await Enclave.accountDeployments()).deployments || []; }
  catch(e){ el.innerHTML = '<p class="acct-note">' + esc((e && e.message) || String(e)) + '</p>'; return; }
  // a just-provisioned row can outrun the relay's ledger cache (~10s TTL) and
  // read "unknown" for a beat - retry briskly until the join fills in
  clearTimeout(_acctRetry);
  if (rows.some((d) => !d.status || d.status === "unknown"))
    _acctRetry = setTimeout(() => { if ($("#acctDeps")) refreshAccountDeps(); }, 4000);
  if (!rows.length){
    el.innerHTML = '<p class="acct-note">Nothing running yet. <a href="checkout">Buy runtime</a> to launch your first app.</p>';
    return;
  }
  el.innerHTML = rows.map((d) => {
    const app = (d.image && d.image.reference) || "app";
    const left = d.timeRemainingSec != null ? fmtDur(d.timeRemainingSec) + " left" : "";
    return '<div class="acct-row">' +
      '<div class="acct-app"><b>' + esc(app) + '</b> <code>' + esc(String(d.deploymentId).slice(0, 10)) + '…</code></div>' +
      '<div class="acct-meta"><span class="acct-st st-' + esc(d.status || "unknown") + '">' + esc(d.status || "unknown") + '</span>' +
      (left ? '<span>' + esc(left) + '</span>' : "") +
      '<span>$' + esc(d.spentUsdc || "0.00") + ' spent</span></div></div>';
  }).join("");
}

/* the fleet capacity panel: the relay's /enclaves table, same sort as the
   deploy console; polled only while this page's <main> is mounted */
let _fleetPoll = null;
async function refreshFleet(){
  const fl = document.querySelector(".dash-fleet c-fleet-list"); if (!fl) return;
  try {
    const r = await fetch(Enclave.base.replace(/\/v1\/?$/, "") + "/enclaves", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("no fleet view");
    const j = await r.json();
    fl.rows = (j.enclaves || []).slice().sort((a, b) =>
      ((b.availability && b.availability.gpu) === true) - ((a.availability && a.availability.gpu) === true)
      || String(a.endpoint || "").localeCompare(String(b.endpoint || "")));
  } catch(e){ fl.rows = []; }   // the component's empty state reads "no live enclaves"
}

export function boot() {
  refreshFleet();
  // the component's ↻ button: re-fetch on demand (named ref = idempotent re-boot)
  const fl = document.querySelector(".dash-fleet c-fleet-list");
  if (fl) fl.addEventListener("refresh", refreshFleet);
  if (!_fleetPoll) _fleetPoll = setInterval(() => {
    if (!document.querySelector('section[data-view="dashboard"]')) return;
    refreshFleet();
    if ($("#acctDeps")) refreshAccountDeps();
  }, 20000);
  // the ledger's provenance mark: one icon straight to the contract on
  // Basescan (Steven's call); full name + address in the tooltip
  const link = $("#depAddrLink");
  if (link){
    if (DEPLOYMENTS_ADDRESS && !/^0x0+$/i.test(DEPLOYMENTS_ADDRESS)){
      link.href = catExplorer() + "/address/" + DEPLOYMENTS_ADDRESS;
      link.title = "EnclaveDeployments · " + DEPLOYMENTS_ADDRESS;
    } else link.hidden = true;
  }
  if (!Enclave.address && Enclave.accountAuthed()) mountAccountView();
  else {
    // wallet view (or signed out -> gate bounces): restore the ledger panel
    const d = $("#acctDeps"); if (d) d.remove();
    const cd = document.querySelector("c-deployments"); if (cd) cd.hidden = false;
  }
  gate();
}
