// Unhappy paths in plain words: an unpaid top-up expires and says so.
// (The OFAC/USDC order paths retired with the crypto checkout; the indexer
// still routes stray router payments to the review queue - relay unit tests
// cover that surface.)
import { test, expect } from "@playwright/test";
import { seedStorage, addVirtualAuthenticator } from "../fixtures/session.mjs";

test("an unpaid top-up expires with plain words and no funds taken", async ({ page, context }) => {
  await seedStorage(context, page);
  await addVirtualAuthenticator(context, page);

  await page.goto("/checkout");
  await page.click("#coSignin");
  await page.click("#authPasskey");
  await expect(page.locator("#coBal")).toContainText("$0.00");

  // start a top-up but never pay: the stub Stripe URL is never followed
  const orderId = await page.evaluate(async () => {
    const r = await fetch(localStorage.getItem("enclave_api_base") + "/billing/topup", {
      method: "POST",
      headers: { "content-type": "application/json",
        Authorization: "Bearer " + JSON.parse(localStorage.getItem("enclave_account")).token },
      body: JSON.stringify({ amountUsd: 25 }),
    });
    return (await r.json()).order.id;
  });

  // ORDER_TTL_SEC=20 in the e2e env: the sweep expires it
  await page.goto("/checkout?order=" + orderId);
  await expect(page.locator(".os-head")).toContainText("Order expired", { timeout: 40_000 });
  await expect(page.locator(".os-body")).toContainText("No funds were taken");
});
