// The crypto journey: SIWE login, "Pay with USDC", the EIP-2612 permit
// single-transaction path (anvil signs the typed data), the indexer matches
// PaymentReceived, the provisioner takes it on-chain -> "All set" - with the
// full amount at the treasury and the router balance at zero. A second order
// exercises the approve+pay fallback by giving the payer's address code.
import { test, expect } from "@playwright/test";
import { createPublicClient, createTestClient, http, parseAbi } from "viem";
import { foundry } from "viem/chains";
import { seedStorage, injectWallet, stack } from "../fixtures/session.mjs";

const chain = { ...foundry, id: 8453 };
const pub = createPublicClient({ chain, transport: http(stack.rpc) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(stack.rpc) });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (who) => pub.readContract({ address: stack.usdc, abi: ERC20, functionName: "balanceOf", args: [who] });

async function loginAndOrder(page, appRef) {
  await page.goto("/checkout");
  await page.click("#coSignin");                               // wallet detected -> direct SIWE
  await expect(page.locator("#coUsdc")).toBeVisible();   // router in the seeded book -> USDC offered
  await page.fill("#coApp", appRef);
  await page.fill("#coHours", "1");
}

test("USDC: permit single-tx pays the treasury in full; router holds zero; order provisions", async ({ page, context }) => {
  await seedStorage(context);
  await injectWallet(context, stack.payer);
  const treasuryBefore = await bal(stack.treasury);

  await loginAndOrder(page, "ipfs://bafye2eusdcapp");
  await page.click("#coUsdc");
  await page.waitForURL(/checkout\?order=ord_/);
  const orderId = new URL(page.url()).searchParams.get("order");

  await expect(page.locator(".os-head")).toContainText("All set", { timeout: 45_000 });

  // invariants, on-chain: full quoted amount at the treasury, router at zero
  const order = await page.evaluate(async (id) => {
    const r = await fetch(localStorage.getItem("enclave_api_base") + "/billing/orders/" + id,
      { headers: { Authorization: "Bearer " + JSON.parse(localStorage.getItem("enclave_account")).token } });
    return r.json();
  }, orderId);
  expect(order.state).toBe("complete");
  expect(order.usdc.total6).toBe(order.amount6);
  expect(await bal(stack.router)).toBe(0n);
  expect((await bal(stack.treasury)) - treasuryBefore >= BigInt(order.amount6)).toBe(true);   // >=: the provisioner's fund() also lands here
});

test("USDC: a code-bearing payer routes through approve+pay and still completes", async ({ page, context }) => {
  await seedStorage(context);
  await injectWallet(context, stack.payer);
  // give the payer's ADDRESS code: pay.js's payerHasCode() must route the
  // allowance pair (permit signatures from code-bearing addresses die in
  // ERC-1271). A one-byte stub is enough - anvil still lets the unlocked
  // account send transactions.
  await testClient.setCode({ address: stack.payer, bytecode: "0xef0100" + "11".repeat(20) });
  try {
    await loginAndOrder(page, "ipfs://bafye2efallback");
    await page.click("#coUsdc");
    await page.waitForURL(/checkout\?order=ord_/);
    await expect(page.locator(".os-head")).toContainText("All set", { timeout: 45_000 });
    expect(await bal(stack.router)).toBe(0n);
  } finally {
    await testClient.setCode({ address: stack.payer, bytecode: "0x" });
  }
});
