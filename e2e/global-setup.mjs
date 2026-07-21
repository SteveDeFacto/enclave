// Boots the whole local stack once per run:
//   anvil (chain-id 8453) -> setup-chain.mjs deploys MockUSDC + PaymentRouter
//   + EnclaveRegistry + EnclaveDeployments and funds the actors
//   stub Stripe API   -> answers checkout-session creates with a url that
//                        bounces straight back to /checkout?order=<id>
//   the REAL relay    -> accounts + billing + indexer + provisioner live,
//                        OFAC cache seeded (anvil account 2 is "sanctioned")
//   static site       -> site/ unbundled on :8899
// Coordinates land in e2e/.stack.json for the specs; PIDs for teardown.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { setupChain, KEYS } from "./setup-chain.mjs";
import { serveSite } from "./serve-site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// high ports, all >= 18000: dev boxes park ad-hoc servers on the 8x00 range
const SITE_PORT = 18899, RELAY_PORT = 18200, STRIPE_PORT = 18300, ANVIL_PORT = 18545;
// the SITE runs on localhost, not 127.0.0.1: WebAuthn RP IDs must be
// DOMAINS, and Chromium rejects rp.id="127.0.0.1" outright
const SITE = `http://localhost:${SITE_PORT}`;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
export const WHSEC = "whsec_e2e_secret";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// every probe is TIMED (anvil accepts the socket but never answers a GET -
// an unbounded fetch here hung the whole setup); rpc=true probes JSON-RPC
async function waitHttp(url, { tries = 100, rpc = false } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(1000),
        ...(rpc ? { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) } : {}),
      });
      if (r.status < 500) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`never came up: ${url}`);
}

export default async function globalSetup() {
  const pids = [];

  // 1) anvil - Base's chain id so the site/wallet chain checks all pass.
  // --base-fee 0 --gas-price 0: anvil 1.5.x (CI's "stable") quotes fee
  // estimates below its own block base fee, so the provisioner's raw txs
  // bounce ("fee cap cannot be lower than the block base fee") or sit
  // unmined below the 1-gwei price floor, and its 60s retry outlives every
  // test timeout; zeroing both makes the suite hermetic across anvil versions
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--chain-id", "8453", "--silent",
                                "--base-fee", "0", "--gas-price", "0"],
    { stdio: "ignore", detached: false });
  pids.push(anvil.pid);
  await waitHttp(RPC, { rpc: true }).catch(() => { throw new Error("anvil did not start (is Foundry installed?)"); });

  // 2) contracts + funding
  const chain = await setupChain(RPC);

  // 3) stub Stripe: a checkout-session create answers with a url that lands
  // the browser right back on the order's status page (simulating a
  // completed hosted checkout); the signed webhook does the real settling
  const stripe = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const orderId = form.get("client_reference_id") || "unknown";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "cs_e2e_" + orderId,
        url: `${`http://localhost:${SITE_PORT}`}/checkout?order=${orderId}` }));
    });
  });
  await new Promise((r) => stripe.listen(STRIPE_PORT, "127.0.0.1", r));

  // 4) the relay, on a fresh data dir with the OFAC cache pre-seeded
  const dataDir = path.join(HERE, ".data");
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "ofac-sdn.json"), JSON.stringify({
    fetchedAt: new Date().toISOString(), publishDate: "e2e", source: "seed",
    eth: [chain.sanctioned.toLowerCase()], other: [] }));
  const relay = spawn(process.execPath, [path.join(REPO, "relay", "api-relay.js")], {
    env: { ...process.env,
      ENCLAVES: "http://127.0.0.1:1",
      API_RELAY_PORT: String(RELAY_PORT), API_RELAY_BIND: "127.0.0.1",
      AUTH_DATA_DIR: dataDir,
      CORS_ORIGINS: SITE,
      PASSKEY_RP_ID: "localhost",
      PASSKEY_ORIGINS: SITE,
      SIWE_DOMAIN: `localhost:${SITE_PORT}`, SIWE_URI: SITE,
      BASE_RPC: RPC,
      RPC_FALLBACKS: "0",       // hermetic: never fall back from anvil to real Base
      DEPLOYMENTS_ADDRESS: chain.deployments,
      PAYMENT_ROUTER_ADDRESS: chain.router,
      USDC_ADDRESS: chain.usdc,
      INDEXER_CONFIRMATIONS: "0", INDEXER_POLL_SEC: "1",
      STRIPE_SECRET_KEY: "sk_test_e2e",
      STRIPE_WEBHOOK_SECRET: WHSEC,
      STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
      SITE_ORIGIN: SITE,
      ORDER_TTL_SEC: "20", ORDER_SWEEP_SEC: "2",   // orders die fast: the expired spec waits one TTL out
      PROVISIONER_PRIVATE_KEY: KEYS.provisioner,
      BILLING_ADMIN_TOKEN: "e2e-admin",
      OFAC_SDN_URLS: "http://127.0.0.1:1/x",
      FEATURED_VIEWS_FILE: path.join(dataDir, "feat.json"),
    },
    // log to a FILE, never inherit: an inherited pipe outlives the runner and
    // holds any surrounding shell pipeline open forever
    stdio: ["ignore", fs.openSync(path.join(HERE, ".data", "relay.log"), "a"),
                      fs.openSync(path.join(HERE, ".data", "relay.log"), "a")],
  });
  pids.push(relay.pid);
  await waitHttp(`http://127.0.0.1:${RELAY_PORT}/health`);

  // 5) the site, unbundled
  const site = await serveSite(path.join(REPO, "site"), SITE_PORT);
  await waitHttp(`http://127.0.0.1:${SITE_PORT}/index.html`);

  globalThis.__stack = { stripe, site };
  fs.writeFileSync(path.join(HERE, ".stack.json"), JSON.stringify({
    rpc: RPC, site: SITE, relay: `http://127.0.0.1:${RELAY_PORT}`,
    whsec: WHSEC, pids, ...chain,
  }, null, 2));
}
