// Shared spec plumbing: the stack coordinates from global-setup, localStorage
// seeding (API base -> the local relay, RPC -> anvil, the accounts gate, and
// the address-book cache carrying the PaymentRouter so the USDC button shows),
// the injected EIP-6963 wallet, the CDP virtual authenticator, and the
// Stripe-Signature builder.
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

export const stack = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".stack.json"), "utf8"));

export async function seedStorage(context, page) {
  await context.addInitScript(({ relay, rpc, router, deployments }) => {
    localStorage.setItem("enclave_api_base", relay + "/v1");
    localStorage.setItem("enclave_rpc", rpc);
    localStorage.setItem("enclave_accounts", "1");                 // the dark-ship gate, forced on
    sessionStorage.setItem("enclave_addrbook", JSON.stringify({ paymentRouter: router, deployments }));
  }, { relay: stack.relay, rpc: stack.rpc, router: stack.router, deployments: stack.deployments });
  // headless Chromium wedges frame production on some navigations (stuck
  // cross-document view transition) and the site's soft-nav awaits the view
  // transition's callback - under reduced motion it applies the swap directly,
  // so navigation never waits on a frame that will not come. The config's
  // use.reducedMotion should do this, but does not reach matchMedia on this
  // Playwright build - emulateMedia verifiably does.
  if (page) await page.emulateMedia({ reducedMotion: "reduce" });
}

// EIP-6963 wallet whose provider proxies to anvil - ZERO crypto in the
// harness; anvil signs for its unlocked dev accounts. Strings are hexed for
// personal_sign; typed data is passed as an object (anvil rejects the JSON
// string form).
export async function injectWallet(context, address) {
  await context.addInitScript(({ rpc, address }) => {
    let id = 0;
    const call = async (method, params) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
      return j.result;
    };
    const toHex = (s) => "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
    const provider = {
      request: async ({ method, params }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts": return [address];
          case "eth_chainId": return "0x2105";
          case "wallet_switchEthereumChain": return null;
          case "personal_sign": {
            const [data, from] = params;
            return call("personal_sign", [/^0x[0-9a-fA-F]*$/.test(data) ? data : toHex(data), from]);
          }
          case "eth_signTypedData_v4": {
            const [from, typed] = params;
            return call("eth_signTypedData_v4", [from, typeof typed === "string" ? JSON.parse(typed) : typed]);
          }
          default: return call(method, params);
        }
      },
      on: () => {}, removeListener: () => {},
    };
    const detail = Object.freeze({ info: { uuid: "e2e-wallet", name: "E2E Wallet", rdns: "host.enclave.e2e", icon: null }, provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { rpc: stack.rpc, address });
}

export async function addVirtualAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
               hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

export const stripeSig = (payload) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", stack.whsec).update(`${t}.${payload}`).digest("hex")}`;
};

// settle a Stripe checkout the way Stripe would: a signed webhook event
export async function fireStripeWebhook(orderId) {
  const evt = JSON.stringify({ id: "evt_e2e_" + orderId, type: "checkout.session.completed",
    data: { object: { id: "cs_e2e_" + orderId, client_reference_id: orderId, payment_status: "paid" } } });
  const r = await fetch(stack.relay + "/v1/billing/stripe/webhook", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": stripeSig(evt) },
    body: evt,
  });
  if (!r.ok) throw new Error("webhook rejected: " + r.status + " " + (await r.text()));
}
