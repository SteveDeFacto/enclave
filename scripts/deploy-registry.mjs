#!/usr/bin/env node
// deploy-registry.mjs - compile + deploy contracts/EnclaveRegistry.sol to Base,
// print the address, and (optionally) wire it everywhere the repo reads it:
// tinfoil-config.yml (REGISTRY_ADDRESS -> the supervisor self-registers on boot)
// and scripts/enclave-discover.mjs (default REGISTRY_ADDRESS for callers).
//
// EnclaveRegistry has no constructor args and NO owner: registration is open, each
// entry is controlled by the operator EOA that registered it. Trust is gated by
// attestation at connect time, not by this contract (see contracts/README.md).
//
// Deps (run from repo root):  npm i viem solc
//
// Usage:
//   DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-registry.mjs                 # -> Base SEPOLIA (default), auto-wires config
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-registry.mjs    # -> Base MAINNET, auto-wires config
//
// Env:
//   DEPLOYER_PRIVATE_KEY  required. Pays gas only - the deployer has NO special
//                         power over this contract afterwards.
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.
// Flags:
//   --no-write-config     do NOT touch tinfoil-config.yml / enclave-discover.mjs
//   --yes                 skip the interactive confirmation (CI)
//   --dry-run             compile + show the plan, do NOT broadcast

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createWalletClient, createPublicClient, http, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "EnclaveRegistry.sol");
const ABI_OUT = path.join(REPO, "contracts", "EnclaveRegistry.abi.json");
const DISCOVER = path.join(REPO, "scripts", "enclave-discover.mjs");
const CONFIG = path.join(REPO, "enclaves", "gpu", "tinfoil-config.yml");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_WRITE_CONFIG = args.has("--no-write-config"); // config is written by default on a successful deploy
const ASSUME_YES = args.has("--yes");

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base,        rpc: "https://mainnet.base.org",  explorer: "https://basescan.org" },
};

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
  const input = {
    language: "Solidity",
    sources: { "EnclaveRegistry.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["EnclaveRegistry.sol"]["EnclaveRegistry"];
  // keep the checked-in ABI in lockstep with what we deploy
  fs.writeFileSync(ABI_OUT, JSON.stringify(c.abi, null, 2) + "\n");
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

// Point the supervisor at the deployment: with REGISTRY_ADDRESS set (plus the
// REGISTRY_PRIVATE_KEY secret and ENCLAVE_ENDPOINT), the enclave self-registers
// on boot and heartbeats. Mirrors deploy-app-catalog.mjs's config write.
function writeSupervisorConfig(addr) {
  let cfg = fs.readFileSync(CONFIG, "utf8");
  const re = /(-\s*REGISTRY_ADDRESS:\s*)"[^"]*"/;
  if (!re.test(cfg)) die(`could not find REGISTRY_ADDRESS line in ${CONFIG}`);
  cfg = cfg.replace(re, `$1"${addr}"`);
  fs.writeFileSync(CONFIG, cfg);
  console.log(`Wrote REGISTRY_ADDRESS="${addr}" into ${path.relative(REPO, CONFIG)}`);
}

// Point callers at the same deployment: enclave-discover.mjs's fallback address
// (REGISTRY_ADDRESS env still overrides it).
function writeDiscoverDefault(addr) {
  let js = fs.readFileSync(DISCOVER, "utf8");
  const re = /(REGISTRY_ADDRESS\s*=\s*process\.env\?\.REGISTRY_ADDRESS\s*\|\|\s*)"[^"]*"/;
  if (!re.test(js)) die(`could not find the REGISTRY_ADDRESS default in ${DISCOVER}`);
  js = js.replace(re, `$1"${addr}"`);
  fs.writeFileSync(DISCOVER, js);
  console.log(`Wrote default REGISTRY_ADDRESS="${addr}" into ${path.relative(REPO, DISCOVER)}`);
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
  const bal = DRY_RUN ? 0n : await pub.getBalance({ address: account.address }).catch(() => 0n);

  console.log("\n========================  DEPLOY PLAN  ========================");
  console.log(`  network        ${netName}  (chainId ${net.chain.id})${isMainnet ? "   *** MAINNET / REAL FUNDS ***" : "   (testnet)"}`);
  console.log(`  rpc            ${rpc}`);
  console.log(`  deployer       ${account.address}`);
  console.log(`  deployer ETH   ${DRY_RUN ? "(not checked, --dry-run)" : formatEther(bal)}`);
  console.log(`  contract       EnclaveRegistry  (open registration; deployer keeps NO special power)`);
  console.log(`  bytecode       ${(bytecode.length / 2 - 1)} bytes`);
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

  console.log("Deploying...");
  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  console.log(`  tx ${hash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success" || !rcpt.contractAddress) die(`deploy tx did not succeed (status=${rcpt.status})`);
  const addr = getAddress(rcpt.contractAddress);

  console.log("\n=======================  DEPLOYED  ============================");
  console.log(`  EnclaveRegistry       ${addr}`);
  console.log(`  explorer          ${net.explorer}/address/${addr}`);
  console.log("===============================================================\n");

  if (!NO_WRITE_CONFIG) { writeSupervisorConfig(addr); writeDiscoverDefault(addr); }
  else console.log("(--no-write-config: skipped wiring tinfoil-config.yml + enclave-discover.mjs; set REGISTRY_ADDRESS manually)");

  console.log("\nNext:");
  console.log(`  1. tinfoil-config.yml now points at ${addr}; set ENCLAVE_ENDPOINT to each enclave's own URL there.`);
  console.log("  2. Set the REGISTRY_PRIVATE_KEY enclave secret (an EOA per enclave) and fund it with a little Base ETH for gas.");
  console.log("  3. Redeploy the enclave config; on boot you should see \"[registry] registered ... tx=0x...\".");
  console.log("  4. Verify discovery:  REGISTRY_ADDRESS=" + addr + " node scripts/enclave-discover.mjs");
  if (!isMainnet) {
    console.log("  NOTE: the supervisor's self-registration signs on Base MAINNET (viem `base` in supervisor.js),");
    console.log("        so a sepolia registry is only reachable from enclave-discover.mjs (BASE_RPC=https://sepolia.base.org).");
    console.log("        Re-run with NETWORK=base before wiring real enclaves.");
  }
}

main().catch((e) => die(e.message || String(e)));
