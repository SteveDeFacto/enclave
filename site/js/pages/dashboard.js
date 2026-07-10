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
import { $, lsGet, on } from "../core/util.js";
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
  if (Enclave.address) return;
  let stored = null;
  try { stored = JSON.parse(lsGet("enclave_session") || "null"); } catch(e){}
  if (!stored || !stored.address) navigate("./");
}
on("enclave:wallet", gate);   // module-load-once: restore-settle and sign-out edges

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
    if (document.querySelector('section[data-view="dashboard"]')) refreshFleet();
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
  gate();
}
