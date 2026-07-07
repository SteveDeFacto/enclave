#!/usr/bin/env node
// update-address-book.mjs — the one-transaction follow-up to any contract
// redeploy: diff the LIVE EnclaveAddressBook against the repo's current
// addresses (enclaves/gpu/tinfoil-config.yml — run the deploy script and/or
// sync-contract-addresses.sh first) and push the changes with one owner
// setMany. Enclaves, the site, relays, and the CLI follow within a poll.
//
// Interactive like the other contract scripts; flags/env for CI:
//
//   node scripts/update-address-book.mjs                     # prompts
//   node scripts/update-address-book.mjs --set registry=0x…  # explicit entry (repeatable)
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/update-address-book.mjs --yes
//
// Env: DEPLOYER_PRIVATE_KEY (owner; prompted hidden if unset) · NETWORK · RPC_URL
//      ADDRESS_BOOK_ADDRESS (defaults to the value baked in the gpu config)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { createWalletClient, createPublicClient, http, getAddress, stringToHex, hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CONFIG_GPU = path.join(REPO, "enclaves", "gpu", "tinfoil-config.yml");
const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
};
const ENTRIES = [
  { key: "registry",     env: "REGISTRY_ADDRESS" },
  { key: "deployments",  env: "DEPLOYMENTS_ADDRESS" },
  { key: "appCatalog",   env: "APP_CATALOG_ADDRESS" },
  { key: "enclavePay",   env: "FORWARDER_ADDRESS" },
];
const args = process.argv.slice(2);
const ASSUME_YES = args.includes("--yes");
const die = (m) => { console.error("error: " + m); process.exit(1); };

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
async function chooseNetwork() {
  let n = process.env.NETWORK;
  if (!n && !ASSUME_YES && input.isTTY) {
    const keys = Object.keys(NETWORKS);
    output.write("\nSelect network:\n");
    keys.forEach((k, i) => output.write(`  ${i + 1}) ${k}${k === "base" ? "  (MAINNET - real funds)" : "  (testnet)"}\n`));
    const ans = await promptText(`Enter number or name [1=${keys[0]}]: `);
    if (!ans) n = keys[0]; else if (/^\d+$/.test(ans)) n = keys[parseInt(ans, 10) - 1]; else n = ans;
  }
  return (n || "base-sepolia").toLowerCase();
}

const abi = [
  { type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setMany", stateMutability: "nonpayable",
    inputs: [{ name: "keys_", type: "bytes32[]" }, { name: "values", type: "address[]" }], outputs: [] },
];

async function main() {
  const netName = await chooseNetwork();
  const net = NETWORKS[netName]; if (!net) die(`unknown network "${netName}"`);
  const rpc = process.env.RPC_URL || net.rpc;
  const cfg = fs.readFileSync(CONFIG_GPU, "utf8");
  const book = process.env.ADDRESS_BOOK_ADDRESS
    || (cfg.match(/-\s*ADDRESS_BOOK_ADDRESS:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1]
    || die("no ADDRESS_BOOK_ADDRESS (deploy the book first: scripts/deploy-address-book.mjs)");

  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const [keysHex, values] = await pub.readContract({ address: book, abi, functionName: "all" });
  const owner = await pub.readContract({ address: book, abi, functionName: "owner" });
  const live = {};
  keysHex.forEach((k, i) => { live[hexToString(k, { size: 32 }).replace(/\0+$/, "")] = getAddress(values[i]); });

  // desired = repo config values, overridden by any --set key=0x… flags
  const desired = {};
  for (const e of ENTRIES) {
    const m = cfg.match(new RegExp(`-\\s*${e.env}:\\s*"(0x[0-9a-fA-F]{40})"`));
    if (m) desired[e.key] = getAddress(m[1]);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--set") continue;
    const m = /^([A-Za-z0-9_-]{1,31})=(0x[0-9a-fA-F]{40})$/.exec(args[i + 1] || "");
    if (!m) die(`--set wants key=0xaddress, got "${args[i + 1]}"`);
    desired[m[1]] = getAddress(m[2]);
  }

  output.write(`\nEnclaveAddressBook ${book} (${netName}) · owner ${owner}\n\n`);
  const pad = (s) => String(s).padEnd(14);
  const diff = [];
  for (const [key, want] of Object.entries(desired)) {
    const cur = live[key] || null;
    const changed = !cur || cur.toLowerCase() !== want.toLowerCase();
    output.write(`  ${pad(key)} ${cur || "(unset)"}${changed ? `  ->  ${want}` : "   (unchanged)"}\n`);
    if (changed) diff.push([key, want]);
  }
  for (const [key, cur] of Object.entries(live))
    if (!(key in desired)) output.write(`  ${pad(key)} ${cur}   (in the book only; left alone)\n`);
  if (!diff.length) { output.write("\nnothing to change.\n"); return; }

  if (!ASSUME_YES) {
    if (!input.isTTY) die("not a terminal — pass --yes to confirm non-interactively");
    const ans = await promptText(`\nSend setMany(${diff.length})${netName === "base" ? " on MAINNET" : ""}? [y/N]: `);
    if (!/^y(es)?$/i.test(ans)) { output.write("aborted, nothing sent.\n"); return; }
  }

  let pk0 = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk0) {
    if (ASSUME_YES || !input.isTTY) die("DEPLOYER_PRIVATE_KEY is required");
    pk0 = await promptSecret("Owner (deployer) private key (input hidden, paste and press Enter): ");
  }
  if (!pk0) die("no private key provided");
  const account = privateKeyToAccount(pk0.startsWith("0x") ? pk0 : "0x" + pk0);
  if (account.address.toLowerCase() !== owner.toLowerCase())
    die(`that key is ${account.address}, but the book's owner is ${owner}`);
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });

  const h = await wallet.writeContract({ address: book, abi, functionName: "setMany",
    args: [diff.map(([k]) => stringToHex(k, { size: 32 })), diff.map(([, v]) => v)],
    // Explicit gas: don't trust a load-balanced RPC's estimate (a lagging
    // backend once estimated the seed as a codeless call — out-of-gas revert).
    gas: 100_000n + 80_000n * BigInt(diff.length) });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  output.write(`  setMany ${r.status} ${net.explorer}/tx/${h}\n`);
  if (r.status !== "success") die(`setMany REVERTED — the book is unchanged: ${net.explorer}/tx/${h}`);
  output.write("  enclaves/site/relays follow within one poll (≤5 min); no redeploys needed.\n");
}

main().catch((e) => die(e.shortMessage || e.message || String(e)));
