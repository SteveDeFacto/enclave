// PaymentRouter is the one contract that must have NO admin surface: no
// owner, no setter, no pause, no rescue, no upgrade hook. These tests pin
// that property on the compiled ABI (an executable version of the review
// checklist), plus the event topic the relay indexer filters on and the
// calldata shapes the checkout client sends.
//
//   run: node --test test/payment-router.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, toEventSelector, toFunctionSelector } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { CONTRACTS } = await import(path.join(REPO, "site/js/gen/contract-artifacts.js"));
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "PaymentRouter.abi.json"), "utf8"));

const eq = (got, want) => assert.equal(String(got).toLowerCase(), String(want).toLowerCase());

test("router ABI is exactly the payment surface - no owner, no admin", () => {
  const fns = ABI.filter((f) => f.type === "function").map((f) => f.name).sort();
  assert.deepEqual(fns, ["pay", "payWithPermit", "treasury", "usdc"]);

  // nothing state-changing besides the two pay entrypoints
  const writes = ABI.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability));
  assert.deepEqual(writes.map((f) => f.name).sort(), ["pay", "payWithPermit"]);

  // no payable surface at all (USDC only, no ETH) and no receive/fallback
  assert.equal(ABI.some((f) => f.stateMutability === "payable"), false);
  assert.equal(ABI.some((f) => f.type === "receive" || f.type === "fallback"), false);

  // the deploy burns both immutables; constructor is (usdc, treasury)
  const ctor = ABI.find((f) => f.type === "constructor");
  assert.deepEqual(ctor.inputs.map((i) => i.type), ["address", "address"]);
});

test("PaymentReceived topic + artifact selectors match viem", () => {
  const evt = ABI.find((e) => e.type === "event" && e.name === "PaymentReceived");
  assert.ok(evt, "PaymentReceived missing from ABI");
  // indexed: orderRef (subject-first) + payer; amount in data
  assert.deepEqual(evt.inputs.map((i) => [i.name, i.type, !!i.indexed]),
    [["orderRef", "bytes32", true], ["payer", "address", true], ["amount", "uint256", false]]);
  eq(CONTRACTS.PaymentRouter.evt.PaymentReceived, toEventSelector(evt));
  for (const f of ABI.filter((x) => x.type === "function"))
    eq("0x" + CONTRACTS.PaymentRouter.sel[f.name], toFunctionSelector(f));
  assert.equal(CONTRACTS.PaymentRouter.bookKey, "paymentRouter");
});

test("pay / payWithPermit calldata shapes (what the checkout client sends)", () => {
  const ref = "0x" + "ab".repeat(32);
  const pay = encodeFunctionData({ abi: ABI, functionName: "pay", args: [25_000_000n, ref] });
  assert.equal(pay.slice(2, 10), CONTRACTS.PaymentRouter.sel.pay);
  assert.equal(pay.length, 2 + 8 + 64 * 2);

  const permit = encodeFunctionData({
    abi: ABI, functionName: "payWithPermit",
    args: [25_000_000n, ref, 1893456000n, 27, "0x" + "11".repeat(32), "0x" + "22".repeat(32)],
  });
  assert.equal(permit.slice(2, 10), CONTRACTS.PaymentRouter.sel.payWithPermit);
  assert.equal(permit.length, 2 + 8 + 64 * 6);
});
