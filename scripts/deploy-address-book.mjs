#!/usr/bin/env node
// deploy-address-book.mjs - compile + deploy contracts/EnclaveAddressBook.sol,
// SEED it with the platform's current contract addresses (read from
// enclaves/gpu/tinfoil-config.yml), and bake the book's own address everywhere
// a component boots from: both tinfoil configs, site/js/core/config.js, and
// the CLI's defaults.
//
// The book is the ONE address that must stay stable: everything else
// (registry, deployments, appCatalog, enclavePay, volumeAccess) is resolved
// from it at start and re-polled, so future contract redeploys are a single
// owner tx (scripts/update-address-book.mjs) instead of a release train.
//
// Deps (run from repo root):  npm i viem solc
//
// Usage:
//   node scripts/deploy-address-book.mjs                # prompts (network menu, hidden key)
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-address-book.mjs --yes
//
// Env:
//   DEPLOYER_PRIVATE_KEY  pays gas and becomes the book's OWNER (governance:
//                         this key can repoint the whole platform - guard it).
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.
// Flags:
//   --no-write-config     do NOT bake the address into configs/site/cli
//   --no-seed             deploy empty (seed later with update-address-book.mjs)
//   --yes                 skip the interactive confirmation (CI)
//   --dry-run             compile + show the plan, do NOT broadcast

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createWalletClient, createPublicClient, http, formatEther, getAddress, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "EnclaveAddressBook.sol");
const ABI_OUT = path.join(REPO, "contracts", "EnclaveAddressBook.abi.json");
const CONFIG_GPU = path.join(REPO, "enclaves", "gpu", "tinfoil-config.yml");
const CONFIG_CPU = path.join(REPO, "enclaves", "cpu", "tinfoil-config.yml");
const SITE_CONFIG = path.join(REPO, "site", "js", "core", "config.js");
const CLI = path.join(REPO, "cli", "enclave.mjs");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_WRITE_CONFIG = args.has("--no-write-config");
const NO_SEED = args.has("--no-seed");
const ASSUME_YES = args.has("--yes");

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base,        rpc: "https://mainnet.base.org",  explorer: "https://basescan.org" },
};

// The canonical book entries and the env/config name each one feeds.
const ENTRIES = [
  { key: "registry",     env: "REGISTRY_ADDRESS" },
  { key: "deployments",  env: "DEPLOYMENTS_ADDRESS" },
  { key: "appCatalog",   env: "APP_CATALOG_ADDRESS" },
  { key: "enclavePay",   env: "FORWARDER_ADDRESS" },
  { key: "volumeAccess", env: "VOLUME_ACCESS_ADDRESS" },
];

function die(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1); }

function promptSecret(query) {
  return new Promise((resolve) => {
    const rl = rlSync.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) output.write(s); };
    rl.question(query, (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
    rl._muted = true;
  });
}
async function promptText(query) {
  const rl = readline.createInterface({ input, output });
  const ans = (await rl.question(query)).trim();
  rl.close();
  return ans;
}

function compile() {
  const source = fs.readFileSync(CONTRACT, "utf8");
  const inp = {
    language: "Solidity",
    sources: { "EnclaveAddressBook.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(inp)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["EnclaveAddressBook.sol"]["EnclaveAddressBook"];
  fs.writeFileSync(ABI_OUT, JSON.stringify(c.abi, null, 2) + "\n");
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

// Current platform addresses, from the gpu flavor config (the sync script's
// authority for everything but the catalog, which it also carries).
function currentAddresses() {
  const cfg = fs.readFileSync(CONFIG_GPU, "utf8");
  const out = [];
  for (const e of ENTRIES) {
    const m = cfg.match(new RegExp(`-\\s*${e.env}:\\s*"(0x[0-9a-fA-F]{40})"`));
    out.push({ ...e, value: m ? getAddress(m[1]) : null });
  }
  return out;
}

function writeEverywhere(addr) {
  const targets = [
    [CONFIG_GPU,  /(-\s*ADDRESS_BOOK_ADDRESS:\s*)"[^"]*"/, `$1"${addr}"`],
    [CONFIG_CPU,  /(-\s*ADDRESS_BOOK_ADDRESS:\s*)"[^"]*"/, `$1"${addr}"`],
    [SITE_CONFIG, /(ADDRESS_BOOK_ADDRESS\s*=\s*)"[^"]*"/,  `$1"${addr}"`],
    [CLI,         /(ADDRESS_BOOK_ADDRESS:\s*)"[^"]*"/,     `$1"${addr}"`],
  ];
  for (const [file, re, rep] of targets) {
    let s = fs.readFileSync(file, "utf8");
    if (!re.test(s)) die(`could not find the ADDRESS_BOOK_ADDRESS line in ${path.relative(REPO, file)}`);
    fs.writeFileSync(file, s.replace(re, rep));
    console.log(`Wrote ADDRESS_BOOK_ADDRESS="${addr}" into ${path.relative(REPO, file)}`);
  }
}

async function chooseNetwork() {
  let n = process.env.NETWORK;
  if (!n && !ASSUME_YES && input.isTTY) {
    const keys = Object.keys(NETWORKS);
    output.write("\nSelect network:\n");
    keys.forEach((k, i) => output.write(`  ${i + 1}) ${k}${k === "base" ? "  (MAINNET - real funds)" : "  (testnet)"}\n`));
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

  const seed = NO_SEED ? [] : currentAddresses().filter((e) => e.value);

  let pk0 = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk0 && !DRY_RUN) {
    if (ASSUME_YES || !input.isTTY) die("DEPLOYER_PRIVATE_KEY is required (set the env var, or run in a terminal to be prompted)");
    pk0 = await promptSecret("Deployer private key (input hidden, paste and press Enter): ");
  }
  const pk = pk0 ? (pk0.startsWith("0x") ? pk0 : "0x" + pk0) : null;
  let account = null;
  if (pk) { try { account = privateKeyToAccount(pk); } catch { die("that is not a valid private key"); } }

  const { abi, bytecode } = compile();
  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const bal = (DRY_RUN || !account) ? 0n : await pub.getBalance({ address: account.address }).catch(() => 0n);

  console.log("\n========================  DEPLOY PLAN  ========================");
  console.log(`  network        ${netName}  (chainId ${net.chain.id})${isMainnet ? "   *** MAINNET / REAL FUNDS ***" : "   (testnet)"}`);
  console.log(`  rpc            ${rpc}`);
  if (account) {
    console.log(`  deployer       ${account.address}  (becomes the book's OWNER — the governance key)`);
    console.log(`  deployer ETH   ${DRY_RUN ? "(not checked, --dry-run)" : formatEther(bal)}`);
  }
  console.log(`  contract       EnclaveAddressBook  (owner-updatable platform address root)`);
  console.log(`  bytecode       ${(bytecode.length / 2 - 1)} bytes`);
  console.log(`  seed           ${seed.length ? seed.map((e) => `${e.key}=${e.value}`).join("\n                 ") : "(none — --no-seed or no addresses found)"}`);
  console.log("===============================================================\n");

  if (DRY_RUN) { console.log("--dry-run: compiled and validated; not broadcasting."); return; }
  if (bal === 0n) die("deployer has 0 ETH on this chain; fund it for gas first.");

  if (!ASSUME_YES) {
    const rl = readline.createInterface({ input, output });
    const prompt = isMainnet ? `Type "DEPLOY MAINNET" to deploy to Base mainnet: ` : `Deploy to ${netName}? [y/N]: `;
    const ans = (await rl.question(prompt)).trim();
    rl.close();
    const ok = isMainnet ? ans === "DEPLOY MAINNET" : /^y(es)?$/i.test(ans);
    if (!ok) die("aborted by user.");
  }

  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  console.log("Deploying...");
  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  console.log(`  tx ${hash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success" || !rcpt.contractAddress) die(`deploy tx did not succeed (status=${rcpt.status})`);
  const addr = getAddress(rcpt.contractAddress);

  let seedFailed = false;
  if (seed.length) {
    console.log(`Seeding ${seed.length} entries (one setMany tx)...`);
    const h2 = await wallet.writeContract({
      address: addr, abi, functionName: "setMany",
      args: [seed.map((e) => stringToHex(e.key, { size: 32 })), seed.map((e) => e.value)],
      // Explicit gas: a load-balanced public RPC may estimate against a backend
      // that has not seen the deploy yet — a call to a codeless address
      // estimates ~21k and the seed then dies out-of-gas (2026-07-07 mainnet
      // deploy). Unused gas is refunded, so a generous limit costs nothing.
      gas: 100_000n + 80_000n * BigInt(seed.length),
    });
    const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
    console.log(`  seed ${r2.status} ${net.explorer}/tx/${h2}`);
    seedFailed = r2.status !== "success";
  }

  console.log("\n=======================  DEPLOYED  ============================");
  console.log(`  EnclaveAddressBook    ${addr}`);
  console.log(`  explorer              ${net.explorer}/address/${addr}`);
  console.log("===============================================================\n");

  if (!NO_WRITE_CONFIG) writeEverywhere(addr);
  else console.log("(--no-write-config: bake ADDRESS_BOOK_ADDRESS into the configs/site/cli yourself)");

  if (seedFailed) {
    console.log("\n*** SEED TX REVERTED — the book is deployed but EMPTY (readers keep their");
    console.log("*** baked fallbacks, so nothing breaks). Seed it before relying on it:");
    console.log("***   node scripts/update-address-book.mjs");
  }

  console.log("\nNext:");
  console.log("  1. Commit + push: the site resolves addresses from the book on its next deploy,");
  console.log("     and the next enclave release carries ADDRESS_BOOK_ADDRESS (dashboard update after).");
  console.log("  2. Relay boxes: add ADDRESS_BOOK_ADDRESS=" + addr + " to /etc/nan-relay/*.env (+ api-relay.env).");
  console.log("  3. Future contract redeploys: node scripts/update-address-book.mjs (one owner tx).");
}

main().catch((e) => die(e.shortMessage || e.message || String(e)));
