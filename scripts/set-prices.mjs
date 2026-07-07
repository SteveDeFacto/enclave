#!/usr/bin/env node
// set-prices.mjs — owner-only price change on the LIVE EnclaveDeployments.
// Affects FUTURE creates only (every deployment snapshots its rate at create).
//
// Usage (mainnet):
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/set-prices.mjs --cpu 278
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/set-prices.mjs --gpu 1667 --cpu 278
//
// Units: USDC 6dp per second for the FULL card (--gpu) / FULL node (--cpu).
//   278  ≈ $1.00/hr  ·  556 ≈ $2.00/hr  ·  1667 ≈ $6.00/hr
//
// Env:
//   DEPLOYER_PRIVATE_KEY  required — must be the contract owner (governance root;
//                         never leaves this machine).
//   DEPLOYMENTS_ADDRESS   override; defaults to site/js/core/config.js's value.
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createWalletClient, createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
};
const die = (m) => { console.error("error: " + m); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf("--" + name); return i === -1 ? null : argv[i + 1]; };
const gpu = flag("gpu"), cpu = flag("cpu");
if (gpu == null && cpu == null) die("nothing to do — pass --gpu <price6> and/or --cpu <price6> (e.g. --cpu 278 for $1/hr per node)");

const net = NETWORKS[process.env.NETWORK || "base-sepolia"];
if (!net) die(`unknown NETWORK (valid: ${Object.keys(NETWORKS).join(", ")})`);
const pk = process.env.DEPLOYER_PRIVATE_KEY || die("set DEPLOYER_PRIVATE_KEY (the contract owner)");
const addr = process.env.DEPLOYMENTS_ADDRESS
  || (fs.readFileSync(path.join(ROOT, "site/js/core/config.js"), "utf8").match(/DEPLOYMENTS_ADDRESS = "(0x[0-9a-fA-F]{40})"/) || [])[1]
  || die("no DEPLOYMENTS_ADDRESS (env or site/js/core/config.js)");

const abi = [
  { type: "function", name: "setPrice",    stateMutability: "nonpayable", inputs: [{ name: "_pricePerSec6", type: "uint256" }], outputs: [] },
  { type: "function", name: "setCpuPrice", stateMutability: "nonpayable", inputs: [{ name: "_cpuPricePerSec6", type: "uint256" }], outputs: [] },
  { type: "function", name: "pricePerSec6",    stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cpuPricePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const account = privateKeyToAccount(pk);
const rpc = process.env.RPC_URL || net.rpc;
const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
const perHr = (p) => "$" + (Number(p) / 1e6 * 3600).toFixed(4) + "/hr";

const [g0, c0] = await Promise.all([
  pub.readContract({ address: addr, abi, functionName: "pricePerSec6" }),
  pub.readContract({ address: addr, abi, functionName: "cpuPricePerSec6" }),
]);
console.log(`EnclaveDeployments ${addr} (${process.env.NETWORK || "base-sepolia"})`);
console.log(`  current: gpu ${g0} (${perHr(g0)} full card) · cpu ${c0} (${perHr(c0)} full node)`);

for (const [name, fn, val] of [["gpu", "setPrice", gpu], ["cpu", "setCpuPrice", cpu]]) {
  if (val == null) continue;
  const price = BigInt(val);
  if (price <= 0n) die(`--${name} must be > 0`);
  console.log(`  ${fn}(${price}) → ${perHr(price)} …`);
  const h = await wallet.writeContract({ address: addr, abi, functionName: fn, args: [price] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  ✓ ${r.status} ${net.explorer}/tx/${h}`);
}
const [g1, c1] = await Promise.all([
  pub.readContract({ address: addr, abi, functionName: "pricePerSec6" }),
  pub.readContract({ address: addr, abi, functionName: "cpuPricePerSec6" }),
]);
console.log(`  now:     gpu ${g1} (${perHr(g1)} full card) · cpu ${c1} (${perHr(c1)} full node)`);
console.log("  (existing deployments keep their snapshotted rate; new creates use these)");
