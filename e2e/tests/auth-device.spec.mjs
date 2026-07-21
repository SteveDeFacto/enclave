// Device flow: a desktop with NO passkey path and NO wallet signs in by
// showing a QR; a phone (separate browser context = separate storage, with a
// virtual authenticator) opens /link, creates a passkey account, sees the
// requester context + warning, approves - and the desktop's poll claims a
// session for the SAME account with amr "phone".
import { test, expect } from "@playwright/test";
import { seedStorage, addVirtualAuthenticator, stack } from "../fixtures/session.mjs";

test("device flow: passkey-less desktop signs in via phone approval", async ({ page, context, browser }, testInfo) => {
  await seedStorage(context);                                  // desktop: no authenticator, no wallet

  await page.goto("/index.html");
  await page.click("#walletBtn");
  await page.click("#authPhone");                              // "Use your phone"
  await expect(page.locator("#walletPick .wp-qr svg")).toBeVisible();
  const code = (await page.locator("#walletPick code.wp-code").textContent()).replace(/[^A-Z2-9]/g, "");
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

  // the phone is a different browser: fresh context, passkey-capable
  const phoneCtx = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await seedStorage(phoneCtx);
  const phone = await phoneCtx.newPage();
  await addVirtualAuthenticator(phoneCtx, phone);
  await phone.goto("/link?code=" + code);

  // requester context renders, and the sign-in chooser auto-opens - the
  // phone user's FIRST tap is already "create/continue with passkey"
  await expect(phone.locator(".lk-facts")).toContainText("Chrome");
  await phone.click("#authPasskeyNew");                        // create the account on the phone
  await expect(phone.locator("#lkApprove")).toBeVisible();
  await expect(phone.locator("#lkBody")).toContainText("Only approve if you just started this yourself");
  await phone.click("#lkApprove");
  await expect(phone.locator("#lkBody")).toContainText("Approved");

  // the desktop poll (3s cadence) claims the session
  await expect(page.locator("#walletBtn")).toContainText("Signed in", { timeout: 15_000 });
  const desktop = await page.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")));
  const phoneSess = await phone.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")));
  expect(desktop.accountId).toBe(phoneSess.accountId);
  expect(desktop.method).toBe("phone");

  // the code is burned: reopening the link page reports it gone
  await phone.goto("/link?code=" + code);
  await expect(phone.locator("#lkBody")).toContainText("expired or unknown");

  // returning user, fresh request: the resident passkey auto-signs-in on
  // load - the approve screen appears with ZERO auth taps (phone signs out
  // first so the auto-ceremony, not the stored session, is what's proven)
  const second = await (await fetch(stack.relay + "/v1/account/device/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  await phone.evaluate(() => localStorage.removeItem("enclave_account"));
  await phone.goto("/link?code=" + second.code);
  await expect(phone.locator("#lkApprove")).toBeVisible();
  await phoneCtx.close();
});
