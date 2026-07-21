// The card journey, zero crypto exposure end to end: passkey signup ->
// order -> "Pay by card" -> hosted-checkout redirect (stub bounces straight
// back) -> signed Stripe webhook settles it -> the provisioner's company
// wallet create()+fund()s the deployment on anvil -> "All set".
import { test, expect } from "@playwright/test";
import { seedStorage, addVirtualAuthenticator, fireStripeWebhook, stack } from "../fixtures/session.mjs";

test("card: passkey signup -> Stripe checkout -> webhook -> provisioned on-chain", async ({ page, context }) => {
  await seedStorage(context);
  await addVirtualAuthenticator(context, page);

  // sign up with a passkey ON the checkout page (the sign-in gate)
  await page.goto("/checkout");
  await page.click("#coSignin");
  await page.click("#authPasskey");
  await expect(page.locator("#coCard")).toBeVisible();

  // configure the order: an app ref + one hour
  await page.fill("#coApp", "ipfs://bafye2ecardapp");
  await page.fill("#coHours", "1");
  await expect(page.locator("#coQuote")).toContainText("$");   // live quote from the anvil ledger rates

  // Pay by card -> stub Stripe bounces to /checkout?order=<id>
  await page.click("#coCard");
  await page.waitForURL(/checkout\?order=ord_/);
  const orderId = new URL(page.url()).searchParams.get("order");
  await expect(page.locator(".os-head")).toContainText("Waiting for payment");

  // Stripe's webhook settles the order; the provisioner takes it on-chain
  await fireStripeWebhook(orderId);
  await expect(page.locator(".os-head")).toContainText("All set", { timeout: 45_000 });
  await expect(page.locator(".os-meta")).toContainText("Deployment");

  // the deployment is REAL: the account-scoped join shows it against the ledger
  const deps = await page.evaluate(async () => {
    const r = await fetch(localStorage.getItem("enclave_api_base") + "/billing/deployments",
      { headers: { Authorization: "Bearer " + JSON.parse(localStorage.getItem("enclave_account")).token } });
    return r.json();
  });
  expect(deps.deployments.length).toBe(1);
  expect(deps.deployments[0].orderId).toBe(orderId);
  expect(deps.deployments[0].deploymentId).toMatch(/^0x[0-9a-f]{64}$/);
});
