// Passkey signup + sign-in via the CDP virtual authenticator: create an
// account with one tap, session restores across a reload, sign-out clears it,
// and the SAME resident credential signs back in (discoverable, username-less).
import { test, expect } from "@playwright/test";
import { seedStorage, addVirtualAuthenticator } from "../fixtures/session.mjs";

test("passkey: create account, restore across reload, sign out, sign back in", async ({ page, context }) => {
  await seedStorage(context, page);
  await addVirtualAuthenticator(context, page);

  await page.goto("/index.html");
  await page.click("#walletBtn");
  await expect(page.locator("#walletPick .wp-h")).toHaveText("Sign in to Enclave");
  await page.click("#authPasskey");                            // one button: sign-in chains into register for first-timers
  await expect(page.locator("#walletBtn")).toContainText("Signed in");
  const sess = await page.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")));
  expect(sess.accountId).toMatch(/^acct_/);
  expect(sess.method).toBe("passkey");

  // session survives a full reload (restoreAccountSession)
  await page.goto("/index.html");
  await expect(page.locator("#walletBtn")).toContainText("Signed in");

  // popover sign-out clears the account domain
  await page.click("#walletBtn");
  await page.click("#wpDisc");
  await expect(page.locator("#walletBtn")).toContainText("Sign in");
  expect(await page.evaluate(() => localStorage.getItem("enclave_account"))).toBeFalsy();

  // the resident credential signs back INTO THE SAME account
  await page.click("#walletBtn");
  await page.click("#authPasskey");                            // "Continue with passkey"
  await expect(page.locator("#walletBtn")).toContainText("Signed in");
  const again = await page.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")));
  expect(again.accountId).toBe(sess.accountId);
});
