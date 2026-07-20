/* ============================================================
   Funding - minimal ABI encoding for EnclavePay payWithAuthorization
   + payEth and the EnclaveDeployments funding pair (no web3 lib).
   payForRuntime() pays for OR tops up a deployment; the deploy flow
   (js/pages/deploy.js) and the dashboard's per-row Top up both use it.
   ============================================================ */
import { Enclave, EnclaveError } from "./api.js";
import { BASE_CHAIN } from "./config.js";
import { encUint, encAddr, encBytes32, encBytesTail, randHex, usdc6, DEP_SEL, baseRpc, waitReceipt } from "./chain.js";
import { ensureBaseChain, sendTx } from "./wallet.js";
import { runlog } from "./runlog.js";

const SEL_PAY_AUTH = "7d368d83";  // payWithAuthorization(bytes32,address,uint256,uint256,uint256,bytes32,bytes); verified vs viem
const SEL_PAYETH   = "00bd4dee";  // payEth(bytes32) payable; verified vs viem
// payWithAuthorization: 7 head words; `signature` is dynamic, so its head slot
// holds the tail offset (7*32) and the bytes follow as length + padded data.
const dataPayWithAuth = (ref, from, amt6, validAfter, validBefore, nonce, sig) =>
  "0x" + SEL_PAY_AUTH + encBytes32(ref) + encAddr(from) + encUint(amt6)
       + encUint(validAfter) + encUint(validBefore) + encBytes32(nonce)
       + encUint(7 * 32) + encBytesTail(sig);
const dataPayEth = (ref) => "0x" + SEL_PAYETH + encBytes32(ref);
// EnclaveDeployments funding: byte-identical parameter shape to EnclavePay's pair, but
// the credit lands in the deployment's ON-CHAIN balance6 (funds still forward
// to the payout in the same tx - nothing is custodied by the contract).
const dataFundWithAuth = (ref, from, amt6, validAfter, validBefore, nonce, sig) =>
  "0x" + DEP_SEL.fundAuth + encBytes32(ref) + encAddr(from) + encUint(amt6)
       + encUint(validAfter) + encUint(validBefore) + encBytes32(nonce)
       + encUint(7 * 32) + encBytesTail(sig);
const dataFundEth = (ref) => "0x" + DEP_SEL.fundEth + encBytes32(ref);
// The allowance pair (approve on the token, then EnclaveDeployments.fund):
// two plain msg.sender-authorized txs, nothing for USDC's signature checker
// to reinterpret - the funding path for payers whose ADDRESS CARRIES CODE.
const SEL_APPROVE = "095ea7b3";  // ERC-20 approve(address,uint256); verified vs viem in test/admin-console.test.mjs
const dataApprove = (spender, amt6) => "0x" + SEL_APPROVE + encAddr(spender) + encUint(amt6);
const dataFund = (ref, amt6) => "0x" + DEP_SEL.fund + encBytes32(ref) + encUint(amt6);

/* USDC only ecrecovers EIP-3009/EIP-2612 signatures from CODE-FREE addresses;
   a payer with code (a Safe or other smart-contract wallet, or an EOA
   carrying an EIP-7702 delegation) is routed to ERC-1271, which account
   implementations reject for raw digests ("FiatTokenV2: invalid signature",
   surfacing as a gas-estimation failure before anything is sent). Those
   payers must fund via the allowance pair. Unknown (all RPCs down) = assume
   bare EOA: the signature path was the status quo, and the estimate-and-send
   path will name the problem if we guessed wrong.
   (Exported: pay.js routes the PaymentRouter permit path the same way.) */
export async function payerHasCode(){
  const params = [Enclave.address, "latest"];
  try {
    const code = await Enclave.provider.request({ method: "eth_getCode", params });
    if (code != null) return code !== "0x";
  } catch(_){}
  try { return (await baseRpc("eth_getCode", params)) !== "0x"; }
  catch(_){ return false; }
}
// USD -> wei at the enclave's quoted ETH/USD rate (an ESTIMATE for the tx amount;
// the enclave credits the actual wei at its own live Chainlink read on arrival)
function usdToWei(usd, ethUsd){
  const price = parseFloat(ethUsd);
  if (!(price > 0)) throw new EnclaveError("No live ETH/USD rate from the enclave; pay in USDC, or retry shortly.", 0);
  return BigInt(Math.round((usd / price) * 1e9)) * 1000000000n;   // 9dp of ETH precision
}

/* pay for (or top up) a deployment.
   USDC: sign an EIP-3009 ReceiveWithAuthorization (EIP-712, a gas-free wallet
         signature), then ONE payWithAuthorization tx; no approve, no
         allowance left behind. EXCEPT when the payer's address carries code
         (see payerHasCode): then approve + fund(), two plain transactions.
   ETH:  payEth(ref) with msg.value: ONE transaction; the enclave credits the wei
         as USDC-equivalent at its live Chainlink ETH/USD read when the event lands.
   `log(cls, txt)` narrates progress - defaults to the run log (the deploy
   flow); the dashboard's Top up passes its own inline sink. */
export async function payForRuntime(pay, fundUsdc, asset, log){
  log = log || runlog.line;
  // Two receivers, one shape: the EnclavePay forwarder (legacy container flavor,
  // off-chain clock) or the EnclaveDeployments ledger (pay.contract - the credit
  // lands in the deployment's on-chain balance6, so ANY enclave can serve it).
  const ledger = !(pay && pay.forwarder);
  const to = pay && (pay.forwarder || pay.contract);
  if (!to) throw new EnclaveError("No payment instructions (neither a forwarder nor the deployments contract was returned).", 0);
  // The EnclaveFeatured campaign escrow shares the deployments pair's exact
  // calldata shape, so it funds through here too - with its own narration
  // (escrowed, withdrawable) instead of the deployment copy (forwarded).
  const buys = (pay && pay.buys) || "buys runtime";
  const creditLine = (pay && pay.creditLine) || null;
  await ensureBaseChain();
  const amt6 = usdc6(fundUsdc);                       // cent-rounded 6dp USDC
  if (amt6 <= 0n) throw new EnclaveError("Fund at least $0.01 (USDC).", 0);
  const usd = (Number(amt6) / 1e6).toFixed(2);        // e.g. "10.00", what actually gets signed/paid
  if (asset === "ETH"){
    if (!ledger && !pay.payEthMethod) throw new EnclaveError("This enclave doesn't accept ETH yet (older release); pay in USDC.", 0);
    if (!pay.ethUsd) throw new EnclaveError("No ETH/USD quote available right now; fund in USDC instead.", 0);
    const wei = usdToWei(Number(amt6) / 1e6, pay.ethUsd);
    const eth = (Number(wei) / 1e18).toFixed(6);
    log("info", "[*] " + (ledger ? "fundEth" : "payEth") + " ≈ " + eth + " ETH (≈ $" + usd + " @ $" + pay.ethUsd + "/ETH)… (wallet · one tx)");
    const ph = await sendTx(to, (ledger ? dataFundEth : dataPayEth)(pay.deploymentRef), "0x" + wei.toString(16));
    log("ok", "[✓] payment sent " + ph);
    log("dimln", ledger
      ? "    credited to the deployment's on-chain balance at the contract's live Chainlink rate; funds forward in the same tx (a paid app's publisher cut goes straight to their wallet)"
      : "    ETH goes straight to Enclave; the enclave credits it at the live Chainlink rate");
    return ph;
  }
  // Code-bearing payers can't 3009 (see payerHasCode); fund from an allowance
  // instead. Ledger only: the legacy EnclavePay forwarder has no fund(). The
  // exact-amount approve leaves nothing dangling on success, and a leftover
  // allowance from a fund() that never landed is spendable only by this same
  // payer calling fund() - it can't move money anywhere but payout.
  if (ledger && await payerHasCode()){
    log("info", "[*] this wallet is a smart account (code at its address), so a signed USDC authorization can't verify - funding via allowance instead");
    log("info", "[*] approve " + usd + " USDC… (wallet · tx 1 of 2)");
    const ah = await sendTx(pay.usdc, dataApprove(to, amt6));
    log("dimln", "  ↳ sent " + ah + " · waiting for confirmation…");
    await waitReceipt(ah);   // fund()'s transferFrom pulls the allowance, so it must be mined first
    log("info", "[*] fund " + usd + " USDC · " + buys + "… (wallet · tx 2 of 2)");
    const ph = await sendTx(to, dataFund(pay.deploymentRef, amt6));
    log("ok", "[✓] payment sent " + ph);
    log("dimln", creditLine || "    credited to the deployment's on-chain balance; funds forward to Enclave - nothing is custodied");
    return ph;
  }
  // EIP-3009: the nonce must start with the deployment ref's first 16 bytes (the
  // receiving contract enforces this, binding the signature to THIS deployment);
  // the other 16 are random so repeat top-ups from the same wallet never collide.
  const nonce = "0x" + encBytes32(pay.deploymentRef).slice(0, 32) + randHex(16);
  const validBefore = Math.floor(Date.now() / 1000) + 3600;   // 1h to get the tx mined
  // sign against the TOKEN's own EIP-712 domain (enclave reads it from the chain;
  // fall back to Base-mainnet USDC's well-known fields if it hasn't yet)
  const dom = pay.usdcDomain || { name: "USD Coin", version: "2", chainId: BASE_CHAIN, verifyingContract: pay.usdc };
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
    },
    domain: { name: dom.name, version: dom.version, chainId: Number(dom.chainId), verifyingContract: dom.verifyingContract },
    primaryType: "ReceiveWithAuthorization",
    message: { from: Enclave.address, to: to, value: amt6.toString(),
               validAfter: "0", validBefore: String(validBefore), nonce: nonce },
  };
  log("info", "[*] sign a " + usd + " USDC payment authorization (EIP-3009)… (wallet · gas-free signature)");
  let sig = await Enclave.provider.request({ method: "eth_signTypedData_v4", params: [Enclave.address, JSON.stringify(typed)] });
  // some wallets return v as 0/1; USDC's ecrecover wants 27/28 (65-byte ECDSA
  // sigs only; longer EIP-1271 smart-wallet blobs pass through untouched)
  if (sig.replace(/^0x/, "").length === 130) {
    const v = parseInt(sig.slice(-2), 16);
    if (v === 0 || v === 1) sig = sig.slice(0, -2) + (v + 27).toString(16);
  }
  log("info", "[*] pay " + usd + " USDC · " + buys + "… (wallet · one tx, no approve)");
  const ph = await sendTx(to, (ledger ? dataFundWithAuth : dataPayWithAuth)(pay.deploymentRef, Enclave.address, amt6, 0, validBefore, nonce, sig));
  log("ok", "[✓] payment sent " + ph);
  log("dimln", creditLine || (ledger
    ? "    credited to the deployment's on-chain balance; funds forward in the same tx (a paid app's publisher cut goes straight to their wallet) - nothing is custodied"
    : "    funds go straight to Enclave; nothing is custodied"));
  return ph;
}
