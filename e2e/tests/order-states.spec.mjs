// The two states a customer must be able to READ correctly: a payment held
// for a human (OFAC hit -> under review, never auto-provisioned) and an order
// that timed out unpaid (expired, no funds taken).
import { test, expect } from "@playwright/test";
import { seedStorage, injectWallet, stack } from "../fixtures/session.mjs";

test("an SDN-listed payer's order shows 'being checked', and never auto-provisions", async ({ page, context }) => {
  await seedStorage(context);
  await injectWallet(context, stack.sanctioned);   // anvil account 2, seeded into the OFAC cache

  await page.goto("/checkout");
  await page.click("#coSignin");                    // wallet detected -> direct SIWE
  await page.fill("#coApp", "ipfs://bafye2eofac");
  await page.fill("#coHours", "1");
  await page.click("#coUsdc");
  await page.waitForURL(/checkout\?order=ord_/);

  await expect(page.locator(".os-head")).toContainText("Being checked by a person", { timeout: 45_000 });
  await expect(page.locator(".os-body")).toContainText("manual check");
  // and it STAYS held (no auto-provision behind the reviewer's back)
  await page.waitForTimeout(4000);
  await expect(page.locator(".os-head")).toContainText("Being checked by a person");
});

test("an unpaid order expires with plain words and no funds taken", async ({ page, context }) => {
  await seedStorage(context);
  await injectWallet(context, stack.payer);

  await page.goto("/checkout");
  await page.click("#coSignin");                    // wallet detected -> direct SIWE
  await page.fill("#coApp", "ipfs://bafye2eexpire");
  await page.fill("#coHours", "1");
  // create the order via the card path but never pay: the stub redirect
  // parks us on the status page and the webhook never fires
  await page.click("#coCard");
  await page.waitForURL(/checkout\?order=ord_/);
  await expect(page.locator(".os-head")).toContainText("Waiting for payment");

  // ORDER_TTL_SEC=20 + ORDER_SWEEP_SEC=2 in the e2e relay: wait one TTL out
  await expect(page.locator(".os-head")).toContainText("Order expired", { timeout: 40_000 });
  await expect(page.locator(".os-body")).toContainText("No funds were taken");
});
