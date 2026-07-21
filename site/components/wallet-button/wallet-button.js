/* ============================================================
   <c-wallet-button> - the wallet control: sign-in button,
   account popover, and the fullscreen wallet chooser it portals
   to <body> (the header's backdrop-filter would otherwise become
   the containing block for the fixed overlay, pinning it to the
   bar - see the git history for that bug).

   Owns the wallet lifecycle for whichever page mounts it: boots
   EIP-6963 discovery, silently restores the previous session,
   and repaints on every wallet/session change (wallet.js emits
   `enclave:wallet`; the button itself is repainted by refreshWallet).
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { Enclave } from "../../js/core/api.js";
import { Wallet, connectWallet, refreshWallet, restoreSession, toggleWalletPop } from "../../js/core/wallet.js";
import { restoreAccountSession, openAuthModal } from "../../js/core/account.js";
import { ACCOUNTS_ENABLED } from "../../js/core/config.js";
import { navigate } from "../../js/boot.js";
import { $, showToast } from "../../js/core/util.js";

class WalletButton extends EnclaveElement {
  static templateUrl = new URL("./wallet-button.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;

    // fullscreen wallet chooser, portaled OUTSIDE the blurred header
    if (!$("#walletPick")) {
      const pick = document.createElement("div");
      pick.className = "wallet-pick"; pick.id = "walletPick"; pick.hidden = true;
      document.body.appendChild(pick);
    }

    const wb = this.querySelector("#walletBtn");
    wb.addEventListener("click", async () => {
      if (Enclave.address || Enclave.accountAuthed()){ toggleWalletPop(); return; }
      if (ACCOUNTS_ENABLED){
        // account sign-in chooser: passkey primary, wallet secondary
        try { await openAuthModal(); navigate("dashboard", { push: true }); }
        catch(e){ /* cancelled or already toasted by the modal */ }
        return;
      }
      const o = wb.innerHTML; wb.disabled = true; wb.innerHTML = "connecting…";
      try {
        await connectWallet();   // connecting IS signing in (SIWE stays lazy, at the private reads)
        navigate("dashboard", { push: true });   // land where their apps live
      }
      catch(e){ showToast(e.message); }
      finally { wb.disabled = false; if (!Enclave.address) wb.innerHTML = o; }
    });

    // pointerDOWN, not click: selecting text in the popover and releasing
    // outside must not dismiss it (the click would land on the ancestor)
    const dismiss = (refocus) => {
      const pop = this.querySelector("#walletPop"); if (!pop || pop.hidden) return false;
      pop.hidden = true; pop.innerHTML = "";
      wb.setAttribute("aria-expanded", "false");
      if (refocus) wb.focus();
      return true;
    };
    document.addEventListener("pointerdown", (e) => {
      if (e.target.closest("#walletPop") || e.target.closest("#walletBtn")) return;
      dismiss(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dismiss(true);
    });

    Wallet.init();
    refreshWallet();
    restoreSession();          // silently restore a prior wallet + sign-in across refreshes
    restoreAccountSession();   // and the relay account session (separate trust domain)
  }
}
register("c-wallet-button", WalletButton);
