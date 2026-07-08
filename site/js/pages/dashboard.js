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
import { $, short, lsGet, on } from "../core/util.js";
import { DEPLOYMENTS_ADDRESS, BASE_CHAIN } from "../core/config.js";
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

export function boot() {
  // the ledger's chips, mirroring the store head: which contract, which chain
  const link = $("#depAddrLink"), sh = $("#depAddrShort"), ch = $("#depChain");
  if (ch) ch.textContent = "Base · " + BASE_CHAIN;
  if (link && sh){
    if (DEPLOYMENTS_ADDRESS && !/^0x0+$/i.test(DEPLOYMENTS_ADDRESS)){
      link.href = catExplorer() + "/address/" + DEPLOYMENTS_ADDRESS;
      sh.textContent = short(DEPLOYMENTS_ADDRESS);
    } else { link.removeAttribute("href"); sh.textContent = "not deployed"; }
  }
  gate();
}
