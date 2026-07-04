#!/usr/bin/env node
// deploy-deployments.mjs - compile + deploy contracts/NanDeployments.sol to Base,
// print the address, and (optionally) write it into tinfoil-config.yml as
// DEPLOYMENTS_ADDRESS. Re-emits contracts/NanDeployments.abi.json on every run so
// the checked-in ABI can't drift from what's deployed.
//
// NanDeployments is the portable deployment ledger: intent + funded balance +
// runner lease live on-chain, so any registered enclave can claim a deployment
// whose runner died and serve it until the funded time runs out. Non-custodial
// like NanPay (funding forwards payer -> payout in the same tx). The deployer
// EOA becomes `owner` (sets pricePerSec6 / leaseSec / payout; holds no funds).
//
// Deps (run from repo root):  npm i viem solc
//
// Usage:
//   DEPLOYER_PRIVATE_KEY=0x... PAYOUT_ADDRESS=0x...coldwallet \
//     node scripts/deploy-deployments.mjs           # -> Base SEPOLIA testnet (default)
//
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... PAYOUT_ADDRESS=0x... \
//     node scripts/deploy-deployments.mjs           # -> Base MAINNET
//
// Env:
//   DEPLOYER_PRIVATE_KEY  required. Pays gas, becomes contract owner.
//   PAYOUT_ADDRESS        cold wallet that receives funds. If unset, resolves
//                         PAYOUT_ENS (default nan.eth) via ETH_RPC (L1 mainnet).
//   PAYOUT_ENS            ENS name to resolve when PAYOUT_ADDRESS is unset.
//   REGISTRY_ADDRESS      NanRegistry to gate claims against. If unset, read from
//                         tinfoil-config.yml's REGISTRY_ADDRESS line.
//   ETH_USD_FEED          Chainlink ETH/USD aggregator; defaults per network;
//                         "none" disables ETH funding (USDC only).
//   PRICE_PER_SEC6        full-card USDC(6dp)/second price. The contract now
//                         HARDCODES 1667 (~$6.00/hour) at deploy, so by default
//                         no setPrice tx is sent at all; set this env var only
//                         to CHANGE the price ("0" skips the check entirely).
//   CPU_PRICE_PER_SEC6    whole-CPU-node USDC(6dp)/second price (every deployment
//                         pays it on its derived CPU share). Hardcoded to 556 (~$2.00/hour) at deploy;
//                         same rules as PRICE_PER_SEC6.
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.
//   USDC_ADDRESS          override the USDC token address for the network.
//   ETH_RPC               L1 RPC for ENS resolution (default cloudflare-eth.com).
//   DEPLOYED_ADDRESS      with --finish: the already-deployed contract address.
//   DEPLOY_TX             with --finish: the deploy tx hash (address read from
//                         its receipt when DEPLOYED_ADDRESS is unset).
// Flags:
//   --no-write-config     do NOT touch tinfoil-config.yml (default is to write it)
//   --yes                 skip the interactive confirmation (CI)
//   --dry-run             compile + show the plan, do NOT broadcast
//   --finish              recovery: skip the deploy; announce an ALREADY-deployed
//                         contract, write the config, and set the price if unset.
//                         Point it at the contract with DEPLOYED_ADDRESS=0x... or
//                         DEPLOY_TX=0x... (the deploy tx hash the script printed).
//                         Use when a post-deploy step failed (e.g. the public RPC's
//                         one-in-flight-tx limit for EIP-7702 delegated accounts).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import {
  createWalletClient, createPublicClient, http, formatEther, isAddress, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, mainnet } from "viem/chains";
import { normalize } from "viem/ens";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "NanDeployments.sol");
const ABI_OUT = path.join(REPO, "contracts", "NanDeployments.abi.json");
const CONFIG = path.join(REPO, "tinfoil-config.yml");
const CONFIG_CPU = path.join(REPO, "tinfoil-config.cpu.yml");   // CPU flavor points at the same ledger

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_WRITE_CONFIG = args.has("--no-write-config"); // config is written by default on a successful deploy
const ASSUME_YES = args.has("--yes");
const FINISH = args.has("--finish");

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org",
                    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                    ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
                    explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base, rpc: "https://mainnet.base.org",
                    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                    ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
                    explorer: "https://basescan.org" },
};
const ZERO = "0x0000000000000000000000000000000000000000";

function die(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1); }

// Prompt for a secret with the typed characters hidden (not echoed, not in history).
function promptSecret(query) {
  return new Promise((resolve) => {
    const rl = rlSync.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) output.write(s); };  // mute keystrokes
    rl.question(query, (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
    rl._muted = true;                                                  // query already printed
  });
}
// Prompt for a normal (non-secret) value.
async function promptText(query) {
  const rl = readline.createInterface({ input, output });
  const ans = (await rl.question(query)).trim();
  rl.close();
  return ans;
}

function compile() {
  const source = fs.readFileSync(CONTRACT, "utf8");
  const input = {
    language: "Solidity",
    sources: { "NanDeployments.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["NanDeployments.sol"]["NanDeployments"];
  fs.writeFileSync(ABI_OUT, JSON.stringify(c.abi, null, 2) + "\n");   // keep the checked-in ABI honest
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

async function resolvePayout(explicit) {
  explicit = explicit || process.env.PAYOUT_ADDRESS;
  if (explicit) {
    if (!isAddress(explicit)) die(`payout is not a valid address: ${explicit}`);
    return getAddress(explicit);
  }
  const name = process.env.PAYOUT_ENS || "nan.eth";
  const ethRpc = process.env.ETH_RPC || "https://cloudflare-eth.com";
  console.log(`PAYOUT_ADDRESS unset; resolving ${name} via L1 (${ethRpc})...`);
  const l1 = createPublicClient({ chain: mainnet, transport: http(ethRpc) });
  const addr = await l1.getEnsAddress({ name: normalize(name) }).catch((e) => die(`ENS resolve failed: ${e.message}`));
  if (!addr) die(`${name} does not resolve to an address. Set PAYOUT_ADDRESS explicitly.`);
  console.log(`  ${name} -> ${addr}`);
  return getAddress(addr);
}

// Claims are gated to NanRegistry operators, so the ledger must point at the same
// registry the enclaves advertise to. Default to the one wired into the config.
function resolveRegistry() {
  const explicit = process.env.REGISTRY_ADDRESS;
  if (explicit) {
    if (!isAddress(explicit)) die(`REGISTRY_ADDRESS is not a valid address: ${explicit}`);
    return getAddress(explicit);
  }
  const cfg = fs.readFileSync(CONFIG, "utf8");
  const m = cfg.match(/-\s*REGISTRY_ADDRESS:\s*"(0x[0-9a-fA-F]{40})"/);
  if (!m) die(`REGISTRY_ADDRESS not set and no address found in ${CONFIG}; deploy the registry first (scripts/deploy-registry.mjs).`);
  console.log(`REGISTRY_ADDRESS unset; using ${m[1]} from tinfoil-config.yml`);
  return getAddress(m[1]);
}

function writeDeploymentsAddress(addr) {
  const re = /(-\s*DEPLOYMENTS_ADDRESS:\s*)"[^"]*"/;
  for (const file of [CONFIG, CONFIG_CPU]) {
    if (!fs.existsSync(file)) continue;
    let cfg = fs.readFileSync(file, "utf8");
    if (!re.test(cfg)) {
      console.log(`No DEPLOYMENTS_ADDRESS line in ${path.relative(REPO, file)} yet; add under the supervisor env:`);
      console.log(`      - DEPLOYMENTS_ADDRESS: "${addr}"   # set by scripts/deploy-deployments.mjs`);
      continue;
    }
    cfg = cfg.replace(re, `$1"${addr}"`);
    fs.writeFileSync(file, cfg);
    console.log(`Wrote DEPLOYMENTS_ADDRESS="${addr}" into ${path.relative(REPO, file)}`);
  }
}

// Base's public RPC caps EIP-7702 delegated EOAs at ONE in-flight tx, and its
// load-balanced nodes can disagree for a while right after a confirmation — so
// a send immediately after a mined tx can bounce with "in-flight transaction
// limit reached for delegated accounts". Transient: retry with backoff (each
// attempt re-fetches the nonce, so a retry is always safe to re-send). The
// window has been observed to outlast 25s, hence the generous budget (~90s).
async function sendWithRetry(label, fn, tries = 10, gapMs = 10000) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e.shortMessage || e.message || "";
      const transient = /in-flight transaction limit|nonce too low|replacement transaction|already known/i.test(msg);
      if (!transient || i >= tries) throw e;
      console.warn(`  ${label}: ${msg.split("\n")[0]} — retry ${i}/${tries - 1} in ${gapMs / 1000}s`);
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
}

// Reads hit the same flaky public RPC (rate limits, and lagging load-balanced
// nodes that answer "no data" for a just-deployed contract). Reads are
// side-effect-free, so retry them on ANY transient-looking failure.
async function readWithRetry(label, fn, tries = 6, gapMs = 5000) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e.shortMessage || e.message || "";
      const transient = /RPC Request failed|rate limit|429|returned no data|timed? ?out|ECONNRESET|fetch failed|502|503/i.test(msg);
      if (!transient || i >= tries) throw e;
      console.warn(`  ${label}: ${msg.split("\n")[0]} — retry ${i}/${tries - 1} in ${gapMs / 1000}s`);
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
}

// Print the address + write the config. Runs BEFORE any post-deploy tx so a
// failed follow-up step can never lose the deployed address again.
function announce(addr, net) {
  console.log("\n=======================  DEPLOYED  ============================");
  console.log(`  NanDeployments   ${addr}`);
  console.log(`  explorer         ${net.explorer}/address/${addr}`);
  console.log(`  set in config    DEPLOYMENTS_ADDRESS: "${addr}"`);
  console.log("===============================================================\n");
  if (!NO_WRITE_CONFIG) writeDeploymentsAddress(addr);
  else console.log("(--no-write-config: skipped tinfoil-config.yml; set DEPLOYMENTS_ADDRESS manually)");
}

// Set a per-second price if it isn't already what we want. Reads the current
// value first, so re-runs and --finish are idempotent. Covers both schedules:
// the full-card GPU price (setPrice) and the whole-node CPU price (setCpuPrice).
// Returns true if it broadcast a tx (callers pace consecutive sends on this).
async function ensureOnePrice(pub, wallet, abi, addr, price,
                              { label, getter, setter, envVar }) {
  if (price <= 0n) { console.log(`${envVar}=0: skipping ${setter} (${label} creates revert until it is set).`); return false; }
  const current = await readWithRetry(getter, () =>
    pub.readContract({ address: addr, abi, functionName: getter }));
  if (current === price) { console.log(`${label} price already ${price}/sec — nothing to send.`); return false; }
  if (current > 0n && !process.env[envVar]) {
    console.log(`${label} price already set (${current}/sec); set ${envVar} explicitly to change it.`);
    return false;
  }
  console.log(`Setting ${label} price (${price} USDC-6dp per second)...`);
  const h2 = await sendWithRetry(setter, () =>
    wallet.writeContract({ address: addr, abi, functionName: setter, args: [price] }));
  const r2 = await readWithRetry(`${setter} receipt`, () => pub.waitForTransactionReceipt({ hash: h2 }));
  if (r2.status !== "success") die(`${setter} tx did not succeed (status=${r2.status})`);
  console.log(`  tx ${h2}`);
  return true;
}
async function ensurePrice(pub, wallet, abi, addr, price, cpuPrice) {
  const sent = await ensureOnePrice(pub, wallet, abi, addr, price,
    { label: "full-card (GPU)", getter: "pricePerSec6", setter: "setPrice", envVar: "PRICE_PER_SEC6" });
  // Settle before the next owner tx: right after a receipt, lagging RPC nodes
  // can still count the mined tx as in-flight and bounce the follow-up with
  // "in-flight transaction limit reached for delegated accounts".
  if (sent) { console.log("  (settling 15s before the next owner tx...)"); await new Promise((r) => setTimeout(r, 15000)); }
  await ensureOnePrice(pub, wallet, abi, addr, cpuPrice,
    { label: "whole-node (CPU)", getter: "cpuPricePerSec6", setter: "setCpuPrice", envVar: "CPU_PRICE_PER_SEC6" });
}

// Pick the network: from $NETWORK if set, else an interactive menu (number or name).
async function chooseNetwork() {
  let n = process.env.NETWORK;
  if (!n && !ASSUME_YES && input.isTTY) {
    const keys = Object.keys(NETWORKS);
    output.write("\nSelect network:\n");
    keys.forEach((k, i) => {
      const tag = k === "base" ? "  (MAINNET - real funds)" : "  (testnet)";
      output.write(`  ${i + 1}) ${k}${tag}\n`);
    });
    const ans = await promptText(`Enter number or name [1=${keys[0]}]: `);
    if (!ans) n = keys[0];
    else if (/^\d+$/.test(ans)) n = keys[parseInt(ans, 10) - 1];
    else n = ans;
  }
  return (n || "base-sepolia").toLowerCase();
}

async function main() {
  const netName = await chooseNetwork();
  const net = NETWORKS[netName];
  if (!net) die(`unknown network "${netName}" (valid: ${Object.keys(NETWORKS).join(", ")})`);
  const isMainnet = netName === "base";
  const rpc = process.env.RPC_URL || net.rpc;
  const usdc = getAddress(process.env.USDC_ADDRESS || net.usdc);
  const feedIn = process.env.ETH_USD_FEED || net.ethUsdFeed;
  const feed = /^none$/i.test(feedIn) ? ZERO : getAddress(feedIn);
  // Defaults MATCH the values hardcoded in the contract (~$6.00/hour full card,
  // ~$2.00/hour whole CPU node), so a fresh deploy sends ZERO follow-up txs —
  // ensurePrice just verifies. Set the env vars to change a live contract.
  const price = BigInt(process.env.PRICE_PER_SEC6 ?? "1667");
  const cpuPrice = BigInt(process.env.CPU_PRICE_PER_SEC6 ?? "556");

  let pk0 = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk0) {
    if (ASSUME_YES || !input.isTTY) die("DEPLOYER_PRIVATE_KEY is required (set the env var, or run in a terminal to be prompted)");
    pk0 = await promptSecret("Deployer private key (input hidden, paste and press Enter): ");
  }
  if (!pk0) die("no private key provided");
  const pk = pk0.startsWith("0x") ? pk0 : "0x" + pk0;
  let account; try { account = privateKeyToAccount(pk); } catch { die("that is not a valid private key"); }

  const { abi, bytecode } = compile();
  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });

  // --finish: the contract is already deployed; announce + config + price only.
  if (FINISH) {
    let addr = (process.env.DEPLOYED_ADDRESS || "").trim();
    if (!addr && process.env.DEPLOY_TX) {
      console.log(`Resolving contract address from deploy tx ${process.env.DEPLOY_TX}...`);
      const r = await readWithRetry("deploy receipt", () => pub.getTransactionReceipt({ hash: process.env.DEPLOY_TX }))
        .catch((e) => die(`could not fetch that tx receipt: ${e.shortMessage || e.message}`));
      addr = r.contractAddress || "";
    }
    if (!isAddress(addr)) die("--finish needs DEPLOYED_ADDRESS=0x... or DEPLOY_TX=0x... (the deploy tx hash the script printed).");
    addr = getAddress(addr);
    const code = await readWithRetry("getCode", () => pub.getCode({ address: addr })).catch(() => null);
    if (!code || code === "0x") die(`no contract code at ${addr} on ${netName} — wrong network or address?`);
    announce(addr, net);
    if (!ASSUME_YES) {
      const rl = readline.createInterface({ input, output });
      const ans = (await rl.question(`Send setPrice/setCpuPrice to ${addr} on ${netName} if needed? [y/N]: `)).trim();
      rl.close();
      if (!/^y(es)?$/i.test(ans)) { console.log("Skipped setPrice (re-run with --finish when ready)."); return; }
    }
    await ensurePrice(pub, wallet, abi, addr, price, cpuPrice);
    console.log("\nNext:  rebuild+repin the supervisor:  ./scripts/release.sh nan");
    return;
  }

  let payoutIn = process.env.PAYOUT_ADDRESS;
  if (!payoutIn && !ASSUME_YES && input.isTTY)
    payoutIn = await promptText("Payout address (where funds land; blank to resolve nan.eth): ");
  const payout = await resolvePayout(payoutIn);
  const registry = resolveRegistry();

  const bal = await readWithRetry("getBalance", () => pub.getBalance({ address: account.address })).catch(() => 0n);

  console.log("\n========================  DEPLOY PLAN  ========================");
  console.log(`  network        ${netName}  (chainId ${net.chain.id})${isMainnet ? "   *** MAINNET / REAL FUNDS ***" : "   (testnet)"}`);
  console.log(`  rpc            ${rpc}`);
  console.log(`  deployer       ${account.address}`);
  console.log(`  deployer ETH   ${formatEther(bal)}`);
  console.log(`  contract       NanDeployments  (owner = deployer)`);
  console.log(`  usdc    (arg1) ${usdc}`);
  console.log(`  payout  (arg2) ${payout}   <- funds land here`);
  console.log(`  registry(arg3) ${registry}   <- claims gated to its operators`);
  console.log(`  feed    (arg4) ${feed === ZERO ? "(none - ETH funding disabled)" : feed}`);
  console.log(`  setPrice       ${price === 0n ? "(skipped - call setPrice later)" : price + " (USDC 6dp / full-card second)"}`);
  console.log(`  bytecode       ${(bytecode.length / 2 - 1)} bytes`);
  console.log("===============================================================\n");

  if (bal === 0n) die("deployer has 0 ETH on this chain; fund it for gas first.");
  if (DRY_RUN) { console.log("--dry-run: compiled and validated; not broadcasting."); return; }

  if (!ASSUME_YES) {
    const rl = readline.createInterface({ input, output });
    const prompt = isMainnet
      ? `Type "DEPLOY MAINNET" to deploy to Base mainnet with the payout above: `
      : `Deploy to ${netName}? [y/N]: `;
    const ans = (await rl.question(prompt)).trim();
    rl.close();
    const ok = isMainnet ? ans === "DEPLOY MAINNET" : /^y(es)?$/i.test(ans);
    if (!ok) die("aborted by user.");
  }

  console.log("Deploying...");
  const hash = await sendWithRetry("deploy", () =>
    wallet.deployContract({ abi, bytecode, args: [usdc, payout, registry, feed] }));
  console.log(`  tx ${hash}`);
  const rcpt = await readWithRetry("deploy receipt", () => pub.waitForTransactionReceipt({ hash }));
  if (rcpt.status !== "success" || !rcpt.contractAddress) die(`deploy tx did not succeed (status=${rcpt.status})`);
  const addr = getAddress(rcpt.contractAddress);

  // announce + write config BEFORE setPrice: if the follow-up tx fails, the
  // address is already saved (recover the price step with --finish).
  announce(addr, net);
  await ensurePrice(pub, wallet, abi, addr, price, cpuPrice);

  console.log("\nNext:");
  console.log(`  1. Ensure DEPLOYMENTS_ADDRESS in tinfoil-config.yml is ${addr} (written above)`);
  console.log("  2. Rebuild+repin the supervisor (CLAIM_ENABLED is on in tinfoil-config.yml):  ./scripts/release.sh nan");
  if (!isMainnet) console.log("  3. Exercise create/fund/claim/renew/release on testnet, THEN re-run with NETWORK=base.");
}

main().catch((e) => die(e.stack || e.message));
