// Wallet sign-in through the auth modal: the injected EIP-6963 wallet signs
// the relay's SIWE message (anvil does the signing), the account session
// lands, and the wallet is linked on the account.
import { test, expect } from "@playwright/test";
import { seedStorage, injectWallet, stack } from "../fixtures/session.mjs";

test("SIWE: connect a wallet, sign the relay message, account session lands", async ({ page, context }) => {
  await seedStorage(context);
  await injectWallet(context, stack.payer);

  await page.goto("/index.html");
  await page.click("#walletBtn");                              // wallet detected -> straight to SIWE, no chooser
  await expect(page.locator("#walletBtn")).toContainText(new RegExp(stack.payer.slice(0, 6), "i"));   // short() keeps checksum casing
  // the header paints on wallet CONNECT; the relay SIWE roundtrip lands a
  // beat later - poll for the stored account session, don't race it
  await expect.poll(() => page.evaluate(() => {
    const s = localStorage.getItem("enclave_account");
    return s ? JSON.parse(s).method : null;
  })).toBe("siwe");
  const sess = await page.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")));
  expect(sess.accountId).toMatch(/^acct_/);

  // the account really carries the wallet (relay /v1/account/me)
  const me = await page.evaluate(async () => {
    const r = await fetch(localStorage.getItem("enclave_api_base") + "/account/me",
      { headers: { Authorization: "Bearer " + JSON.parse(localStorage.getItem("enclave_account")).token } });
    return r.json();
  });
  expect(me.wallets).toContain(stack.payer.toLowerCase());
});
