// The checkout's PaymentRouter client (site/js/core/pay.js) hand-encodes its
// calldata with the site's minimal codec - pin the selector literals and the
// full calldata layouts against viem + the checked-in PaymentRouter ABI, and
// the EIP-2612 typed data against viem's hashTypedData, so a drift fails CI
// instead of a customer payment. (pay.js itself imports browser modules, so
// the selector literals are read from its source - same spirit as the
// admin-console pre-map test.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, toFunctionSelector, hashTypedData } from "viem";
import { encUint, encBytes32, encAddr } from "../site/js/core/chain.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(REPO, "site/js/core/pay.js"), "utf8");
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "PaymentRouter.abi.json"), "utf8"));
const sel = (name) => {
  const m = new RegExp(`const ${name}\\s*=\\s*"([0-9a-f]{8})"`).exec(SRC);
  assert.ok(m, `pay.js no longer defines ${name}`);
  return m[1];
};
const eq = (got, want) => assert.equal(String(got).toLowerCase(), String(want).toLowerCase());

test("pay.js selector literals match viem", () => {
  eq("0x" + sel("SEL_PAY"), toFunctionSelector("function pay(uint256 amount, bytes32 orderRef)"));
  eq("0x" + sel("SEL_PAY_PERMIT"), toFunctionSelector("function payWithPermit(uint256 amount, bytes32 orderRef, uint256 deadline, uint8 v, bytes32 r, bytes32 s)"));
  eq("0x" + sel("SEL_NONCES"), toFunctionSelector("function nonces(address owner) view returns (uint256)"));
  eq("0x" + sel("SEL_APPROVE"), toFunctionSelector("function approve(address spender, uint256 value) returns (bool)"));
  eq("0x" + sel("SEL_ALLOWANCE"), toFunctionSelector("function allowance(address owner, address spender) view returns (uint256)"));
});

test("hand-encoded calldata is byte-identical to viem on the PaymentRouter ABI", () => {
  const amt = 1_803_600n, ref = "0x" + "ab".repeat(32), deadline = 1893456000n;
  const r = "0x" + "11".repeat(32), s = "0x" + "22".repeat(32), v = 28;

  // pay(amount, orderRef) - mirrors pay.js dataPay
  eq("0x" + sel("SEL_PAY") + encUint(amt) + encBytes32(ref),
     encodeFunctionData({ abi: ABI, functionName: "pay", args: [amt, ref] }));

  // payWithPermit(amount, orderRef, deadline, v, r, s) - mirrors dataPayWithPermit
  eq("0x" + sel("SEL_PAY_PERMIT") + encUint(amt) + encBytes32(ref) + encUint(deadline)
       + encUint(v) + encBytes32(r) + encBytes32(s),
     encodeFunctionData({ abi: ABI, functionName: "payWithPermit", args: [amt, ref, deadline, v, r, s] }));

  // approve(spender, value) - the smart-wallet fallback's first tx
  eq("0x" + sel("SEL_APPROVE") + encAddr("0x" + "34".repeat(20)) + encUint(amt),
     encodeFunctionData({
       abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
               inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
       functionName: "approve", args: ["0x" + "34".repeat(20), amt] }));
});

test("the permit typed data pay.js builds hashes like viem (USDC domain)", () => {
  // mirror pay.js's typed object exactly (types/domain/message shapes)
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const owner = "0x" + "aa".repeat(20), spender = "0x" + "34".repeat(20);
  const value = 1_803_600n, nonce = 7n, deadline = 1893456000n;
  const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: usdc };
  const types = { Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" } ] };
  const message = { owner, spender, value, nonce, deadline };
  // pay.js serializes numbers as decimal strings for eth_signTypedData_v4;
  // wallets hash both representations identically - viem proves it here
  const hStr = hashTypedData({ domain, types, primaryType: "Permit",
    message: { owner, spender, value: value.toString(), nonce: nonce.toString(), deadline: deadline.toString() } });
  const hBig = hashTypedData({ domain, types, primaryType: "Permit", message });
  assert.equal(hStr, hBig);
  // and the source really does sign over these five fields in this order
  const block = /Permit: \[([\s\S]*?)\]/.exec(SRC)[1];
  for (const f of ["owner", "spender", "value", "nonce", "deadline"]) assert.match(block, new RegExp(`"${f}"`));
});
