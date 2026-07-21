// Playwright config for the full-stack local rig: anvil (chain-id 8453,
// MockUSDC + PaymentRouter + EnclaveRegistry + EnclaveDeployments), the REAL
// relay (accounts + billing + indexer + provisioner live against anvil), a
// stub Stripe API, and the unbundled site served statically. global-setup
// boots everything and writes .stack.json; fixtures/session.mjs seeds each
// page's localStorage from it.
//
// chromium-only: the passkey specs drive the CDP WebAuthn virtual
// authenticator, which is a Chromium DevTools surface.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.mjs",
  globalTeardown: "./global-teardown.mjs",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,               // one shared relay/chain: serial keeps order state deterministic
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    baseURL: "http://localhost:18899",
    trace: "retain-on-failure",
    // headless Chromium wedges frame production on some navigations (stuck
    // cross-document view transition); the site skips soft-nav transitions
    // under reduced motion, so navigation never waits on a frame that
    // will not come
    reducedMotion: "reduce",
  },
});
