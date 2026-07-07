#!/usr/bin/env node
// set-prices.mjs — owner-only price change on the LIVE EnclaveDeployments.
// Affects FUTURE creates only (every deployment snapshots its rate at create).
//
// Interactive like the deploy scripts: run it bare and it walks you through
// network, prices (blank keeps the current value), and the hidden-input owner
// key. Everything can still be supplied up front for non-interactive use:
//
//   node scripts/set-prices.mjs                                # prompts
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... \
//     node scripts/set-prices.mjs --cpu 278 --yes              # no prompts
//
// Units: USDC 6dp per second for the FULL card (--gpu) / FULL node (--cpu).
//   278 ≈ $1.00/hr  ·  556 ≈ $2.00/hr  ·  1667 ≈ $6.00/hr
//
// Env (all optional in a terminal):
//   DEPLOYER_PRIVATE_KEY  the contract owner key (prompted, hidden, if unset)
//   DEPLOYMENTS_ADDRESS   override; defaults to site/js/core/config.js's value
//   NETWORK               base-sepolia | base (menu if unset)
//   RPC_URL               override the chain RPC

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
};
const args = process.argv.slice(2);
const ASSUME_YES = args.includes("--yes");
const flagVal = (name) => { const i = args.indexOf("--" + name); return i === -1 ? null : args[i + 1]; };
const die = (m) => { console.error("error: " + m); process.exit(1); };
const perHr = (p) => "$" + (Number(p) / 1e6 * 3600).toFixed(4) + "/hr";

function promptSecret(query) {
  return new Promise((resolve) => {
    const rl = rlSync.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) output.write(s); };  // mute keystrokes
    rl.question(query, (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
    rl._muted = true;                                                  // query already printed
  });
}
async function promptText(query) {
  const rl = readline.createInterface({ input, output });
  const ans = (await rl.question(query)).trim();
  rl.close();
  return ans;
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

// Prompt for one price: blank keeps the current value; input is the raw
// USDC-6dp-per-second integer (the hint shows the $/hr it works out to).
async function choosePrice(label, current, flag, hint) {
  if (flag != null) return BigInt(flag);
  if (ASSUME_YES || !input.isTTY) return null;                 // non-interactive: flags only
  const ans = await promptText(`New ${label} price in USDC-6dp/second [keep ${current} = ${perHr(current)}]${hint}: `);
  if (!ans) return null;
  if (!/^\d+$/.test(ans)) die(`"${ans}" is not a whole number of micro-USDC per second`);
  return BigInt(ans);
}

const abi = [
  { type: "function", name: "setPrice",    stateMutability: "nonpayable", inputs: [{ name: "_pricePerSec6", type: "uint256" }], outputs: [] },
  { type: "function", name: "setCpuPrice", stateMutability: "nonpayable", inputs: [{ name: "_cpuPricePerSec6", type: "uint256" }], outputs: [] },
  { type: "function", name: "pricePerSec6",    stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cpuPricePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner",           stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

async function main() {
  const netName = await chooseNetwork();
  const net = NETWORKS[netName];
  if (!net) die(`unknown network "${netName}" (valid: ${Object.keys(NETWORKS).join(", ")})`);
  const rpc = process.env.RPC_URL || net.rpc;
  const addr = process.env.DEPLOYMENTS_ADDRESS
    || (fs.readFileSync(path.join(REPO, "site/js/core/config.js"), "utf8").match(/DEPLOYMENTS_ADDRESS = "(0x[0-9a-fA-F]{40})"/) || [])[1]
    || die("no DEPLOYMENTS_ADDRESS (env or site/js/core/config.js)");

  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const [g0, c0, owner] = await Promise.all([
    pub.readContract({ address: addr, abi, functionName: "pricePerSec6" }),
    pub.readContract({ address: addr, abi, functionName: "cpuPricePerSec6" }),
    pub.readContract({ address: addr, abi, functionName: "owner" }),
  ]);
  output.write(`\nEnclaveDeployments ${addr} (${netName})\n`);
  output.write(`  owner:   ${owner}\n`);
  output.write(`  current: full card ${g0} (${perHr(g0)}) · full CPU node ${c0} (${perHr(c0)})\n\n`);

  const gpu = await choosePrice("FULL-CARD (GPU)", g0, flagVal("gpu"), "");
  const cpu = await choosePrice("FULL-CPU-NODE", c0, flagVal("cpu"), " (278 ≈ $1.00/hr)");
  const todo = [["setPrice", gpu, g0], ["setCpuPrice", cpu, c0]]
    .filter(([, v, cur]) => v != null && v !== cur);
  if (!todo.length) { output.write("nothing to change.\n"); return; }
  for (const [fn, v] of todo) if (v <= 0n) die(`${fn}: price must be > 0`);

  output.write("Plan (affects FUTURE creates only; existing deployments keep their snapshotted rate):\n");
  for (const [fn, v, cur] of todo) output.write(`  ${fn}(${v})   ${perHr(cur)} -> ${perHr(v)}\n`);
  if (!ASSUME_YES) {
    if (!input.isTTY) die("not a terminal — pass --yes to confirm non-interactively");
    const warn = netName === "base" ? " on MAINNET" : "";
    const ans = await promptText(`Send ${todo.length} transaction(s)${warn}? [y/N]: `);
    if (!/^y(es)?$/i.test(ans)) { output.write("aborted, nothing sent.\n"); return; }
  }

  let pk0 = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk0) {
    if (ASSUME_YES || !input.isTTY) die("DEPLOYER_PRIVATE_KEY is required (set the env var, or run in a terminal to be prompted)");
    pk0 = await promptSecret("Owner (deployer) private key (input hidden, paste and press Enter): ");
  }
  if (!pk0) die("no private key provided");
  const pk = pk0.startsWith("0x") ? pk0 : "0x" + pk0;
  let account; try { account = privateKeyToAccount(pk); } catch { die("that is not a valid private key"); }
  if (account.address.toLowerCase() !== owner.toLowerCase())
    die(`that key is ${account.address}, but the contract owner is ${owner} — the setter would revert`);
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });

  for (const [fn, v] of todo) {
    output.write(`  ${fn}(${v}) …`);
    const h = await wallet.writeContract({ address: addr, abi, functionName: fn, args: [v] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    output.write(` ${r.status} ${net.explorer}/tx/${h}\n`);
  }
  const [g1, c1] = await Promise.all([
    pub.readContract({ address: addr, abi, functionName: "pricePerSec6" }),
    pub.readContract({ address: addr, abi, functionName: "cpuPricePerSec6" }),
  ]);
  output.write(`  now: full card ${g1} (${perHr(g1)}) · full CPU node ${c1} (${perHr(c1)})\n`);
  output.write("  the site prices estimates straight from the contract, so it follows on the next page load.\n");
}

main().catch((e) => die(e.shortMessage || e.message || String(e)));
