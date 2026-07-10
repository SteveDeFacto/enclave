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
import { $ } from "../core/util.js";
import { DEPLOYMENTS_ADDRESS } from "../core/config.js";
import { catExplorer } from "../core/chain.js";

export function boot() {
  // the pricing section's provenance mark: one icon straight to the contract
  // on Basescan (Steven's call - no chip text, no chain/short-address noise);
  // the full name + address live in the tooltip
  const link = $("#priceAddrLink");
  if (link){
    if (DEPLOYMENTS_ADDRESS && !/^0x0+$/i.test(DEPLOYMENTS_ADDRESS)){
      link.href = catExplorer() + "/address/" + DEPLOYMENTS_ADDRESS;
      link.title = "EnclaveDeployments · " + DEPLOYMENTS_ADDRESS;
    } else link.hidden = true;
  }
}
