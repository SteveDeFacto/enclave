// The credit era, end to end: a passkey user adds credit by card (Stripe stub
// + signed webhook), the relay deposits into their on-chain vault (created on
// first use), and ONE passkey tap signs a vault op that creates + funds a
// deployment the vault owns. The dashboard shows the balance and the row in
// the SAME <c-deployments> panel wallet users get; its Top up control funds
// more runtime from credit (passkey-signed). The virtual authenticator answers
// every WebAuthn ceremony; the P-256 verifier at 0x100 checks them on anvil
// exactly as Base's native precompile does in prod.
import { test, expect } from "@playwright/test";
import { seedStorage, addVirtualAuthenticator, fireStripeWebhook } from "../fixtures/session.mjs";

test("credit: card top-up lands on-chain; one passkey tap deploys from it; dashboard extends it", async ({ page, context }) => {
  await seedStorage(context, page);
  await addVirtualAuthenticator(context, page);

  // sign up (passkey chain) straight from the checkout gate
  await page.goto("/checkout");
  await page.click("#coSignin");
  await page.click("#authPasskey");
  await expect(page.locator("#coBal")).toContainText("$0.00");

  // $25 by card: stub Stripe bounces back, the signed webhook settles it
  await page.fill("#coAmt", "25");
  await page.click("#coCard");
  await page.waitForURL(/checkout\?order=/);
  const orderId = new URL(page.url()).searchParams.get("order");
  await fireStripeWebhook(orderId);
  await expect(page.locator(".os-head")).toContainText("Credit added", { timeout: 30_000 });

  await page.goto("/checkout");
  await expect(page.locator("#coBal")).toContainText("$25.00");

  // one tap = one signed vault op: create + fund, owned by the vault. Driven
  // through deployOnChain - the SHARED entry every deploy surface calls (the
  // console form AND the store's quick-deploy modal) - so this pins the branch
  // that routes signed-in accounts to the passkey path instead of a wallet
  // (the wallet path would die here: no provider is injected). It soft-
  // navigates to the dashboard and narrates into the run log.
  await page.evaluate(async () => {
    const m = await import("/js/pages/deploy.js");
    await m.deployOnChain({
      reference: "ipfs://bafyvaultapp", gpuMilli: 250, cpuMilli: 100,
      ports: "", isPublic: true, fundUsd: 5,
    });
  });
  // the run strip lands on the dashboard and narrates the passkey deploy
  await expect(page.locator("c-deployments .enc-live")).toContainText("created + funded", { timeout: 20_000 });
  await expect(page.locator("#acctBalV")).toContainText("$20.00");
  const row = page.locator("c-deployments .enc-row", { hasText: "bafyvaultapp" });
  // relay ledger cache (10s TTL) + the panel's 10s poll: allow a full cycle.
  // "queued": funded on-chain, no live enclave claims in e2e
  await expect(row).toContainText("queued", { timeout: 30_000 });

  // dispatchEvent, not click(): headless Chromium freezes frame production on
  // this page (stuck cross-document view transition), so Playwright's
  // rAF-based stability gate never settles - the buttons are visible,
  // uncovered, and fine in real browsers (elementFromPoint probed = self).
  // fill() skips the stability gate, so it works as-is.
  await row.locator(".enc-fundbtn").dispatchEvent("click");
  await row.locator(".ef-amt").fill("3");
  await row.locator(".ef-go").dispatchEvent("click");
  await expect(page.locator("#acctBalV")).toContainText("$17.00", { timeout: 20_000 });
});

test("credit: a spend beyond the balance is refused with a plain message", async ({ page, context }) => {
  await seedStorage(context, page);
  await addVirtualAuthenticator(context, page);
  await page.goto("/checkout");
  await page.click("#coSignin");
  await page.click("#authPasskey");
  await expect(page.locator("#coBal")).toContainText("$0.00");   // session settled

  const msg = await page.evaluate(async () => {
    const { vaultOp } = await import("/js/core/vault.js");
    try {
      await vaultOp("deploy", { spec: { appRef: "ipfs://bafybroke", gpuShare: 0.25, cpuShare: 0.1, appPort: 8080, isPublic: true }, fundUsd: 500 });
      return "no error";
    } catch (e) { return e.message; }
  });
  expect(msg).toMatch(/credit/i);
  expect(msg).toMatch(/Add credit/i);
});
