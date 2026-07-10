/* ============================================================
   Overview page - composition of self-hydrating components; the
   one page-specific wire is the pricing section's provenance
   chips (which contract the rates live on), the same grammar as
   the store head on Apps and the Dashboard.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/enclave-panel/enclave-panel.js";
import "../../components/ticker/ticker.js";
import "../../components/flow/flow.js";
import "../../components/attest-chain/attest-chain.js";
import "../../components/live-verify/live-verify.js";
import { $, short } from "../core/util.js";
import { DEPLOYMENTS_ADDRESS, BASE_CHAIN } from "../core/config.js";
import { catExplorer } from "../core/chain.js";

export function boot() {
  // the pricing chips: the EnclaveDeployments contract the rates are read
  // from (and enforced by) - address resolved via the on-chain address book
  const link = $("#priceAddrLink"), sh = $("#priceAddrShort"), ch = $("#priceChain");
  if (ch) ch.textContent = "Base · " + BASE_CHAIN;
  if (link && sh){
    if (DEPLOYMENTS_ADDRESS && !/^0x0+$/i.test(DEPLOYMENTS_ADDRESS)){
      link.href = catExplorer() + "/address/" + DEPLOYMENTS_ADDRESS;
      sh.textContent = "EnclaveDeployments · " + short(DEPLOYMENTS_ADDRESS);
    } else { link.removeAttribute("href"); sh.textContent = "not deployed"; }
  }
}
