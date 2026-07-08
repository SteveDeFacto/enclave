/* ============================================================
   Overview page - pure composition: every dynamic piece is a
   component that hydrates itself whenever it (re)connects, so
   boot() has nothing page-specific to wire.
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

export function boot() {}   // components self-hydrate on connect
