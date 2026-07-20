#!/usr/bin/env node
// deploy-payment-router.mjs - compile + deploy contracts/PaymentRouter.sol to
// Base and print the address for the relay env + address book.
//
// PaymentRouter is non-custodial AND immutable: it forwards USDC payer ->
// treasury inside the same transaction, holds a zero balance between
// transactions, and has NO owner, NO admin functions, NO upgrade path.
// Rotating the treasury = deploying a new router with this script and
// repointing the address book key "paymentRouter" (plus the relay's
// PAYMENT_ROUTER_ADDRESS fallback env). Nothing migrates - the old router
// holds nothing by construction.
//
// Unlike the enclave-side contracts this address is consumed by the RELAY
// (indexer + checkout instructions) and the SITE (address book), never by
// tinfoil configs or the CLI - so this script writes no config files.
//
// Usage:
//   DEPLOYER_PRIVATE_KEY=0x... TREASURY_ADDRESS=0x...coldwallet \
//     node scripts/deploy-payment-router.mjs                # -> Base SEPOLIA (default)
//
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... TREASURY_ADDRESS=0x... \
//     node scripts/deploy-payment-router.mjs                # -> Base MAINNET
//
// Env:
//   DEPLOYER_PRIVATE_KEY  required. Pays gas. (The deployer has NO ongoing
//                         power over this contract - there is no owner.)
//   TREASURY_ADDRESS      REQUIRED (mainnet and testnet): where every payment
//                         lands, burned into the contract as an immutable.
//                         No ENS, no defaults - a treasury is typed exactly.
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.
//   USDC_ADDRESS          override the USDC token address for the network.
//   ADDRESS_BOOK_ADDRESS  override the EnclaveAddressBook used by the mainnet
//                         already-deployed guard (default: the Base book).
// Flags:
//   --yes                 skip the interactive confirmation (CI)
//   --dry-run             compile + show the plan, do NOT broadcast
//   --replace             on mainnet, allow re-deploying even though the book's
//                         "paymentRouter" entry already has code (treasury
//                         rotation does exactly this deliberately).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import {
  createWalletClient, createPublicClient, http, formatEther, isAddress, getAddress,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "PaymentRouter.sol");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ASSUME_YES = args.has("--yes");
const REPLACE = args.has("--replace");

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org",
                    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                    explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base, rpc: "https://mainnet.base.org",
                    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                    explorer: "https://basescan.org" },
};
// the one on-chain root for contract addresses (see enclave-address-book docs)
const DEFAULT_BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const BOOK_ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [],
                    outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];

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
    sources: { "PaymentRouter.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["PaymentRouter.sol"]["PaymentRouter"];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

// The book's key for the router, ascii right-padded to bytes32 (the book's
// key convention; matches build-contract-artifacts.mjs bookKey).
const BOOK_KEY = stringToHex("paymentRouter", { size: 32 });

async function bookRouterAddress(pub) {
  const book = getAddress(process.env.ADDRESS_BOOK_ADDRESS || DEFAULT_BOOK);
  const [keys, values] = await pub.readContract({ address: book, abi: BOOK_ABI, functionName: "all" })
    .catch(() => [[], []]);
  for (let i = 0; i < keys.length; i++)
    if (keys[i].toLowerCase() === BOOK_KEY.toLowerCase()) return values[i];
  return null;
}

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

  let pk0 = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk0) {
    if (ASSUME_YES || !input.isTTY) die("DEPLOYER_PRIVATE_KEY is required (set the env var, or run in a terminal to be prompted)");
    pk0 = await promptSecret("Deployer private key (input hidden, paste and press Enter): ");
  }
  if (!pk0) die("no private key provided");
  const pk = pk0.startsWith("0x") ? pk0 : "0x" + pk0;
  let account; try { account = privateKeyToAccount(pk); } catch { die("that is not a valid private key"); }

  const { abi, bytecode } = compile();

  let treasuryIn = process.env.TREASURY_ADDRESS;
  if (!treasuryIn && !ASSUME_YES && input.isTTY)
    treasuryIn = await promptText("Treasury address (where ALL payments land, immutable - no ENS): ");
  if (!treasuryIn) die("TREASURY_ADDRESS is required - the treasury is immutable, set it explicitly (no ENS, no defaults).");
  if (!isAddress(treasuryIn)) die(`treasury is not a valid address: ${treasuryIn}`);
  const treasury = getAddress(treasuryIn);

  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  const bal = await pub.getBalance({ address: account.address }).catch(() => 0n);

  console.log("\n========================  DEPLOY PLAN  ========================");
  console.log(`  network         ${netName}  (chainId ${net.chain.id})${isMainnet ? "   *** MAINNET / REAL FUNDS ***" : "   (testnet)"}`);
  console.log(`  rpc             ${rpc}`);
  console.log(`  deployer        ${account.address}  (gas only - the router has NO owner)`);
  console.log(`  deployer ETH    ${formatEther(bal)}`);
  console.log(`  contract        PaymentRouter  (immutable: no owner, no admin, no upgrade)`);
  console.log(`  usdc    (arg1)  ${usdc}`);
  console.log(`  treasury(arg2)  ${treasury}   <- ALL payments land here, forever (rotate = redeploy)`);
  console.log(`  bytecode        ${(bytecode.length / 2 - 1)} bytes`);
  console.log("===============================================================\n");

  if (bal === 0n) die("deployer has 0 ETH on this chain; fund it for gas first.");

  // Guard: on mainnet, refuse to silently shadow a live router. If the address
  // book's "paymentRouter" entry HAS CODE, a fresh deploy is a treasury
  // rotation - deliberate, so demand --replace.
  if (isMainnet && !REPLACE) {
    const existing = await bookRouterAddress(pub);
    if (existing && existing !== "0x0000000000000000000000000000000000000000") {
      const code = await pub.getCode({ address: existing }).catch(() => null);
      if (code && code !== "0x")
        die(`the address book's paymentRouter entry already points at ${existing}, which HAS CODE on ${netName}.\n`
          + `  A fresh deploy is a treasury rotation. Pass --replace to proceed, or --dry-run to inspect.`);
    }
  }

  if (DRY_RUN) { console.log("--dry-run: compiled and validated; not broadcasting."); return; }

  if (!ASSUME_YES) {
    const rl = readline.createInterface({ input, output });
    const prompt = isMainnet
      ? `Type "DEPLOY MAINNET" to deploy to Base mainnet with the treasury above: `
      : `Deploy to ${netName}? [y/N]: `;
    const ans = (await rl.question(prompt)).trim();
    rl.close();
    const ok = isMainnet ? ans === "DEPLOY MAINNET" : /^y(es)?$/i.test(ans);
    if (!ok) die("aborted by user.");
  }

  console.log("Deploying...");
  const hash = await wallet.deployContract({ abi, bytecode, args: [usdc, treasury] });
  console.log(`  tx ${hash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success" || !rcpt.contractAddress) die(`deploy tx did not succeed (status=${rcpt.status})`);
  const addr = getAddress(rcpt.contractAddress);

  console.log("\n=======================  DEPLOYED  ============================");
  console.log(`  PaymentRouter address  ${addr}`);
  console.log(`  explorer               ${net.explorer}/address/${addr}`);
  console.log("===============================================================\n");
  console.log("Next (no config files were written - the router is relay/site-side):");
  console.log(`  1. Relay env (/etc/nan-relay/api-relay.env):  PAYMENT_ROUTER_ADDRESS=${addr}`);
  console.log(`     then restart:  systemctl restart enclave-api-relay`);
  console.log(`  2. Address book key "paymentRouter" -> ${addr}`);
  console.log("     (admin.html Address book panel, or scripts/update-address-book.mjs;");
  console.log("      the site's USDC checkout lights up from the book, no rebuild)");
  console.log("  3. node scripts/build-contract-artifacts.mjs  (refresh the checked-in ABI if the source changed)");
  if (!isMainnet) console.log("  4. Test the pay flow on testnet, THEN re-run with NETWORK=base for mainnet.");
}

main().catch((e) => die(e.message || String(e)));
