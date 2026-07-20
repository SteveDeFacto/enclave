/* ============================================================
   PaymentRouter client - pays a USD order in USDC on Base from
   the user's own wallet, straight through the immutable router
   to the treasury (the router holds nothing, ever).

   Two paths, mirroring fund.js's routing:
     - bare EOA: EIP-2612 permit signature + ONE transaction
       (payWithPermit pulls the USDC and forwards it)
     - code-bearing payer (Safe, EIP-7702 delegation): USDC's
       signature checker rejects raw digests via ERC-1271, so
       approve(router) then pay() - two plain transactions
   Every coordinate (token, router, amount, orderRef, EIP-712
   domain) comes off the ORDER response (GET /billing/orders/:id
   /usdc), never from baked constants - so a testnet or local
   anvil order pays exactly the same way.

   Selectors are literals, verified against the PaymentRouter /
   ERC-20 ABIs in test/pay.test.mjs (the chain.js convention:
   hand-computed selectors have burned us before).
   ============================================================ */
import { Enclave, EnclaveError } from "./api.js";
import { encUint, encAddr, encBytes32, baseRpc, waitReceipt, hexBig } from "./chain.js";
import { ensureBaseChain, sendTx } from "./wallet.js";
import { payerHasCode } from "./fund.js";

const SEL_PAY        = "8e6bee97";  // pay(uint256,bytes32)
const SEL_PAY_PERMIT = "f5e3d011";  // payWithPermit(uint256,bytes32,uint256,uint8,bytes32,bytes32)
const SEL_NONCES     = "7ecebe00";  // nonces(address) on the token (EIP-2612)
const SEL_APPROVE    = "095ea7b3";  // approve(address,uint256)
const SEL_ALLOWANCE  = "dd62ed3e";  // allowance(address,address)

const dataPay = (amt6, ref) => "0x" + SEL_PAY + encUint(amt6) + encBytes32(ref);
const dataPayWithPermit = (amt6, ref, deadline, v, r, s) =>
  "0x" + SEL_PAY_PERMIT + encUint(amt6) + encBytes32(ref) + encUint(deadline)
       + encUint(v) + encBytes32(r) + encBytes32(s);

async function tokenNonce(usdc, owner){
  const call = { to: usdc, data: "0x" + SEL_NONCES + encAddr(owner) };
  try {
    const hex = await Enclave.provider.request({ method: "eth_call", params: [call, "latest"] });
    if (hex && hex !== "0x") return hexBig(hex);
  } catch(_){}
  return hexBig(await baseRpc("eth_call", [call, "latest"]));
}
async function routerAllowance(usdc, owner, router){
  const call = { to: usdc, data: "0x" + SEL_ALLOWANCE + encAddr(owner) + encAddr(router) };
  try {
    const hex = await Enclave.provider.request({ method: "eth_call", params: [call, "latest"] });
    if (hex && hex !== "0x") return hexBig(hex);
  } catch(_){}
  try { return hexBig(await baseRpc("eth_call", [call, "latest"])); } catch(_){ return 0n; }
}

/* Pay the order's exact quoted amount. `pay` = the GET /usdc instructions
   object; `log` (optional) narrates progress: log(cls, text). Resolves with
   { txHash } once the pay transaction is confirmed - the caller then polls
   the order until the relay's indexer sees it at depth. */
export async function payOrderWithUsdc(pay, log){
  const say = log || (() => {});
  if (!Enclave.provider || !Enclave.address) throw new EnclaveError("Connect a wallet to pay with USDC.", 0);
  await ensureBaseChain();
  const amt6 = BigInt(pay.amount6);
  const ref = pay.orderRef;
  const router = pay.router, usdc = pay.usdc;
  if (!/^0x[0-9a-fA-F]{40}$/.test(router)) throw new EnclaveError("No PaymentRouter on this deployment yet.", 0);

  if (await payerHasCode()){
    // smart-wallet path: allowance pair (2612 signatures would be routed to
    // ERC-1271 and rejected - same story as fund.js's 3009 fallback)
    if (await routerAllowance(usdc, Enclave.address, router) < amt6){
      say("pend", "Approve the USDC spend in your wallet (1 of 2)…");
      const txA = await sendTx(usdc, "0x" + SEL_APPROVE + encAddr(router) + encUint(amt6));
      say("pend", "Approval sent · waiting for confirmation…");
      await waitReceipt(txA);
    }
    say("pend", "Confirm the payment in your wallet (2 of 2)…");
    const txHash = await sendTx(router, dataPay(amt6, ref));
    say("pend", "Payment sent · waiting for confirmation…");
    await waitReceipt(txHash);
    return { txHash };
  }

  // bare EOA: one permit signature + one transaction
  const nonce = await tokenNonce(usdc, Enclave.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const dom = pay.usdcDomain || {};
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" },
        { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: { name: dom.name || "USD Coin", version: dom.version || "2",
              chainId: dom.chainId || pay.chainId, verifyingContract: usdc },
    message: { owner: Enclave.address, spender: router,
               value: amt6.toString(), nonce: nonce.toString(), deadline: deadline.toString() },
  };
  say("pend", "Sign the USDC permit in your wallet (free - it authorizes this one payment)…");
  let sig;
  try {
    sig = await Enclave.provider.request({ method: "eth_signTypedData_v4",
      params: [Enclave.address, JSON.stringify(typed)] });
  } catch(e){
    throw new EnclaveError((e && e.code === 4001) ? "Signature rejected." : ("Could not sign the permit: " + (e.message || e)), 0);
  }
  const raw = sig.replace(/^0x/, "");
  if (raw.length !== 130) throw new EnclaveError("Wallet returned an unexpected signature shape.", 0);
  const r = "0x" + raw.slice(0, 64), s = "0x" + raw.slice(64, 128);
  let v = parseInt(raw.slice(128, 130), 16);
  if (v < 27) v += 27;   // some wallets answer v as 0/1
  say("pend", "Confirm the payment in your wallet…");
  const txHash = await sendTx(router, dataPayWithPermit(amt6, ref, deadline, v, r, s));
  say("pend", "Payment sent · waiting for confirmation…");
  await waitReceipt(txHash);
  return { txHash };
}
