/* ============================================================
   Dashboard page — the signed-in view: <c-deployments> (the My
   Apps panel) with a live-deploy strip and a per-row Output
   panel (deploy narrative + app logs). The component is
   self-wiring; the page module only makes sure it's registered
   before the markup upgrades.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/deployments/deployments.js";

export function boot() {}
