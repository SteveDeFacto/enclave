#!/usr/bin/env node
// deploy-volume-access.mjs - compile + deploy contracts/NanVolumeAccess.sol to
// Base and print the address. This is the on-chain ACL for wallet-gated encrypted
// volumes (the crypto half is scripts/nan-vault.mjs). Hand-deployed by the
// platform admin (CONTRACTS_HAND_DEPLOY): the deploying EOA becomes `admin` (may
// rotate the operator); it holds NO keys and cannot read any volume.
//
// Constructor arg: the ENCLAVE OPERATOR EOA (the existing runner key, same one in
// REGISTRY_PRIVATE_KEY / the NanDeployments operator). That address is a permitted
// WRITER so the running enclave can auto-grant self-registering members. It is
// rotatable later via setOperator(). Per-volume owners are the app deployers.
//
// Deps (run from repo root):  npm i viem solc
//
// Usage:
//   OPERATOR_ADDRESS=0x390e... DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-volume-access.mjs               # -> Base SEPOLIA (default)
//   NETWORK=base OPERATOR_ADDRESS=0x390e... DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-volume-access.mjs   # -> Base MAINNET
//
// Env:
//   DEPLOYER_PRIVATE_KEY  required. Pays gas; becomes `admin` (operator rotation only).
//   OPERATOR_ADDRESS      required. The enclave operator EOA (auto-grant writer).
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.
// Flags:
//   --yes                 skip the interactive confirmation (CI)
//   --dry-run             compile + show the plan, do NOT broadcast
//   --no-write-config     do NOT write the address back into the repo (default
//                         wires enclaves/{gpu,cpu}/tinfoil-config.yml
//                         VOLUME_ACCESS_ADDRESS and the vault app's
//                         config.json default in wasm/apps/vault/src/lib.rs -
//                         same pattern as deploy-deployments.mjs)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createWalletClient, createPublicClient, http, formatEther, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "NanVolumeAccess.sol");
const ABI_OUT = path.join(REPO, "contracts", "NanVolumeAccess.abi.json");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ASSUME_YES = args.has("--yes");
const NO_WRITE = args.has("--no-write-config");

const CONFIG     = path.join(REPO, "enclaves", "gpu", "tinfoil-config.yml");
const CONFIG_CPU = path.join(REPO, "enclaves", "cpu", "tinfoil-config.yml");
const VAULT_APP  = path.join(REPO, "wasm", "apps", "vault", "src", "lib.rs");

// Wire the deployed address into everything that ships it (the sync script
// can then keep the flavors from drifting, but it cannot SEED an empty
// placeholder - this is the primary write).
function writeVolumeAccessAddress(addr) {
  const re = /(-\s*VOLUME_ACCESS_ADDRESS:\s*)"[^"]*"/;
  for (const file of [CONFIG, CONFIG_CPU]) {
    if (!fs.existsSync(file)) continue;
    let cfg = fs.readFileSync(file, "utf8");
    if (!re.test(cfg)) {
      console.log(`No VOLUME_ACCESS_ADDRESS line in ${path.relative(REPO, file)} yet; add under the supervisor env:`);
      console.log(`      - VOLUME_ACCESS_ADDRESS: "${addr}"   # set by scripts/deploy-volume-access.mjs`);
      continue;
    }
    fs.writeFileSync(file, cfg.replace(re, `$1"${addr}"`));
    console.log(`Wrote VOLUME_ACCESS_ADDRESS="${addr}" into ${path.relative(REPO, file)}`);
  }
  // the vault app ships the address as its config.json default (still
  // overridable per deployment via NAN_CONFIG or ?contract=)
  if (fs.existsSync(VAULT_APP)) {
    const are = /("volumeAccess":\s*)"[^"]*"/;
    const src = fs.readFileSync(VAULT_APP, "utf8");
    if (are.test(src)) {
      fs.writeFileSync(VAULT_APP, src.replace(are, `$1"${addr}"`));
      console.log(`Wrote volumeAccess="${addr}" into ${path.relative(REPO, VAULT_APP)} (rebuild the component to ship it)`);
    } else {
      console.log(`No volumeAccess default in ${path.relative(REPO, VAULT_APP)}; update it by hand: ${addr}`);
    }
  }
}

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
    sources: { "NanVolumeAccess.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["NanVolumeAccess.sol"]["NanVolumeAccess"];
  // keep the checked-in ABI in lockstep with what we deploy
  fs.writeFileSync(ABI_OUT, JSON.stringify(c.abi, null, 2) + "\n");
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
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

  // operator EOA (constructor arg) - the enclave auto-grant writer.
  let operator = process.env.OPERATOR_ADDRESS;
  if (!operator && !ASSUME_YES && input.isTTY) {
    operator = await promptText("Enclave operator EOA (auto-grant writer, e.g. 0x390e...): ");
  }
  if (!operator) die("OPERATOR_ADDRESS is required (the enclave operator EOA; rotatable later via setOperator)");
  if (!isAddress(operator)) die(`OPERATOR_ADDRESS "${operator}" is not a valid address`);
  operator = getAddress(operator);

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
  console.log(`  deployer/admin ${account.address}`);
  console.log(`  deployer ETH   ${DRY_RUN ? "(not checked, --dry-run)" : formatEther(bal)}`);
  console.log(`  operator EOA   ${operator}   (auto-grant writer; rotatable via setOperator)`);
  console.log(`  contract       NanVolumeAccess  (wallet-gated volume ACL; admin rotates operator only)`);
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
  const hash = await wallet.deployContract({ abi, bytecode, args: [operator] });
  console.log(`  tx ${hash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success" || !rcpt.contractAddress) die(`deploy tx did not succeed (status=${rcpt.status})`);
  const addr = getAddress(rcpt.contractAddress);

  console.log("\n=======================  DEPLOYED  ============================");
  console.log(`  NanVolumeAccess   ${addr}`);
  console.log(`  operator          ${operator}`);
  console.log(`  explorer          ${net.explorer}/address/${addr}`);
  console.log("===============================================================\n");

  if (NO_WRITE) console.log(`(--no-write-config: set VOLUME_ACCESS_ADDRESS="${addr}" in the configs by hand)`);
  else writeVolumeAccessAddress(addr);

  console.log("\nNext:");
  console.log(`  1. Commit the wired configs + release both flavors (the supervisor reads the ACL at VOLUME_ACCESS_ADDRESS).`);
  console.log(`  2. Ensure the operator EOA ${operator} is funded with a little Base ETH (it signs auto-grant txs).`);
  console.log(`  3. A deployer creates a volume:  createVolume(name)  (owner = their wallet; volId = keccak(owner,name)).`);
  console.log(`  4. Members self-register their X25519 pubkey via the vault app; owner/enclave grant() seals the VEK to them.`);
}

main().catch((e) => die(e.message || String(e)));
