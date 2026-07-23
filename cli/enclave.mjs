#!/usr/bin/env node
// enclave — the Enclave platform CLI. One file, wallet-native; your wallet is your account.
//
// Every command maps 1:1 onto the public HTTP API (https://api.enclave.host/v1)
// and the on-chain contracts on Base — the CLI holds the pieces, it owns
// nothing: auth is a SIWE signature, payment is your USDC, deployments are
// EnclaveDeployments work items your key created. Run any command with -x to see
// the exact API traffic and transactions, ready to replay with curl.
//
//   enclave key new | import         bring a wallet (or ENCLAVE_KEY env)
//   enclave login                    or sign in with your Enclave account (passkey)
//   enclave deploy hello-world:1 --fund 2  create + fund + wait until live
//   enclave ls | status | logs -f    watch it run
//   enclave attest <id>              verify the enclave BEFORE you send data
//   enclave publish app.wasm --slug hello-world   pin to IPFS + cut a catalog version
//
// State lives in ~/.config/enclave/ (key: chmod 600; cached bearer tokens).
// Nothing else touches your machine; the key never leaves it — API calls sign
// a one-time SIWE challenge, transactions are signed locally and broadcast to
// your own --rpc.
//
// Passkey accounts (no wallet): `enclave login` runs the platform's device
// flow — approve the shown link from any browser where your passkey works,
// and this terminal holds an account session. That session reads your
// account-provisioned/credit deployments and balances (ls, whoami, account);
// it cannot sign transactions or wallet-gated reads, which stay key-only.
//
// Env:  ENCLAVE_KEY       hex private key (overrides the key file)
//       ENCLAVE_API_BASE  gateway or a specific enclave origin (--base)
//       ENCLAVE_RPC       Base JSON-RPC url (--rpc)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import rlSync from "node:readline";
import { stdin, stdout, stderr, argv, env, exit } from "node:process";
import { createPublicClient, createWalletClient, http as viemHttp, fallback,
         parseEther, formatUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const VERSION = "1.1.0";

// The ONLY enclave source repo this CLI will verify against. Attestation targets
// are pinned to this constant, never taken from the API response — a malicious
// gateway/enclave could otherwise point the verifier at an attacker-controlled
// repo that passes. Compared case-insensitively against the API-returned repo.
const EXPECTED_REPO = "EnclaveHost/enclave";

// ---- platform constants -----------------------------------------------------
// Addresses are Base mainnet (chain 8453), kept in lockstep with
// enclaves/*/tinfoil-config.yml and site/index.html by
// scripts/sync-contract-addresses.sh — same values, one authority.
const DEFAULTS = {
  apiBase: "https://api.enclave.host",
  chainId: 8453,
  rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org",
         "https://1rpc.io/base", "https://mainnet.base.org"],
  DEPLOYMENTS_ADDRESS: "0x0A7dE5D205c10B812AbaF0b89f3A243466bCEe01",
  APP_CATALOG_ADDRESS: "0xaB0462E55c18E295A221e4Eaa8738F25eB0696D7",
  REGISTRY_ADDRESS: "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2",
  ADDRESS_BOOK_ADDRESS: "0xab214342d5A490150A4A977063A2f88E21F80907",     // EnclaveAddressBook; written by scripts/deploy-address-book.mjs — when set, the CLI resolves the addresses above from it at start ("" = baked only)
  USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ipfsUpload: env.ENCLAVE_IPFS_UPLOAD || "https://ipfs.enclave.host/add-wasm",
  appDomain: "app.enclave.host",
};

// Minimal ABIs — mirror contracts/*.abi.json (checked in, re-emitted by the
// deploy scripts); embedded so the installed binary is self-contained.
// Deployment struct, schema rev 2. Rev-1 contracts carry a removed sshPubKey
// string after ports (in the struct and in create); depAbi() sniffs which
// shape the live ledger speaks, the same way catRev() sniffs the catalog.
const DEPLOYMENT_TUPLE = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
  { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
const DEPLOYMENT_TUPLE_V1 = [
  ...DEPLOYMENT_TUPLE.slice(0, 4), { name: "sshPubKey", type: "string" }, ...DEPLOYMENT_TUPLE.slice(4),
];
const depsAbiFor = (tuple, rev) => [
  { type: "function", name: "create", stateMutability: "nonpayable",
    inputs: [{ name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
             { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
             { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
             ...(rev >= 2 ? [] : [{ name: "sshPubKey", type: "string" }]),
             { name: "configCid", type: "string" },
             // rev-4 ledgers: the publisher-fee snapshot (recipient wallet +
             // the version's per-second fee, folded into the record's rate)
             ...(rev >= 4 ? [{ name: "feeRecipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] : [])],
    outputs: [{ type: "bytes32" }] },
  // rev-4 ledgers only: the fee snapshot back out (0x0/0 = no fee)
  { type: "function", name: "feeOf", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "recipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] },
  { type: "function", name: "fundWithAuthorization", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "from", type: "address" },
             { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
             { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
             { name: "signature", type: "bytes" }], outputs: [] },
  { type: "function", name: "fundEth", stateMutability: "payable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setActive", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "active", type: "bool" }], outputs: [] },
  // rev-3 ledgers only (deploymentsSchema >= 3): the owner's version change
  { type: "function", name: "setAppRef", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "appRef", type: "string" }], outputs: [] },
  { type: "function", name: "get", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: tuple }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: tuple }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "secondsFundable", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Created",
    inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
             { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
             { name: "cpuMilli", type: "uint16" }, { name: "rate", type: "uint256" }] },
];
// sniff once per run which shape the live contract speaks (mirrors catRev)
let _depAbi = null;
async function depAbi() {
  if (_depAbi) return _depAbi;
  let rev = 2;
  try { rev = Number(await read(DEFAULTS.DEPLOYMENTS_ADDRESS,
    [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    "deploymentsSchema", [])) || 2; }
  catch (e) { rev = 1; }   // pre-getter contract: the call reverts
  _depAbi = { rev, abi: depsAbiFor(rev >= 2 ? DEPLOYMENT_TUPLE : DEPLOYMENT_TUPLE_V1, rev) };
  return _depAbi;
}
// keccak256("Created(bytes32,address,string,uint16,uint16,uint256)") — same
// constant the deploy console uses to pull the minted id out of the receipt.
const DEP_CREATED_TOPIC = "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239";
const APP_TUPLE = [
  { name: "appId", type: "bytes32" }, { name: "publisher", type: "address" },
  { name: "slug", type: "string" }, { name: "name", type: "string" },
  { name: "description", type: "string" }, { name: "versionCount", type: "uint32" },
  { name: "createdAt", type: "uint64" }, { name: "updatedAt", type: "uint64" },
  { name: "active", type: "bool" },
];
// catalog schema rev 4: VERSION carries `config` (default/template
// ENCLAVE_CONFIG JSON, appended last; immutable + approval-covered).
// Rev sniffed via catalogSchema(): absent = rev 2; rev 3 = the retired
// app-level-config layout whose versions are config-LESS.
const VERSION_TUPLE = [
  { name: "cid", type: "string" }, { name: "version", type: "string" },
  { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
  { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" },
  { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
  { name: "yanked", type: "bool" }, { name: "ports", type: "string" },
  { name: "approval", type: "uint8" },
];
const VERSION_TUPLE_V3 = [...VERSION_TUPLE, { name: "config", type: "string" }];
const CATALOG_ABI = [
  { type: "function", name: "appCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getAppsPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: APP_TUPLE }] },
  { type: "function", name: "getVersionsPage", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }, { name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: VERSION_TUPLE }] },
  { type: "function", name: "numVersions", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "appIdOf", stateMutability: "pure",
    inputs: [{ name: "publisher", type: "address" }, { name: "slug", type: "string" }],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "cidStatus", stateMutability: "view",
    inputs: [{ name: "cid", type: "string" }],
    outputs: [{ name: "listed", type: "bool" }, { name: "appId", type: "bytes32" },
              { name: "index", type: "uint256" }, { name: "approval", type: "uint8" },
              { name: "yanked", type: "bool" }, { name: "appActive", type: "bool" },
              { name: "res", type: "uint32[4]" }] },
  { type: "function", name: "publishVersion", stateMutability: "nonpayable",
    inputs: [{ name: "slug", type: "string" }, { name: "name", type: "string" },
             { name: "description", type: "string" }, { name: "version", type: "string" },
             { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
             { name: "ports", type: "string" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }] },
  // rev-3/4 overload (viem resolves by arg count) + the schema marker
  { type: "function", name: "publishVersion", stateMutability: "nonpayable",
    inputs: [{ name: "slug", type: "string" }, { name: "name", type: "string" },
             { name: "description", type: "string" }, { name: "version", type: "string" },
             { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
             { name: "ports", type: "string" }, { name: "config", type: "string" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }] },
  // rev-5 overload: the version's publisher fee (USDC 6dp per second,
  // immutable + approval-covered like config and ports; 0 = free)
  { type: "function", name: "publishVersion", stateMutability: "nonpayable",
    inputs: [{ name: "slug", type: "string" }, { name: "name", type: "string" },
             { name: "description", type: "string" }, { name: "version", type: "string" },
             { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
             { name: "ports", type: "string" }, { name: "config", type: "string" },
             { name: "feePerSec6", type: "uint256" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }] },
  // rev-5 surface (side mapping, so version tuples decode on every rev)
  { type: "function", name: "versionFee", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxFeePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "catalogSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
// per-version publisher fee: 0 for every pre-rev-5 catalog (no getter there)
async function versionFee6(appId, index) {
  if ((await catRev()) < 5) return 0n;
  return await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "versionFee", [appId, BigInt(index)]);
}
// getVersionsPage can't overload by outputs, so rev-3 reads swap the tuple shape
const CATALOG_ABI_V3 = CATALOG_ABI.map((f) =>
  f.name === "getVersionsPage" ? { ...f, outputs: [{ type: "tuple[]", components: VERSION_TUPLE_V3 }] } : f);
let _catRev = null;
async function catRev() {
  if (_catRev) return _catRev;
  try { _catRev = Number(await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "catalogSchema", [])) || 2; }
  catch (e) { _catRev = 2; }
  return _catRev;
}
// one versions read for all revisions: only rev-4 versions carry config
// (rev 3 = the retired app-level layout; its versions decode as rev 2)
async function readVersions(appId, count) {
  const abi = (await catRev()) >= 4 ? CATALOG_ABI_V3 : CATALOG_ABI;
  const versions = await read(DEFAULTS.APP_CATALOG_ADDRESS, abi, "getVersionsPage",
                              [appId, 0n, BigInt(Math.max(1, Number(count)))]);
  return versions.map((v) => ({ config: "", ...v }));
}
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
const APPROVAL_WORD = ["pending", "approved", "rejected"];

// ---- global flags + config ---------------------------------------------------
// Parsed once, up front; command args are whatever remains.
const opt = { json: false, trace: false, base: null, rpc: null, yes: false };
const args = [];
{
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--json") opt.json = true;
    else if (a[i] === "-x" || a[i] === "--trace") opt.trace = true;
    else if (a[i] === "--yes" || a[i] === "-y") opt.yes = true;
    else if (a[i] === "--base") opt.base = a[++i];
    else if (a[i] === "--rpc") opt.rpc = a[++i];
    else args.push(a[i]);
  }
}
// Both the gateway and a bare enclave serve the same /v1 paths (and
// /availability at the root), so the base is always an origin; a pasted
// ".../v1" is normalized away.
const API_BASE = (opt.base || env.ENCLAVE_API_BASE || DEFAULTS.apiBase).replace(/\/+$/, "").replace(/\/v1$/, "");
const RPCS = (opt.rpc || env.ENCLAVE_RPC) ? [opt.rpc || env.ENCLAVE_RPC] : DEFAULTS.rpcs;
const CONF_DIR = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "enclave");

const say = (...s) => console.log(...s);
const die = (msg, code = 1) => { stderr.write("error: " + msg + "\n"); exit(code); };
const trace = (...s) => { if (opt.trace) stderr.write("x " + s.join(" ") + "\n"); };
const jout = (o) => say(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// flag parser for the per-command remainder
function flags(rest, { bool = [], val = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (bool.includes(f)) out[f.replace(/^--?/, "")] = true;
    else if (val.includes(f)) {
      if (i + 1 >= rest.length) throw new Error(`${f} needs a value`);
      out[f.replace(/^--?/, "")] = rest[++i];
    }
    else if (f.startsWith("-") && f !== "-") throw new Error(`unknown flag ${f} (see: enclave help)`);
    else out._.push(f);
  }
  return out;
}
const numFlag = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
};

// ---- key management -----------------------------------------------------------
const KEY_FILE = path.join(CONF_DIR, "key");
function loadKey({ required = true } = {}) {
  let pk = (env.ENCLAVE_KEY || "").trim();
  if (!pk && fs.existsSync(KEY_FILE)) pk = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (!pk) {
    if (required) throw new Error("no wallet key. Run `enclave key new` (or `enclave key import`, or set ENCLAVE_KEY)"
      + (accountToken({ required: false })
         ? " — your `enclave login` account session can't sign transactions or wallet-gated reads"
         : ""));
    return null;
  }
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("the configured key is not a 32-byte hex private key");
  return privateKeyToAccount(pk);
}
function saveKey(pk) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, pk + "\n", { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists, so an
  // overwrite (e.g. key new --force over a loose-permissioned file) would keep
  // the old perms — chmod explicitly to re-tighten to 0600 every time.
  try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
}
// hidden prompt (mirrors scripts/login.mjs) — keys and passphrases never echo
function promptSecret(query) {
  return new Promise((resolve) => {
    if (!stdin.isTTY) { // piped: read all of stdin
      let buf = ""; stdin.setEncoding("utf8");
      stdin.on("data", (d) => buf += d);
      stdin.on("end", () => resolve(buf.trim()));
      return;
    }
    const rl = rlSync.createInterface({ input: stdin, output: stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) stdout.write(s); };
    rl.question(query, (ans) => { rl.close(); stdout.write("\n"); resolve(ans.trim()); });
    rl.on("close", () => resolve(""));
    rl._muted = true;
  });
}
async function confirm(what) {
  if (opt.yes) return true;
  // Non-interactive (piped/cron) WITHOUT --yes: refuse rather than auto-proceed.
  // These prompts guard spending/teardown; silently answering "yes" for a pipe
  // is how a cron job drains a wallet. --yes is the explicit opt-in.
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error(`refusing to proceed without a confirmation in a non-interactive session; re-run with --yes to approve (${what})`);
  const rl = rlSync.createInterface({ input: stdin, output: stdout });
  const ans = await new Promise((r) => rl.question(what + " [y/N] ", (a) => { rl.close(); r(a.trim()); }));
  return /^y(es)?$/i.test(ans);
}

// ---- chain clients -------------------------------------------------------------
let _pub = null, _wallet = null;
function pub() {
  if (!_pub) _pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => viemHttp(u))) });
  return _pub;
}
function wallet(account) {
  if (!_wallet) _wallet = createWalletClient({ account, chain: base, transport: fallback(RPCS.map((u) => viemHttp(u))) });
  return _wallet;
}
const read = (address, abi, functionName, a = []) =>
  pub().readContract({ address, abi, functionName, args: a });
async function sendTx(account, { address, abi, functionName, args: a, value }) {
  const name = { [DEFAULTS.DEPLOYMENTS_ADDRESS]: "EnclaveDeployments",
                 [DEFAULTS.APP_CATALOG_ADDRESS]: "EnclaveAppCatalog" }[address] || address;
  trace(`tx ${name}.${functionName}(${a.map(fmtArg).join(", ")})${value ? ` value=${formatUnits(value, 18)} ETH` : ""}`);
  const hash = await wallet(account).writeContract({ address, abi, functionName, args: a, ...(value ? { value } : {}) });
  trace(`tx sent ${hash}, waiting for receipt`);
  const rcpt = await pub().waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return rcpt;
}
const fmtArg = (v) => typeof v === "string" && v.length > 48 ? JSON.stringify(v.slice(0, 45) + "…")
  : JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x);

// ---- HTTP client (SIWE auth, token cache, -x tracing) ---------------------------
const TOK_FILE = path.join(CONF_DIR, "tokens.json");
function tokenCache() { try { return JSON.parse(fs.readFileSync(TOK_FILE, "utf8")); } catch { return {}; } }
function tokenPut(k, v) {
  const t = tokenCache(); if (v) t[k] = v; else delete t[k];
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOK_FILE, JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
}
const jwtExp = (tok) => { // exp claim if the token parses as a JWT; 0 = unknown
  try { return (JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).exp || 0) * 1000; }
  catch { return 0; }
};
const jwtClaims = (tok) => { try { return JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()); } catch { return {}; } };

// ---- account sessions (`enclave login`) -----------------------------------------
// The platform's OTHER auth domain: relay-minted acct_* session JWTs from a
// passkey (or SIWE) Enclave ACCOUNT. They gate /v1/account/* and /v1/billing/*
// (profile, orders, credit, the account-deployments join) and are obtained by
// approving a device-flow link in a browser — this terminal never runs
// WebAuthn itself. They can't sign transactions or enclave-private reads;
// those stay wallet-key-only by trust-domain design.
const ACCT_TOKEN_KEY = () => `${API_BASE}|account`;
function accountToken({ required = true } = {}) {
  const t = tokenCache()[ACCT_TOKEN_KEY()];
  if (t && jwtExp(t) - Date.now() > 60_000) return t;
  if (!required) return null;
  throw new Error(t ? "your account session has expired; sign in again: enclave login"
                    : "not signed in; run `enclave login` (Enclave account/passkey) or set up a wallet key (enclave key new)");
}

async function bearer(account) {
  const key = `${API_BASE}|${account.address.toLowerCase()}`;
  const hit = tokenCache()[key];
  if (hit && jwtExp(hit) - Date.now() > 60_000) return hit;
  trace(`curl -s '${API_BASE}/v1/auth/nonce?address=${account.address}'`);
  const nonce = await fetch(`${API_BASE}/v1/auth/nonce?address=${account.address}`).then((r) => r.json());
  if (!nonce.message) throw new Error(`auth nonce failed: ${JSON.stringify(nonce)}`);
  const signature = await account.signMessage({ message: nonce.message });
  trace(`curl -sX POST ${API_BASE}/v1/auth/login -d '{"message":…,"signature":…}'`);
  const login = await fetch(`${API_BASE}/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: nonce.message, signature }),
  }).then((r) => r.json());
  if (!login.token) throw new Error(`login failed: ${JSON.stringify(login)}`);
  tokenPut(key, login.token);
  return login.token;
}
// api("GET", "/v1/deployments", { auth: account }) -> parsed JSON; throws on HTTP
// error. auth: a wallet account object (SIWE session, auto-minted) or the
// string "account" (the stored `enclave login` session token).
async function api(method, p, { body, auth, ok404, text } = {}) {
  const url = API_BASE + p;
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth === "account") headers.authorization = "Bearer " + accountToken();
  else if (auth) headers.authorization = "Bearer " + await bearer(auth);
  trace(`curl -s${method === "GET" ? "" : "X " + method} '${url}'`
        + (auth ? " -H 'authorization: Bearer …'" : "")
        + (body !== undefined ? ` -d '${JSON.stringify(body)}'` : ""));
  let r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401 && auth === "account") {
    // account sessions can't be re-minted without a fresh browser approval
    tokenPut(ACCT_TOKEN_KEY(), "");
    throw new Error("the API rejected your account session; sign in again: enclave login");
  }
  if (r.status === 401 && auth) { // stale cached token: re-login once
    tokenPut(`${API_BASE}|${auth.address.toLowerCase()}`, "");
    headers.authorization = "Bearer " + await bearer(auth);
    r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  if (r.status === 404 && ok404) return null;
  const raw = await r.text();
  if (!r.ok) {
    let d; try { d = JSON.parse(raw); } catch { d = {}; }
    throw new Error(`${method} ${p} -> ${r.status}: ${d.detail || d.error || raw.slice(0, 300)}`);
  }
  if (text) return raw;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

// ---- formatting ------------------------------------------------------------------
const isB32 = (s) => /^0x[0-9a-fA-F]{64}$/.test(s);
const short = (id) => isB32(id) ? id.slice(0, 10) + "…" : id;
const usd6 = (v) => "$" + (Number(v) / 1e6).toFixed(2);
function dur(sec) {
  sec = Math.max(0, Math.floor(Number(sec)));
  if (sec < 90) return sec + "s";
  if (sec < 5400) return Math.round(sec / 60) + "m";
  if (sec < 172800) return (sec / 3600).toFixed(1) + "h";
  return Math.round(sec / 86400) + "d";
}
function table(rows, cols) { // cols: [{ h, k | f }]
  if (!rows.length) return say("(none)");
  const cells = rows.map((r) => cols.map((c) => String((c.f ? c.f(r) : r[c.k]) ?? "")));
  const w = cols.map((c, i) => Math.max(c.h.length, ...cells.map((r) => r[i].length)));
  say(cols.map((c, i) => c.h.padEnd(w[i])).join("  ").trimEnd());
  for (const r of cells) say(r.map((v, i) => v.padEnd(w[i])).join("  ").trimEnd());
}
function kv(pairs) {
  const w = Math.max(...pairs.filter((p) => p).map(([k]) => k.length));
  for (const p of pairs) if (p && p[1] !== undefined && p[1] !== null && p[1] !== "")
    say(`${p[0].padEnd(w)}  ${p[1]}`);
}

// The app URL rule, same as the console: via the gateway each deployment is its
// own origin <first-8-hex>.app.enclave.host; direct-to-enclave it's <origin>/x/<id>.
const appLabel = (id) => isB32(id) ? id.slice(2, 10).toLowerCase() : String(id).replace(/^dep_/, "");
const appUrl = (id) => /(^|\/\/)api\.(enclave|nan)\.host/i.test(API_BASE)
  ? `https://${appLabel(id)}.${DEFAULTS.appDomain}` : `${API_BASE}/x/${id}`;

// ---- id + app-ref resolution --------------------------------------------------
// Accepts a full bytes32 id, a legacy dep_… id, or a unique 0x-hex prefix
// (>= 8 chars) which is resolved against the on-chain ledger.
async function resolveId(input, account) {
  if (isB32(input) || /^dep_[a-z0-9]+$/i.test(input)) return input;
  const hex = input.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{8,63}$/.test(hex)) throw new Error(`"${input}" is not a deployment id (bytes32, 0x-prefix of one, or dep_…)`);
  const mine = await chainDeployments(account?.address);
  const hit = mine.filter((d) => d.id.slice(2).startsWith(hex));
  if (hit.length === 1) return hit[0].id;
  const all = await chainDeployments(null);
  const hits = all.filter((d) => d.id.slice(2).startsWith(hex));
  if (hits.length === 1) return hits[0].id;
  throw new Error(hits.length ? `id prefix ${input} is ambiguous (${hits.length} matches)` : `no deployment matches id prefix ${input}`);
}
let _pageCache = null;
async function chainDeployments(owner) { // owner=null -> all
  if (!_pageCache) {
    _pageCache = [];
    for (let start = 0; ; start += 100) {
      const page = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "getPage", [BigInt(start), 100n]);
      _pageCache.push(...page);
      if (page.length < 100) break;
    }
  }
  return owner ? _pageCache.filter((d) => d.owner.toLowerCase() === owner.toLowerCase()) : _pageCache;
}

// [publisher/]slug[:version] -> { ref: catalog://<appId>/<idx>, ver, app } with
// the same resolution + approval gate the console applies (runners re-check on
// their side; this just fails fast with a readable reason). The ref names the
// on-chain VERSION RECORD — the authority for the wasm, config, and ports the
// catalog owner approved. CIDs are refused: a CID names bytes, not a version
// (several versions can share bytes and differ entirely in approved config).
async function resolveAppRef(input) {
  if (/^ipfs:\/\//i.test(input) || /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{20,})$/.test(input))
    throw new Error(`CIDs can't deploy: a CID names bytes, not a version. Deploy a [publisher/]slug:version from the catalog (enclave apps)`);
  const m = input.match(/^(?:([0-9a-zA-Z.]+|0x[0-9a-fA-F]{40})\/)?([a-z0-9][a-z0-9-]*)(?::(.+))?$/);
  if (!m) throw new Error(`"${input}" is not an app reference ([publisher/]slug[:version])`);
  const [, pubFilter, slug, verLabel] = m;
  let apps = (await catalogApps()).filter((a) => a.slug === slug && a.active);
  if (pubFilter) apps = apps.filter((a) => a.publisher.toLowerCase() === pubFilter.toLowerCase());
  if (!apps.length) throw new Error(`no active catalog app with slug "${slug}"${pubFilter ? ` by ${pubFilter}` : ""}`);
  if (apps.length > 1 && !pubFilter)
    throw new Error(`slug "${slug}" is published by ${apps.length} publishers; disambiguate as <publisher>/${slug}`);
  const app = apps[0];
  const versions = await readVersions(app.appId, app.versionCount);
  let vi;
  if (verLabel !== undefined) {
    vi = versions.findIndex((v) => v.version === verLabel && !v.yanked);
    if (vi < 0) throw new Error(`app "${slug}" has no (un-yanked) version labeled "${verLabel}"`);
  } else {
    vi = versions.findLastIndex((v) => !v.yanked && Number(v.approval) === 1);
    if (vi < 0) throw new Error(`app "${slug}" has no approved version yet`);
  }
  const ver = versions[vi];
  if (Number(ver.approval) !== 1)
    throw new Error(`${slug}:${ver.version} is ${APPROVAL_WORD[Number(ver.approval)]}; runners only claim approved versions`);
  return { ref: `catalog://${app.appId}/${vi}`, ver, app };
}
let _appsCache = null;
async function catalogApps() {
  if (_appsCache) return _appsCache;
  _appsCache = [];
  for (let start = 0; ; start += 50) {
    const page = await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "getAppsPage", [BigInt(start), 50n]);
    _appsCache.push(...page);
    if (page.length < 50) break;
  }
  return _appsCache;
}

// Minimum shares for an app's specs on the fleet's hardware — the runner's own
// formula (spec / server spec, larger of the memory and compute axes, ceil to
// the percent grain), computed against /v1/pricing's node + card numbers.
function minShares(ver, pricing) {
  const node = pricing?.node || {}, card = pricing?.card || {};
  const axis = (need, have) => need > 0 && have > 0 ? need / have : 0;
  const cpu = Math.max(axis(Number(ver.memMb), (node.ramGb || 0) * 1024),
                       axis(Number(ver.cpuGflops), node.gflops || 0));
  const gpu = Math.max(axis(Number(ver.vramMb), (card.vramGb || 0) * 1024),
                       axis(Number(ver.gpuGflops), (card.tflops || 0) * 1000));
  const grain = (x) => Math.min(1000, Math.ceil(x * 100) * 10); // whole percents, in milli
  return { gpuMilli: grain(gpu), cpuMilli: Math.max(10, grain(cpu)) };
}

// ---- funding (EIP-3009 receiveWithAuthorization -> EnclaveDeployments) ---------------
async function fundUsdc(account, id, amountUsd) {
  // Funding is billed in whole cents (contract balances are 6dp USDC). Reject
  // sub-cent amounts rather than silently rounding them to nothing / to a cent.
  const cents = amountUsd * 100;
  if (amountUsd > 0 && amountUsd < 0.01)
    throw new Error(`minimum USDC funding is $0.01 (got $${amountUsd}); amounts are billed in whole cents`);
  if (amountUsd > 0 && Math.abs(cents - Math.round(cents)) > 1e-9)
    throw new Error(`USDC funding is billed in whole cents: $${amountUsd} isn't a whole number of cents (nearest is $${(Math.round(cents) / 100).toFixed(2)})`);
  const value = BigInt(Math.round(cents)) * 10000n;             // whole cents -> 6dp
  const bal = await read(DEFAULTS.USDC_ADDRESS, ERC20_ABI, "balanceOf", [account.address]);
  if (bal < value) throw new Error(`wallet holds ${usd6(bal)} USDC on Base, needs ${usd6(value)}; fund ${account.address}`);
  // The EIP-712 domain is PINNED, never taken from the API: a forged domain
  // could coax a valid ReceiveWithAuthorization signature over a different
  // token/chain/contract. Base USDC (Circle native) domain = {"USD Coin","2"}.
  const domain = { name: "USD Coin", version: "2", chainId: DEFAULTS.chainId,
                   verifyingContract: DEFAULTS.USDC_ADDRESS };
  // authorization nonce: first 16 bytes = the deployment id's first 16 bytes
  // (the contract requires it), last 16 random so top-ups never collide
  const nonce = id.slice(0, 34) + crypto.randomBytes(16).toString("hex");
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = { from: account.address, to: DEFAULTS.DEPLOYMENTS_ADDRESS,
                    value, validAfter: 0n, validBefore, nonce };
  trace(`sign EIP-712 ReceiveWithAuthorization value=${usd6(value)} nonce=${nonce.slice(0, 20)}…`);
  const signature = await account.signTypedData({
    domain, primaryType: "ReceiveWithAuthorization",
    types: { ReceiveWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    message,
  });
  await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: (await depAbi()).abi,
    functionName: "fundWithAuthorization",
    args: [id, account.address, value, 0n, validBefore, nonce, signature] });
  return value;
}

// ---- attestation verification (the real thing, run locally) ----------------------
async function verifyEnclaveOrigin(origin, repo) {
  let Verifier;
  try { ({ Verifier } = await import("@tinfoilsh/verifier")); }
  catch { throw new Error("@tinfoilsh/verifier is not installed; reinstall the CLI (npm i -g enclave-cli)"); }
  trace(`verify ${origin} against ${repo} (@tinfoilsh/verifier: quote -> vendor root, Sigstore provenance, measurement match, TLS binding)`);
  const v = new Verifier({ serverURL: origin, configRepo: repo });
  let failure = null;
  try { await v.verify(); } catch (e) { failure = e; }
  const doc = v.getVerificationDocument();
  if (!doc) throw new Error(`verifier produced no document${failure ? `: ${failure.message}` : ""}`);
  const word = (s) => !s || s.status === "pending" ? "skipped" : s.status === "success" ? "pass" : "fail";
  const steps = {};
  for (const k of ["fetchDigest", "verifyEnclave", "verifyCode", "compareMeasurements", "verifyCertificate"])
    steps[k] = word(doc.steps?.[k]) + (doc.steps?.[k]?.error ? `: ${doc.steps[k].error}` : "");
  return { pass: !!doc.securityVerified, steps,
           release: doc.releaseDigest ? `sha256:${doc.releaseDigest}` : null,
           measurement: doc.enclaveFingerprint || null,
           error: failure?.message || null };
}
function printVerdict(r, origin, repo) {
  kv([["enclave", origin], ["repo", repo],
      ...Object.entries(r.steps).map(([k, v]) => ["  " + k, v]),
      ["release", r.release], ["measurement", r.measurement]]);
  say(r.pass ? `verdict     PASS: this enclave's quote matches the signed ${EXPECTED_REPO} release and TLS terminates inside it (trust rests on the pinned repo + the verifier's vendor/Sigstore roots)`
             : `verdict     FAIL: do not send data${r.error ? ` (${r.error})` : ""}`);
}
// The verification target repo is PINNED to EXPECTED_REPO, never the API's own
// claim. If the API names a different repo we refuse — a gateway that could pick
// the repo could pick one whose (attacker-controlled) release the quote matches.
function pinnedRepo(apiRepo) {
  if (apiRepo && String(apiRepo).toLowerCase() !== EXPECTED_REPO.toLowerCase())
    throw new Error(`attestation names repo "${apiRepo}", but this CLI only verifies against ${EXPECTED_REPO}; refusing (a chosen repo can carry a chosen release the quote would match)`);
  return EXPECTED_REPO;
}
async function attestDeployment(account, id) {
  // Keyless works: the endpoint is public. The OWNER's session adds one thing —
  // the GPU report is regenerated fresh over OUR nonce — so only authenticate
  // and send a challenge when our key actually owns the deployment; anyone
  // else gets the enclave's cached report (the server would ignore their nonce
  // anyway, and an ignored challenge prints as a scary false "nonce mismatch").
  let asOwner = false;
  if (account && isB32(id)) {
    const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]).catch(() => null);
    asOwner = !!d && d.owner.toLowerCase() === account.address.toLowerCase();
  } else if (account) asOwner = true;   // legacy dep_… id: no chain row to compare against
  const nonce = asOwner ? crypto.randomBytes(32).toString("hex") : null;
  const att = await api("GET", `/v1/deployments/${id}/attestation${nonce ? `?nonce=${nonce}` : ""}`,
                        asOwner ? { auth: account } : {});
  const origin = new URL(att.verification.attestationEndpoint).origin;
  const repo = pinnedRepo(att.verification.repo);
  return { att, nonce, origin, repo, result: await verifyEnclaveOrigin(origin, repo) };
}

// ---- commands ---------------------------------------------------------------------
// `enclave login`: sign in with an Enclave ACCOUNT (passkey/SIWE) through the
// platform's device flow — the same /v1/account/device/* endpoints behind the
// site's "Use your phone" sign-in. This terminal starts a request and shows a
// link + code; the user approves it in any browser where their passkey works.
// The link/QR carries only the CODE — claiming the session additionally needs
// the SECRET, which never leaves this process, so a shoulder-surfed code can
// never hand this terminal's session to someone else (worst case a stranger
// signs US into THEIR account; the approve page carries warning copy).
async function cmdLogin(rest) {
  const f = flags(rest, { bool: ["--print"] });
  const cur = accountToken({ required: false });
  if (cur) say(`already signed in as ${jwtClaims(cur).sub || "?"}; approving again replaces that session`);
  const start = await api("POST", "/v1/account/device/start", { body: {} });
  if (!start.code || !start.secret) throw new Error(`device flow unavailable: ${JSON.stringify(start).slice(0, 200)}`);
  const link = start.link || `https://enclave.host/link?code=${start.code}`;
  const pretty = start.code.length === 8 ? start.code.slice(0, 4) + "-" + start.code.slice(4) : start.code;
  say(`Open this link on your phone or in any browser where you can sign in to Enclave:`);
  say(``);
  say(`    ${link}`);
  say(``);
  say(`(or open ${link.split("?")[0]} and enter the code ${pretty})`);
  say(`Only approve a request you started yourself. Waiting for approval…`);
  const deadline = Date.parse(start.expiresAt) || Date.now() + 3 * 60_000;
  for (;;) {
    await sleep(Math.max(250, (Number(start.interval) || 3) * 1000));
    if (Date.now() > deadline) throw new Error("the sign-in request expired before it was approved; run `enclave login` again");
    // 404 = the code is gone (expired/claimed elsewhere); other errors are
    // transient network blips — keep polling until the deadline says stop
    const r = await api("POST", "/v1/account/device/claim",
      { body: { code: start.code, secret: start.secret }, ok404: true }).catch(() => undefined);
    if (r === null) throw new Error("the sign-in request expired; run `enclave login` again");
    if (r === undefined || r.status === "pending") continue;
    if (r.status === "denied") throw new Error("the request was denied from the approving device");
    if (r.status === "ok" && r.token) {
      tokenPut(ACCT_TOKEN_KEY(), r.token);
      if (opt.json) return jout({ accountId: r.accountId, method: r.method, expiresAt: r.expiresAt,
                                  ...(f.print ? { token: r.token } : {}) });
      say(`signed in as ${r.accountId} (session until ${r.expiresAt})`);
      say(`try: enclave whoami · enclave ls · enclave account`);
      if (f.print) say(r.token);   // --print: the raw bearer, for curl/scripts against /v1/account/* + /v1/billing/*
      return;
    }
    throw new Error(`unexpected claim answer: ${JSON.stringify(r).slice(0, 200)}`);
  }
}

async function cmdLogout() {
  const had = !!tokenCache()[ACCT_TOKEN_KEY()];
  tokenPut(ACCT_TOKEN_KEY(), "");
  say(had ? "signed out (the local session token is discarded; the session also expires server-side on its own)"
          : "no account session to discard");
}

async function cmdKey(rest) {
  const sub = rest[0];
  if (sub === "new") {
    const f = flags(rest.slice(1), { bool: ["--force"] });
    if (fs.existsSync(KEY_FILE) && !f.force)
      throw new Error(`${KEY_FILE} already exists; pass --force to overwrite it (this abandons the old address!)`);
    const pk = generatePrivateKey();
    saveKey(pk);
    const a = privateKeyToAccount(pk);
    if (opt.json) return jout({ address: a.address, keyFile: KEY_FILE });
    say(a.address);
    say(`key saved to ${KEY_FILE} (0600). Fund this address with USDC on Base (chain 8453)`);
    say(`plus a little ETH for transaction gas, then: enclave deploy <app> --fund 5`);
  } else if (sub === "import") {
    const pk0 = await promptSecret("private key (hidden): ");
    let pk = pk0.startsWith("0x") ? pk0 : "0x" + pk0;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("that is not a 32-byte hex private key");
    saveKey(pk);
    const a = privateKeyToAccount(pk);
    if (opt.json) return jout({ address: a.address, keyFile: KEY_FILE });
    say(a.address);
    say(`key saved to ${KEY_FILE} (0600)`);
  } else throw new Error("usage: enclave key new [--force] | enclave key import");
}

async function cmdWhoami() {
  const account = loadKey({ required: false });
  const acctTok = accountToken({ required: false });
  if (!account && !acctTok)
    throw new Error("no wallet key and no account session. Run `enclave key new` (wallet) or `enclave login` (Enclave account/passkey)");
  const out = {}, rows = [];
  if (account) {
    const [eth, usdc] = await Promise.all([
      pub().getBalance({ address: account.address }),
      read(DEFAULTS.USDC_ADDRESS, ERC20_ABI, "balanceOf", [account.address]),
    ]);
    let running = null;
    try {
      const ls = await api("GET", "/v1/deployments", { auth: account });
      running = (ls.data || []).filter((d) => d.status === "running").length;
    } catch {} // API being down shouldn't hide your own balances
    Object.assign(out, { address: account.address, ethWei: eth, usdc6: usdc, running, keyFile: env.ENCLAVE_KEY ? "(env)" : KEY_FILE });
    rows.push(["address", account.address],
      ["usdc", usd6(usdc) + " (Base)"],
      ["eth", formatUnits(eth, 18).replace(/(\.\d{6})\d+$/, "$1") + " (gas)"],
      ["running", running === null ? "(api unreachable)" : String(running)],
      ["key", env.ENCLAVE_KEY ? "ENCLAVE_KEY env" : KEY_FILE]);
  }
  if (acctTok) {
    const c = jwtClaims(acctTok);
    const until = c.exp ? new Date(c.exp * 1000).toISOString() : null;
    out.account = { accountId: c.sub, method: c.amr, expiresAt: until };
    rows.push(["account", `${c.sub} (${c.amr || "?"} session${until ? ` until ${until.slice(0, 10)}` : ""})`]);
    // credit balance is a nicety: no vault key / vaults dark / API down must
    // not break whoami
    try {
      const v = await api("GET", "/v1/billing/vault", { auth: "account" });
      out.account.creditUsd = v.balanceUsd;
      rows.push(["credit", `$${v.balanceUsd} (account credit)`]);
    } catch {}
  }
  if (opt.json) return jout(out);
  kv(rows);
}

async function cmdLs() {
  const account = loadKey({ required: false });
  const acctTok = accountToken({ required: false });
  if (!account && !acctTok)
    throw new Error("no wallet key and no account session. Run `enclave key new` (wallet) or `enclave login` (Enclave account/passkey)");
  const [apiList, mine, acctList] = await Promise.all([
    account ? api("GET", "/v1/deployments", { auth: account }).then((r) => r.data || []).catch(() => []) : [],
    account ? chainDeployments(account.address).catch(() => []) : [],
    // the account join: order-provisioned + credit-vault-owned deployments,
    // served in the same view shape as the enclave rows
    acctTok ? api("GET", "/v1/billing/deployments", { auth: "account" }).then((r) => r.deployments || []).catch(() => []) : [],
  ]);
  const seen = new Set(apiList.map((d) => String(d.id).toLowerCase()));
  const rows = apiList.map((d) => ({
    id: d.id, app: d.image?.reference || "", status: d.status,
    shares: `${d.resources?.gpuShare ? Math.round(d.resources.gpuShare * 100) + "% gpu " : ""}${Math.round((d.resources?.cpuShare || 0) * 100)}% cpu`,
    left: d.timeRemainingSec != null ? dur(d.timeRemainingSec) : "",
    url: d.status === "running" ? appUrl(d.id) : "",
  }));
  for (const d of acctList) {
    const id = d.deploymentId || d.id;
    if (!id || seen.has(String(id).toLowerCase())) continue;
    seen.add(String(id).toLowerCase());
    rows.push({ id, app: d.image?.reference || "", status: d.status || "unknown",
      shares: `${d.resources?.gpuShare ? Math.round(d.resources.gpuShare * 100) + "% gpu " : ""}${Math.round((d.resources?.cpuShare || 0) * 100)}% cpu`,
      left: d.timeRemainingSec != null ? dur(d.timeRemainingSec) : "",
      url: d.status === "running" ? appUrl(id) : "",
      via: d.viaVault ? "credit" : "order" });
  }
  // queue items the fleet hasn't picked up (or that ran dry) exist only on-chain
  for (const d of mine) {
    if (seen.has(d.id.toLowerCase())) continue;
    if (!d.active) continue;
    const leased = Number(d.leaseUntil) * 1000 > Date.now();
    const fundable = d.rate > 0n ? Number(d.balance6 / d.rate) : 0;
    rows.push({ id: d.id, app: d.appRef, status: leased ? "claimed" : (fundable >= 1 ? "queued" : "unfunded"),
                shares: `${d.gpuMilli ? (Number(d.gpuMilli) / 10) + "% gpu " : ""}${Number(d.cpuMilli) / 10}% cpu`,
                left: dur(fundable), url: "" });
  }
  if (opt.json) return jout({ deployments: rows });
  table(rows, [{ h: "id", f: (r) => short(r.id) }, { h: "app", f: (r) => r.app.length > 40 ? r.app.slice(0, 37) + "…" : r.app },
               { h: "status", k: "status" }, { h: "shares", k: "shares" },
               { h: "funded", k: "left" }, { h: "url", k: "url" }]);
}

async function cmdStatus(rest) {
  // keyless works: the ledger row is public, and public deployments answer the
  // API read unauthenticated (account-session users get their status this way
  // too — enclave-private reads stay wallet-gated by trust-domain design)
  const account = loadKey({ required: false });
  if (!rest[0]) throw new Error("usage: enclave status <id>");
  const id = await resolveId(rest[0], account);
  const rec = account
    ? await api("GET", `/v1/deployments/${id}`, { auth: account, ok404: true })
    : await api("GET", `/v1/deployments/${id}`, { ok404: true }).catch(() => null);
  let chainRec = null;
  if (isB32(id)) try { chainRec = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]); } catch {}
  if (!rec && !chainRec) throw new Error(`no deployment ${rest[0]} (not on any live enclave, not on the ledger)`);
  if (opt.json) return jout({ api: rec, chain: chainRec });
  const leased = chainRec && Number(chainRec.leaseUntil) * 1000 > Date.now();
  // queued vs unfunded is the contract's claimable() boundary (balance6 >= rate):
  // below it no enclave will ever claim, so "queued" would be a lie
  const claimable = chainRec && chainRec.balance6 >= chainRec.rate;
  kv([
    ["id", id],
    ["app", rec?.image?.reference || chainRec?.appRef],
    ["status", rec?.status || (chainRec ? (!chainRec.active ? "stopped" : leased ? "claimed (no live enclave record yet)" : claimable ? "queued: waiting for an enclave to claim" : "unfunded: spent its funding; a top-up re-queues it (enclave fund)") : null)],
    ["visibility", (rec ? rec.public : chainRec?.isPublic) ? "public" : "private (owner bearer required)"],
    rec?.resources ? ["shares", `gpu ${Math.round((rec.resources.gpuShare || 0) * 100)}% · cpu ${Math.round((rec.resources.cpuShare || 0) * 100)}%`]
                   : chainRec ? ["shares", `gpu ${Number(chainRec.gpuMilli) / 10}% · cpu ${Number(chainRec.cpuMilli) / 10}%`] : null,
    chainRec ? ["rate", `${usd6(chainRec.rate)}/s (${usd6(chainRec.rate * 3600n)}/h)`] : rec ? ["rate", `$${rec.ratePerSecondUsdc}/s`] : null,
    chainRec ? ["balance", `${usd6(chainRec.balance6)} on-chain (${dur(chainRec.rate > 0n ? Number(chainRec.balance6 / chainRec.rate) : 0)})`] : null,
    rec?.timeRemainingSec != null ? ["remaining", dur(rec.timeRemainingSec)] : null,
    leased ? ["lease", `until ${new Date(Number(chainRec.leaseUntil) * 1000).toISOString()} (runner ${short(chainRec.runner)}, operator ${chainRec.runnerOperator})`] : null,
    ["url", appUrl(id)],
    // the deployment's dedicated IPv6: declared tcp/udp ports served on it at
    // their real port numbers; with egress on it's the outbound address too
    rec?.network?.address ? ["ip6", rec.network.address
      + (rec.network.tcp || rec.network.udp ? "" : rec.network.egress ? " (egress only)" : "")] : null,
    rec?.network?.tcp ? ["tcp", JSON.stringify(rec.network.tcp)] : null,
    rec?.network?.udp ? ["udp", JSON.stringify(rec.network.udp)] : null,
  ]);
}

async function cmdLogs(rest) {
  const account = loadKey();
  const f = flags(rest, { bool: ["-f", "--follow"], val: ["--tail"] });
  if (!f._[0]) throw new Error("usage: enclave logs <id> [-f] [--tail N]");
  const id = await resolveId(f._[0], account);
  const tail = Math.min(2000, parseInt(f.tail || "200", 10) || 200);
  const follow = f.f || f.follow;
  let last = "";
  for (;;) {
    const text = await api("GET", `/v1/deployments/${id}/logs?tail=${follow ? 2000 : tail}`, { auth: account, text: true });
    if (text !== last) {
      // print only what's new when the previous fetch is a prefix; else reprint
      stdout.write(text.startsWith(last) ? text.slice(last.length) : text);
      last = text;
    }
    if (!follow) break;
    await sleep(2000);
  }
}

async function cmdFund(rest) {
  const account = loadKey();
  const f = flags(rest, { val: ["--usdc", "--eth"] });
  if (!f._[0] || (!f.usdc && !f.eth)) throw new Error("usage: enclave fund <id> --usdc 5 | --eth 0.002");
  const id = await resolveId(f._[0], account);
  if (!isB32(id)) throw new Error("only on-chain deployments (bytes32 ids) are fundable by transaction");
  const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]);
  if (d.owner === "0x0000000000000000000000000000000000000000") throw new Error(`no deployment ${short(id)} on the ledger`);
  if (f.usdc) {
    const amt = numFlag(f.usdc, "--usdc");
    if (!(await confirm(`fund ${short(id)} with ${usd6(BigInt(Math.round(amt * 1e6)))} USDC (buys ~${dur(d.rate > 0n ? amt * 1e6 / Number(d.rate) : 0)})?`)))
      return say("aborted");
    await fundUsdc(account, id, amt);
  } else {
    const amt = numFlag(f.eth, "--eth");
    if (!(await confirm(`fund ${short(id)} with ${amt} ETH (credited at the Chainlink ETH/USD rate)?`))) return say("aborted");
    await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: (await depAbi()).abi,
      functionName: "fundEth", args: [id], value: parseEther(String(amt)) });
  }
  const fresh = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]);
  if (opt.json) return jout({ id, balance6: fresh.balance6, fundableSec: fresh.rate > 0n ? Number(fresh.balance6 / fresh.rate) : 0 });
  say(`balance ${usd6(fresh.balance6)}: ${dur(fresh.rate > 0n ? Number(fresh.balance6 / fresh.rate) : 0)} of runtime at ${usd6(fresh.rate * 3600n)}/h`);
}

async function cmdAttest(rest) {
  if (!rest[0]) {
    // no id: verify the enclave serving this API base (the enclave-level report)
    const att = await api("GET", "/v1/attestation");
    const origin = new URL(att.verification.attestationEndpoint).origin;
    const repo = pinnedRepo(att.verification.repo);   // pinned, not API-chosen
    const r = await verifyEnclaveOrigin(origin, repo);
    if (opt.json) return jout({ origin, repo, ...r });
    printVerdict(r, origin, repo);
    if (!r.pass) exit(1);
    return;
  }
  // No wallet needed: attestation is a READER's tool (an app's users verify the
  // enclave before sending it data, and they don't own the deployment). A key,
  // when one is configured, only upgrades the GPU report to a fresh challenge
  // signed over our own nonce.
  const account = loadKey({ required: false });
  const id = await resolveId(rest[0], account);
  const { att, nonce, origin, repo, result } = await attestDeployment(account, id);
  // The GPU CC report must be signed over the SAME nonce we sent, or its
  // freshness is unproven (a replayed report would still "have a nonce").
  const gpuNonce = att.gpu ? String(att.gpu.nonce || "").toLowerCase().replace(/^0x/, "") : "";
  const gpuNonceOk = !!nonce && !!gpuNonce && gpuNonce === nonce.toLowerCase();
  if (opt.json) return jout({ id, origin, repo, ...result, vm: att.vm ? { technology: att.vm.technology, measurements: att.vm.measurements } : null, gpu: att.gpu ? { ccMode: att.gpu.ccMode, nonce: att.gpu.nonce, nonceVerified: gpuNonceOk } : null });
  kv([["deployment", id], att.app?.digest ? ["app digest", att.app.digest] : null]);
  printVerdict(result, origin, repo);
  if (att.vm?.technology) say(`vm          ${att.vm.technology} quote present (registers in --json)`);
  if (att.gpu) say(`gpu         CC report ${att.gpu.report ? "present" : "absent"}${att.gpu.ccMode ? `, ccMode=${att.gpu.ccMode}` : ""}`
    + (gpuNonceOk ? `, fresh (signed over our nonce)`
     : nonce      ? `, freshness NOT verified (${att.gpu.nonce ? "nonce mismatch" : "no nonce returned"})`
                  : `, enclave-chosen nonce (an owner key buys a challenge over your own nonce)`));
  if (!result.pass) exit(1);
}


async function cmdStop(rest) {
  const account = loadKey();
  if (!rest[0]) throw new Error("usage: enclave stop <id>");
  const id = await resolveId(rest[0], account);
  if (!(await confirm(`stop ${short(id)}? (suspends the app and takes it off the queue; the remaining balance stays on the deployment - \`enclave resume\` re-queues it)`))) return say("aborted");
  if (isB32(id)) {
    // take the work item off the queue first so no enclave re-claims it…
    const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]).catch(() => null);
    if (d && d.active && d.owner.toLowerCase() === account.address.toLowerCase())
      await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: (await depAbi()).abi,
        functionName: "setActive", args: [id, false] });
  }
  // …then tear down the running instance (the runner also notices ActiveSet on
  // its next sweep; DELETE just makes it immediate)
  const r = await api("DELETE", `/v1/deployments/${id}`, { auth: account, ok404: true });
  if (opt.json) return jout(r || { id, status: "stopped", note: "ledger item deactivated; no live enclave record" });
  say(r ? `${r.status}${r.ranSeconds ? ` after ${dur(r.ranSeconds)}` : ""}${r.note ? ` (${r.note})` : ""}`
        : "deactivated on-chain; no enclave was serving it");
}

// Restart in place: the enclave stops the app instance and relaunches it on
// the same version, lease and balance - a pure API action (no wallet tx; SIWE
// auth only). The remedy for a wedged instance the crash detector can't see:
// the process answers, it just can't do its job (e.g. it booted before its
// model volume finished mounting and can never load the model).
async function cmdRestart(rest) {
  const account = loadKey();
  if (!rest[0]) throw new Error("usage: enclave restart <id>");
  const id = await resolveId(rest[0], account);
  const r = await api("POST", `/v1/deployments/${id}/restart`, { auth: account });
  if (opt.json) return jout(r);
  say(`${r.status}${r.note ? ` (${r.note})` : ""}`);
}

// The other half of stop: setActive(true) re-queues the work item (its balance
// never left the record), then one claim-hint nudges the fleet so the relaunch
// doesn't wait for the next sweep. The app relaunches FRESH from its published
// version - suspend/resume preserves money, not memory.
async function cmdResume(rest) {
  const account = loadKey();
  if (!rest[0]) throw new Error("usage: enclave resume <id>");
  const id = await resolveId(rest[0], account);
  if (!isB32(id)) throw new Error("only on-chain deployments (bytes32 ids) can be resumed");
  const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]);
  if (!d || d.owner === "0x0000000000000000000000000000000000000000") throw new Error(`no deployment ${short(id)} on the ledger`);
  if (d.owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`${short(id)} is owned by ${d.owner}, not this key`);
  const fundable = d.rate > 0n ? Number(d.balance6 / d.rate) : 0;
  if (!(await confirm(`resume ${short(id)}? (re-queues it; the remaining ${usd6(d.balance6)} buys ${dur(fundable)} at ${usd6(d.rate * 3600n)}/h once it runs)`))) return say("aborted");
  if (d.active) say("already active on the ledger; nudging the fleet");
  else await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: (await depAbi()).abi,
    functionName: "setActive", args: [id, true] });
  const h = await api("POST", "/v1/claim-hint", { body: { id } }).catch(() => null);
  if (opt.json) return jout({ id, active: true, fundableSec: fundable, hint: h });
  if (fundable < 1)
    say(`re-queued, but UNFUNDED: ${usd6(d.balance6)} buys under a second at ${usd6(d.rate * 3600n)}/h - \`enclave fund ${short(id)} --usdc 5\` un-sticks it`);
  else if (h && h.accepted === false && h.reason)
    say(`re-queued; claim-hint declined: ${h.reason} (the sweep may still claim it)`);
  else
    say(`re-queued with ${dur(fundable)} of runtime - an enclave claims it shortly (watch: enclave status ${short(id)})`);
}

// Switch a deployment to another approved version of ITS app (setAppRef) —
// the upgrade path: paid time, shares and any live lease stay on the record,
// so a new release never costs a second buy-in; the current runner restarts
// the app in place on the new version. The same pre-flight gates as deploy
// run BEFORE the wallet signature: catalog approval, and the new version's
// minimum shares against the deployment's immutable bought shares (a version
// no runner accepts would leave the app dark on a still-billing lease).
async function cmdUpgrade(rest) {
  const account = loadKey();
  if (!rest[0]) throw new Error("usage: enclave upgrade <id> [<version>]  (default: the app's latest approved version)");
  const id = await resolveId(rest[0], account);
  if (!isB32(id)) throw new Error("only on-chain deployments (bytes32 ids) can change versions");
  const { rev, abi } = await depAbi();
  if (rev < 3) throw new Error("the live EnclaveDeployments contract predates version changes (deploymentsSchema < 3); until the ledger upgrade, deploy the new version fresh and stop the old one");
  const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, abi, "get", [id]);
  if (!d || d.owner === "0x0000000000000000000000000000000000000000") throw new Error(`no deployment ${short(id)} on the ledger`);
  if (d.owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`${short(id)} is owned by ${d.owner}, not this key`);
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(d.appRef || "");
  if (!m) throw new Error(`${short(id)} references "${d.appRef}" - only catalog-versioned deployments can switch versions`);
  const appId = m[1], curIdx = Number(m[2]);
  const app = (await catalogApps()).find((a) => a.appId.toLowerCase() === appId.toLowerCase());
  if (!app) throw new Error(`the catalog has no app ${appId} (delisted?)`);
  const versions = await readVersions(app.appId, app.versionCount);
  let vi;
  if (rest[1] !== undefined) {
    vi = versions.findIndex((v) => v.version === rest[1] && !v.yanked);
    if (vi < 0) throw new Error(`app "${app.slug}" has no (un-yanked) version labeled "${rest[1]}"`);
  } else {
    vi = versions.findLastIndex((v) => !v.yanked && Number(v.approval) === 1);
    if (vi < 0) throw new Error(`app "${app.slug}" has no approved version`);
  }
  const ver = versions[vi];
  if (vi === curIdx) return say(`${short(id)} already runs ${app.slug}:${ver.version} (version index ${vi}); nothing to do`);
  if (Number(ver.approval) !== 1)
    throw new Error(`${app.slug}:${ver.version} is ${APPROVAL_WORD[Number(ver.approval)]}; runners only serve approved versions`);
  // the deployment's bought shares are immutable — the new version must fit them
  let pricing = null;
  try { pricing = await api("GET", "/v1/pricing"); } catch {}
  const mins = minShares(ver, pricing);
  if (Number(d.gpuMilli) < mins.gpuMilli || Number(d.cpuMilli) < mins.cpuMilli)
    throw new Error(`${app.slug}:${ver.version} needs at least gpu ${mins.gpuMilli / 10}% / cpu ${mins.cpuMilli / 10}% on the fleet's hardware, `
                  + `but ${short(id)} bought gpu ${Number(d.gpuMilli) / 10}% / cpu ${Number(d.cpuMilli) / 10}% and shares are immutable - `
                  + `deploy it fresh instead: enclave deploy ${app.slug}:${ver.version} --fund 5`);
  // the publisher-fee snapshot is as immutable as the shares: a version asking
  // MORE than the deployment snapshotted at create could never pay its
  // publisher, so every runner refuses the switch - fail here with words
  const newFee = await versionFee6(app.appId, vi);
  if (newFee > 0n) {
    const [snapTo, snapFee] = rev >= 4
      ? await read(DEFAULTS.DEPLOYMENTS_ADDRESS, abi, "feeOf", [id])
      : ["0x0000000000000000000000000000000000000000", 0n];
    if (snapFee < newFee || snapTo.toLowerCase() !== app.publisher.toLowerCase())
      throw new Error(`${app.slug}:${ver.version} charges a ${usd6(newFee * 3600n)}/h publisher fee, above the ${usd6(snapFee * 3600n)}/h `
                    + `this deployment snapshotted at create - the fee snapshot is immutable, like the shares; `
                    + `deploy it fresh instead: enclave deploy ${app.slug}:${ver.version} --fund 5`);
  }
  const from = versions[curIdx] ? `${app.slug}:${versions[curIdx].version}` : d.appRef;
  const leased = Number(d.leaseUntil) * 1000 > Date.now();
  if (!(await confirm(`switch ${short(id)} from ${from} to ${app.slug}:${ver.version}? (paid time carries over`
                    + `${leased ? "; the runner restarts the app in place within ~a minute" : ""})`))) return say("aborted");
  await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi,
    functionName: "setAppRef", args: [id, `catalog://${app.appId}/${vi}`] });
  // nudge the fleet: relaunches queued/suspended work promptly (a running
  // instance is restarted by its own runner's next ledger pass)
  const h = await api("POST", "/v1/claim-hint", { body: { id } }).catch(() => null);
  if (opt.json) return jout({ id, appRef: `catalog://${app.appId}/${vi}`, version: ver.version, hint: h });
  say(`switched to ${app.slug}:${ver.version}${leased
    ? " - the runner restarts the app in place within a minute (paid time and the endpoint carry over)"
    : " - it launches on the new version when claimed"}; watch: enclave status ${short(id)}`);
}

async function cmdDeploy(rest) {
  const account = loadKey();
  const f = flags(rest, {
    val: ["--gpu", "--cpu", "--fund", "--fund-eth", "--port", "--ports", "--config-cid", "--waf", "--config",
          "--secrets", "--secrets-file"],
    bool: ["--private", "--public", "--no-wait"],
  });
  if (!f._[0]) throw new Error("usage: enclave deploy <app> [--gpu 0..1] [--cpu 0..1] --fund <usd> [flags]");
  const { ref, ver, app } = await resolveAppRef(f._[0]);

  // shares: fractions of one GPU card / one node (1 = the whole thing). When
  // omitted, use the app's minimum on the fleet's hardware (same formula the
  // runners enforce) so `enclave deploy hello-world:1 --fund 2` just works.
  let pricing = null;
  try { pricing = await api("GET", "/v1/pricing"); } catch {}
  const mins = ver ? minShares(ver, pricing) : { gpuMilli: 0, cpuMilli: 50 };
  let gpuMilli = f.gpu !== undefined ? Math.round(numFlag(f.gpu, "--gpu") * 1000) : mins.gpuMilli;
  let cpuMilli = f.cpu !== undefined ? Math.round(numFlag(f.cpu, "--cpu") * 1000) : Math.max(mins.cpuMilli, 10);
  if (gpuMilli > 1000 || cpuMilli > 1000) throw new Error("--gpu/--cpu are fractions of one card/node (0..1)");
  if (cpuMilli < 1) cpuMilli = 10;
  if (gpuMilli > 0 && gpuMilli < cpuMilli) gpuMilli = cpuMilli; // contract: gpuMilli >= cpuMilli
  if (f.gpu === undefined && f.cpu === undefined && ver)
    trace(`shares from app specs: gpu ${gpuMilli / 10}% cpu ${cpuMilli / 10}% (override with --gpu/--cpu)`);

  const portsCsv = f.ports !== undefined ? f.ports : (ver?.ports || "");
  const httpEntry = portsCsv.split(",").map((s) => s.trim()).find((s) => /^http:/i.test(s));
  const appPort = f.port !== undefined ? parseInt(f.port, 10)
    : httpEntry ? parseInt(httpEntry.split(":")[1], 10) : 8080;
  const isPublic = f.private ? false : true;
  // configCid as a CID is RETIRED: the appRef names the catalog version RECORD
  // and the enclave applies that version's config (approved with it) straight
  // from the chain. The create() field carries only the deployment-options
  // ENVELOPE — {"waf":{…}} (per-IP rate limit + request filter) and
  // {"config":{…}} (an inline app-config override for THIS deployment);
  // anything else is refused at claim.
  if (f["config-cid"])
    throw new Error("--config-cid is retired: a CID names bytes nobody validated. The version's approved config applies automatically; to run THIS deployment on a different config pass it inline: --config '{\"key\":\"value\"}'. (For the per-IP rate limit / request filter, use --waf.)");
  // --waf '{"rps":10,"burst":40,"maxBodyMb":10,"blockScanners":true,…}' — the
  // waf OBJECT; --config '{…}' — the app-config override OBJECT (the envelope
  // wrapper is added here). Shape-checked locally; the runner's claim gate is
  // the real validator and refuses unknown keys.
  const envParts = {};
  if (f.waf !== undefined) {
    let w; try { w = JSON.parse(f.waf); } catch (e) { throw new Error("--waf must be a JSON object, e.g. --waf '{\"rps\":10}': " + e.message); }
    if (!w || Array.isArray(w) || typeof w !== "object" || !Object.keys(w).length)
      throw new Error("--waf must be a non-empty JSON object, e.g. --waf '{\"rps\":10,\"blockScanners\":true}'");
    envParts.waf = w;
    say(`protection: ${JSON.stringify({ waf: w })} (per requester IP, enforced by the enclave's proxy; needs a fleet that supports the options envelope)`);
  }
  if (f.config !== undefined) {
    let c; try { c = JSON.parse(f.config); } catch (e) { throw new Error("--config must be a JSON object, e.g. --config '{\"api_key\":\"…\"}': " + e.message); }
    if (!c || Array.isArray(c) || typeof c !== "object")
      throw new Error("--config must be a JSON object — it replaces the version's config as this deployment's ENCLAVE_CONFIG (--config '{}' = explicitly empty)");
    envParts.config = c;
    // Fail closed while the tx is still unsent: a runner that predates the
    // `config` namespace refuses the claim, and a created record's envelope is
    // immutable — the deployment would sit Queued forever, its funding
    // unrecoverable. Only an unreachable aggregate falls through (same
    // information the --waf path has always had), with a loud warning.
    try {
      const av = await api("GET", "/availability");
      if (av && av.aggregate && av.configOverride !== true)
        throw new Error("the live fleet doesn't support per-deployment config overrides yet (availability.configOverride is not true) — a deployment carrying one would never be claimed. Drop --config or retry after the fleet updates.");
    } catch (e) {
      if (/doesn't support per-deployment config/.test(e.message)) throw e;
      say("! couldn't read fleet availability to confirm config-override support; if a runner predates it, this deployment will sit Queued unclaimed");
    }
    say("config override: this deployment runs on YOUR config (the version's config stays the default for every other deployment)");
  } else if (ver && ver.config) say("the version's approved config applies (from its on-chain record; override with --config '{…}')");
  const envelope = Object.keys(envParts).length ? JSON.stringify(envParts) : "";
  if (Buffer.byteLength(envelope) > 4096)
    throw new Error(`the options envelope (waf + config) is ${Buffer.byteLength(envelope)} bytes; runners refuse envelopes over 4096 bytes — trim the config override`);
  // --secrets '{"K":"V"}' / --secrets-file .env: PRIVATE env vars, staged on the
  // relay between create and the first claim so the app has them at first boot.
  // Deliberately NOT part of the on-chain envelope — the whole point is that
  // they never touch the public ledger. Parsed (and any file read) BEFORE any
  // transaction so a typo dies with $0 spent.
  let secretsSet = null;
  if (f.secrets !== undefined || f["secrets-file"] !== undefined) {
    let fromJson = {};
    if (f.secrets !== undefined) {
      try { fromJson = JSON.parse(f.secrets); } catch (e) { throw new Error("--secrets must be a JSON object of NAME: value: " + e.message); }
      if (!fromJson || Array.isArray(fromJson) || typeof fromJson !== "object" || Object.values(fromJson).some((v) => typeof v !== "string"))
        throw new Error('--secrets must be a JSON object of string values, e.g. --secrets \'{"S3_SECRET_KEY":"…"}\'');
    }
    secretsSet = { ...secretsKv([], f["secrets-file"]), ...fromJson };
    if (!Object.keys(secretsSet).length) throw new Error("--secrets/--secrets-file named no secrets");
    say(`secrets: ${Object.keys(secretsSet).length} value${Object.keys(secretsSet).length === 1 ? "" : "s"} will be staged on the relay (private; injected as env vars by the enclave, never on-chain)`);
  }

  // price it before asking for money (same snapshot formula create() applies)
  const [pricePerSec6, cpuPricePerSec6, maxGpuMilli] = await Promise.all([
    read(DEFAULTS.DEPLOYMENTS_ADDRESS,
         [{ type: "function", name: "pricePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
         "pricePerSec6"),
    read(DEFAULTS.DEPLOYMENTS_ADDRESS,
         [{ type: "function", name: "cpuPricePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
         "cpuPricePerSec6"),
    // operator-set per-deployment GPU-share cap; contracts predating it have
    // no getter (the read reverts) -> 1000 = a whole card, i.e. uncapped
    read(DEFAULTS.DEPLOYMENTS_ADDRESS,
         [{ type: "function", name: "maxGpuMilli", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }],
         "maxGpuMilli").then(Number).catch(() => 1000),
  ]);
  // create() refuses gpuMilli over the cap - fail with words, not a revert.
  // Deployer-facing copy: most users deploying an app didn't publish it, so
  // "stays publishable" means nothing to them - just say it can't run here.
  if (gpuMilli > maxGpuMilli)
    throw new Error(mins.gpuMilli > maxGpuMilli
      ? `${f._[0]} needs at least a ${mins.gpuMilli / 10}% GPU share, but the platform currently caps deployments at ${maxGpuMilli / 10}% of a card - it can't be deployed right now`
      : `--gpu ${gpuMilli / 10}% is over the platform's per-deployment GPU cap of ${maxGpuMilli / 10}% of a card - lower --gpu`);
  // The version's publisher fee is snapshotted INTO the record by create():
  // read it fresh from the catalog (fail closed - a deployment that
  // under-declares it is a record no runner will ever claim, its funding
  // unrecoverable, exactly like under-provisioned shares) and refuse
  // ledgers that predate the fee surface.
  const fee6 = ver ? await versionFee6(app.appId, Number(ref.split("/").pop())) : 0n;
  const { rev: depRev, abi: depsAbi } = await depAbi();
  if (fee6 > 0n && depRev < 4)
    throw new Error(`${f._[0]} charges a publisher fee, which the live EnclaveDeployments contract predates (deploymentsSchema < 4) - it can't be deployed until the ledger upgrade`);
  // the ledger's own bound on create()'s options field: rev <= 4 contracts cap
  // it at 100 bytes (CID-sized) and revert "configCid length" on more - the tx
  // would never mine, so refuse with words before any signature
  if (envParts.config && depRev < 5)
    throw new Error("the live EnclaveDeployments contract predates per-deployment config overrides (deploymentsSchema < 5): its create() caps the options field at 100 bytes - drop --config until the rev-5 ledger upgrade");
  const envCap = depRev >= 5 ? 4096 : 100;
  if (Buffer.byteLength(envelope) > envCap)
    throw new Error(`the options envelope is ${Buffer.byteLength(envelope)} bytes but this ledger caps the field at ${envCap} bytes (create() reverts "configCid length") - trim the ${envParts.config ? "config override" : "protection rules"}`);
  const rate = (pricePerSec6 * BigInt(gpuMilli) + cpuPricePerSec6 * BigInt(cpuMilli) + 999n) / 1000n + fee6;
  if (fee6 > 0n)
    say(`publisher fee: ${usd6(fee6 * 3600n)}/h, paid straight to ${app.publisher} out of each funding (included in the rate below)`);
  const fundUsd = f.fund !== undefined ? numFlag(f.fund, "--fund") : 0;
  const fundEth = f["fund-eth"] !== undefined ? numFlag(f["fund-eth"], "--fund-eth") : 0;
  if (!fundUsd && !fundEth)
    throw new Error(`nothing to fund it with: add --fund <usd> (rate is ${usd6(rate * 3600n)}/h; runners skip unfunded work)`);
  const eth = await pub().getBalance({ address: account.address });
  if (eth === 0n) throw new Error(`${account.address} has no Base ETH for transaction gas; bridge a little first`);
  const buys = fundUsd ? dur(fundUsd * 1e6 / Number(rate)) : `(ETH at the live rate)`;
  if (!(await confirm(`deploy ${f._[0]}: gpu ${gpuMilli / 10}% cpu ${cpuMilli / 10}% at ${usd6(rate * 3600n)}/h, `
                    + `fund ${fundUsd ? "$" + fundUsd.toFixed(2) : fundEth + " ETH"} ≈ ${buys}?`))) return say("aborted");

  // 1. create — the id is minted on-chain, read back from the Created event
  // (rev-1 contracts take a now-removed sshPubKey string before configCid;
  // rev-4 ones take the publisher-fee snapshot after it)
  const rcpt = await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: depsAbi,
    functionName: "create",
    args: [ref, gpuMilli, cpuMilli, appPort, portsCsv, isPublic, ...(depRev >= 2 ? [] : [""]), envelope,
           ...(depRev >= 4 ? [fee6 > 0n ? app.publisher : "0x0000000000000000000000000000000000000000", fee6] : [])] });
  const log = (rcpt.logs || []).find((l) => l.topics?.[0] === DEP_CREATED_TOPIC
    && l.address.toLowerCase() === DEFAULTS.DEPLOYMENTS_ADDRESS.toLowerCase());
  if (!log) throw new Error("create succeeded but no Created event in the receipt; inspect tx " + rcpt.transactionHash);
  const id = log.topics[1];
  say(`created ${id}`);

  // 1b. stage secrets BEFORE funding: claims only chase funded work, so the
  // values are on the relay before any runner can launch the app. A store
  // failure must not strand the created record — warn and keep going (the
  // owner re-runs `enclave secrets set` and restarts).
  if (secretsSet) {
    try {
      const r = await secretsCall(account, id, JSON.stringify({ set: secretsSet }));
      say(`secrets staged (rev ${r.rev}): ${r.names.join(", ")}`);
      await secretsFleetWarn();
    } catch (e) {
      say(`! secrets NOT stored (${e.message}) — the app launches without them; retry with: enclave secrets set ${id} … --restart`);
    }
  }

  // 2. fund (separate tx — the deployment already exists; if this fails it's inert, not lost)
  try {
    if (fundUsd) await fundUsdc(account, id, fundUsd);
    else await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: (await depAbi()).abi,
      functionName: "fundEth", args: [id], value: parseEther(String(fundEth)) });
  } catch (e) {
    // Echo back the asset the user actually chose (don't flip ETH -> USDC).
    const hint = fundUsd ? `--usdc ${fundUsd}` : `--eth ${fundEth}`;
    throw new Error(`created but NOT funded (${e.message}); top up later: enclave fund ${id} ${hint}`);
  }
  say(`funded ${fundUsd ? "$" + fundUsd.toFixed(2) : fundEth + " ETH"}`);

  // 3. nudge the fleet (advisory; the ~60s sweep would find it anyway)
  try {
    const h = await api("POST", "/v1/claim-hint", { body: { id } });
    if (h.accepted === false && h.reason) say(`claim-hint declined: ${h.reason} (the sweep may still claim it)`);
  } catch {}

  if (f["no-wait"]) return say(opt.json ? JSON.stringify({ id, url: appUrl(id) }) : `not waiting; check: enclave status ${id}`);

  // 4. wait: ledger lease first, then the runner's own status
  say("waiting for an enclave to claim…");
  let claimed = null;
  for (let i = 0; i < 90 && !claimed; i++) {
    await sleep(2000);
    const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, (await depAbi()).abi, "get", [id]).catch(() => null);
    if (d && !/^0x0+$/.test(d.runner) && Number(d.leaseUntil) * 1000 > Date.now()) claimed = d;
  }
  if (!claimed) throw new Error(`no enclave claimed it yet (still queued; funded work is retried every sweep); watch: enclave status ${id}`);
  say(`claimed by ${short(claimed.runner)} (operator ${claimed.runnerOperator})`);
  const done = { running: 1, failed: 1, terminated: 1, expired: 1 };
  let rec = null;
  for (let i = 0; i < 180; i++) {
    rec = await api("GET", `/v1/deployments/${id}`, { auth: account, ok404: true });
    if (rec && done[rec.status]) break;
    await sleep(2500);
  }
  if (!rec || rec.status !== "running")
    throw new Error(`deployment is "${rec?.status || "unknown"}"; logs: enclave logs ${id}`);
  if (opt.json) return jout({ id, status: rec.status, url: appUrl(id) });
  say(`running at ${appUrl(id)}`);
  say(`verify before sending data: enclave attest ${id}`);
}

async function cmdPublish(rest) {
  const account = loadKey();
  const f = flags(rest, { val: ["--slug", "--name", "--desc", "--version", "--mem", "--cpu-gflops",
                                "--vram", "--gpu-gflops", "--ports", "--config", "--fee"] });
  const file = f._[0];
  if (!file || !f.slug) throw new Error("usage: enclave publish <app.wasm> --slug <slug> [--name --desc --version --mem MB --cpu-gflops N --vram MB --gpu-gflops N --ports CSV --config JSON --fee $/hr]");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(f.slug)) throw new Error("slug: lowercase letters, digits, hyphens (max 40)");
  // --config = the app's default/template ENCLAVE_CONFIG (deploy consoles pre-fill from it)
  if (f.config){
    if (Buffer.byteLength(f.config) > 4096) throw new Error("--config too long (≤ 4096 bytes)");
    let o; try { o = JSON.parse(f.config); } catch (e) { throw new Error("--config isn't valid JSON: " + e.message); }
    if (!o || Array.isArray(o) || typeof o !== "object") throw new Error("--config must be a JSON object");
  }
  const bytes = fs.readFileSync(file);
  // same gate the IPFS gateway and runners apply: a wasi:http *component*
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100)
    throw new Error(`${file} is not a wasm binary (bad magic)`);
  const layer = bytes[6] | (bytes[7] << 8);
  if (layer === 0) throw new Error(`${file} is a core wasm module, not a component; build for wasm32-wasip2 (cargo component / componentize)`);
  if (layer !== 1) throw new Error(`${file} has unrecognized wasm layer ${layer} (expected a component)`);

  // version defaults to the next integer for your app (labels are free-form, matched exactly on deploy)
  let version = f.version;
  const appId = await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "appIdOf", [account.address, f.slug]);
  const existing = Number(await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "numVersions", [appId]).catch(() => 0n));
  if (!version) version = String(existing + 1);

  const res = [Math.round(numFlag(f.vram, "--vram") ?? 0), Math.round(numFlag(f["gpu-gflops"], "--gpu-gflops") ?? 0),
               Math.round(numFlag(f.mem, "--mem") ?? 256), Math.round(numFlag(f["cpu-gflops"], "--cpu-gflops") ?? 10)];

  // --fee = YOUR hourly fee in USD, stored on-chain as USDC 6dp per SECOND.
  // Deployers' fundings pay it straight to your publisher wallet, pro-rata;
  // immutable per version and covered by the owner's approval, like ports.
  const feeUsdHr = numFlag(f.fee, "--fee") ?? 0;
  if (feeUsdHr < 0) throw new Error("--fee can't be negative");
  const feePerSec6 = BigInt(Math.round(feeUsdHr * 1e6 / 3600));
  if (feePerSec6 > 0n) {
    if ((await catRev()) < 5)
      throw new Error("--fee needs the rev-5 catalog (this one predates publisher fees) - publish free, or wait for the catalog upgrade");
    const max = await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "maxFeePerSec6", []);
    if (feePerSec6 > max)
      throw new Error(`--fee ${feeUsdHr} is over the platform's cap of ${usd6(max * 3600n)}/h - lower it`);
  }
  if (!(await confirm(`publish ${file} (${(bytes.length / 1048576).toFixed(1)} MB) as ${f.slug}:${version} `
                    + `res=[vram ${res[0]}MB, gpu ${res[1]}Gf, mem ${res[2]}MB, cpu ${res[3]}Gf]`
                    + (feePerSec6 > 0n ? ` fee=${usd6(feePerSec6 * 3600n)}/h to ${account.address}` : "") + `?`))) return say("aborted");

  // 1. pin to IPFS. The gateway requires a WALLET-AUTHORIZED token (closes the
  //    open-pin storage DoS): sign enclave-upload:<sha256>:<expiry>, trade it at
  //    the API for a one-time token, then upload the bytes carrying it.
  const upUrl = DEFAULTS.ipfsUpload;
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const signature = await account.signMessage({ message: `enclave-upload:${hash}:${expiry}` });
  const tok = await api("POST", "/v1/apps/upload-token", { body: { hash, expiry, signature } });
  if (!tok || !tok.token) throw new Error("upload authorization failed");
  trace(`curl -sX POST ${upUrl} -H 'content-type: application/wasm' -H 'x-upload-token: …' --data-binary @${file}`);
  const up = await fetch(upUrl, { method: "POST", body: bytes, headers: { "content-type": "application/wasm",
    "x-upload-address": tok.address, "x-upload-expiry": String(expiry), "x-upload-token": tok.token } });
  const upBody = await up.text();
  if (!up.ok) throw new Error(`IPFS upload failed (${up.status}): ${upBody.slice(0, 200)}`);
  const cid = JSON.parse(upBody).cid;
  say(`pinned ipfs://${cid}`);

  // 2. cut the catalog version (publisher = your address; appId = keccak(publisher, slug))
  // --config rides rev-4 catalogs as the version's default/template ENCLAVE_CONFIG
  const rev = await catRev();
  if (f.config && rev < 4) throw new Error("--config needs the rev-4 catalog (this one doesn't store per-version configs)");
  const args = [f.slug, f.name || f.slug, f.desc || "", version, cid, res, f.ports || ""];
  if (rev >= 3) args.push(f.config || "");   // rev 3+ take the 8-arg form (rev 3 stores it app-level; we always pass "")
  if (rev >= 5) args.push(feePerSec6);       // rev 5+ take the 9-arg form (the version's publisher fee; 0 = free)
  const rcpt = await sendTx(account, { address: DEFAULTS.APP_CATALOG_ADDRESS, abi: CATALOG_ABI,
    functionName: "publishVersion", args });
  if (opt.json) return jout({ slug: f.slug, version, cid, appId, tx: rcpt.transactionHash, approval: "pending" });
  say(`published ${f.slug}:${version} (tx ${rcpt.transactionHash})`);
  say(`approval is pending (runners only claim approved versions); deploy once approved:`);
  say(`  enclave deploy ${f.slug}:${version} --fund 2`);
}

async function cmdApps(rest) {
  const q = (rest[0] || "").toLowerCase();
  let apps = await catalogApps();
  if (q) apps = apps.filter((a) => (a.slug + " " + a.name + " " + a.description).toLowerCase().includes(q));
  const rows = [];
  for (const a of apps.slice(0, 50)) {
    const versions = a.versionCount ? await readVersions(a.appId, a.versionCount) : [];
    const latest = [...versions].reverse().find((v) => !v.yanked);
    rows.push({ slug: a.slug, name: a.name, publisher: a.publisher.slice(0, 10) + "…",
                version: latest ? latest.version : "-",
                approval: latest ? APPROVAL_WORD[Number(latest.approval)] : "",
                active: a.active ? "" : "inactive",
                versions, app: a });
  }
  if (opt.json) return jout({ apps: rows.map(({ app, versions, ...r }) => ({ ...r, appId: app.appId,
    versions: versions.map((v) => ({ version: v.version, cid: v.cid, approval: APPROVAL_WORD[Number(v.approval)], yanked: v.yanked })) })) });
  table(rows, [{ h: "app", f: (r) => r.slug + ":" + r.version }, { h: "name", k: "name" },
               { h: "publisher", k: "publisher" }, { h: "approval", k: "approval" }, { h: "", k: "active" }]);
  if (apps.length > 50) say(`(+${apps.length - 50} more; narrow with: enclave apps <query>)`);
}

async function cmdPricing() {
  const p = await api("GET", "/v1/pricing");
  if (opt.json) return jout(p);
  kv([
    p.card ? ["gpu card", `${usd6(BigInt(Math.round((p.card.wholeCardPerSecondUsdc || 0) * 1e6)) * 3600n)}/h whole card (${p.card.vramGb} GB, ${p.card.tflops} TFLOPS${p.card.count ? `, ${p.card.count} cards` : ""})`] : null,
    p.node ? ["cpu node", `${usd6(BigInt(Math.round((p.node.wholeNodePerSecondUsdc || 0) * 1e6)) * 3600n)}/h whole node (${p.node.vcpus} vcpus, ${p.node.ramGb} GB)`] : null,
    ["granularity", p.computeGranularity
      ? `${p.computeGranularity.step || 1}% share steps${p.computeGranularity.minPercent ? `, min ${p.computeGranularity.minPercent}%` : ""}`
      : "1% shares"],
    ["billing", `per ${p.billingIncrementSeconds || 1}s, on-chain balance`],
    p.ethUsd ? ["eth quote", `$${p.ethUsd} (Chainlink, for --fund-eth)`] : null,
    ["contract", p.deploymentsContract], ["chain", String(p.chainId)],
  ]);
  for (const ex of p.examples || []) {
    if (ex.gpuShare === undefined) { say(`  e.g. ${ex.description || JSON.stringify(ex)}`); continue; }
    say(`  e.g. --gpu ${ex.gpuShare} --cpu ${ex.cpuShare}  ->  $${ex.ratePerHourUsdc}/h`
      + (ex.vramGb ? `  (${ex.vramGb} GB vram, ${ex.vcpus} vcpus, ${ex.ramGb} GB ram)` : ""));
  }
}

async function cmdAvailability() {
  const a = await api("GET", "/availability");
  if (opt.json) return jout(a);
  if (a.aggregate) {
    kv([["fleet", `${a.enclaves} live enclave(s)`],
        ["best gpu slice", a.gpuShareFree != null ? Math.round(a.gpuShareFree * 100) + "% of a card" : "none"],
        ["best cpu pool", a.cpuShareFree != null ? Math.round(a.cpuShareFree * 100) + "% of a node" : "none"],
        a.gpuEnclaveCpuShareFree != null ? ["gpu-node cpu", Math.round(a.gpuEnclaveCpuShareFree * 100) + "% (rides with gpu work)"] : null]);
  } else {
    kv([["enclave", a.type || (a.gpu ? "gpu" : "cpu")],
        ["gpu free", a.gpu ? `${Math.round((a.gpuShareFree || 0) * 100)}% (${a.vramFreeGb ?? "?"} GB vram)` : "no gpu"],
        ["cpu free", `${Math.round((a.cpuShareFree || 0) * 100)}% (${a.vcpusFree ?? "?"} vcpus, ${a.ramGbFree ?? "?"} GB)`],
        ["updated", a.updatedAt]]);
  }
}

async function cmdGpu() {
  const g = await api("GET", "/v1/gpu").catch((e) => {
    if (/404/.test(e.message)) return null;
    throw e;
  });
  if (!g) return say("this enclave has no GPU (CPU-only); try --base against the GPU enclave, or `enclave availability`");
  if (opt.json) return jout(g);
  const c = g.capacity || {};
  kv([["role", g.role], ["mps", g.mpsActive ? "active" : "off"],
      c.gpuShareFree != null ? ["gpu free", `${Math.round(c.gpuShareFree * 100)}%${c.vramFreeGb != null ? ` (${c.vramFreeGb} GB vram, ${c.smFree ?? "?"} SMs)` : ""}`] : null,
      ["sm total", g.smTotal != null ? String(g.smTotal) : undefined],
      ["tenants", String((g.tenants || []).length)]]);
  for (const t of g.tenants || []) say(`  ${t.pct}% ${t.status}${t.smGranted ? ` (${t.smGranted} SMs)` : ""}`);
}

async function cmdAccount() {
  const account = loadKey({ required: false });
  const acctTok = accountToken({ required: false });
  if (!account && !acctTok)
    throw new Error("no wallet key and no account session. Run `enclave key new` (wallet) or `enclave login` (Enclave account/passkey)");
  const out = {}, rows = [];
  if (account) {
    const a = await api("GET", "/v1/account", { auth: account });
    out.wallet = a;
    rows.push(["address", a.address], ["chain", String(a.chainId)],
      ["forwarder", a.payment?.forwarder], ["usdc", a.payment?.usdc],
      ["assets", (a.payment?.assets || []).join(", ")],
      ["running", String(a.deployments?.running ?? 0)],
      ["total", String(a.deployments?.total ?? 0)],
      ["funded time", dur(a.deployments?.totalTimeRemainingSec || 0)]);
  }
  if (acctTok) {
    const me = await api("GET", "/v1/account/me", { auth: "account" });
    out.account = me;
    rows.push(["account", me.accountId],
      ["sign-in", `${me.passkeys?.length || 0} passkey(s)`
        + (me.wallets?.length ? `, wallets ${me.wallets.join(", ")}` : "")],
      ["since", me.createdAt]);
    // credit + the account's deployments ride along when the relay serves them
    try {
      const v = await api("GET", "/v1/billing/vault", { auth: "account" });
      out.account.credit = { balanceUsd: v.balanceUsd, capUsd: v.capUsd, vault: v.address };
      rows.push(["credit", `$${v.balanceUsd} of $${v.capUsd} (vault ${v.address})`]);
    } catch (e) {
      if (/no_vault_key|409/.test(e.message)) rows.push(["credit", "none (add a passkey on enclave.host to use credit)"]);
    }
    try {
      const d = await api("GET", "/v1/billing/deployments", { auth: "account" });
      out.account.deployments = (d.deployments || []).length;
      rows.push(["deployments", String((d.deployments || []).length) + " via this account (enclave ls)"]);
    } catch {}
  }
  if (opt.json) return jout(out.wallet && !out.account ? out.wallet : out);
  kv(rows);
}

// ---- per-deployment secrets ---------------------------------------------------
// Env-var-shaped private values (S3 keys, API tokens) stored on the API RELAY,
// never on the public chain: the enclave holding the deployment's lease pulls
// the current set at every app start and injects each entry as a guest env
// var (same visibility class as ENCLAVE_CONFIG — the app can read them, and
// an app that prints them puts them in its own owner-readable log). Owner ops
// are single-use personal_sign signatures over canonical strings (no session;
// the relay checks the signer against the deployment's ON-CHAIN owner):
//   put: enclave-secrets:put:<id>:<expiry>:<sha256hex(payload)>
//        payload = the EXACT JSON string sent as body.payload ({set?,del?,clear?})
//   get: enclave-secrets:get:<id>:<expiry>
// A running app picks changes up on its next start; --restart applies now.
const secretsPutMsg = (id, expiry, payload) =>
  `enclave-secrets:put:${id}:${expiry}:${crypto.createHash("sha256").update(payload, "utf8").digest("hex")}`;
const secretsGetMsg = (id, expiry) => `enclave-secrets:get:${id}:${expiry}`;
async function secretsCall(account, id, payload) {           // payload null = read-back
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const message = payload == null ? secretsGetMsg(id, expiry) : secretsPutMsg(id, expiry, payload);
  const signature = await account.signMessage({ message });
  return api("POST", `/v1/secrets/${id}${payload == null ? "/get" : ""}`,
             { body: payload == null ? { expiry, signature } : { payload, expiry, signature } });
}
// KEY=VALUE args + optional .env file (# comments, blank lines, `export ` prefix).
// dotenv-style quoting: KEY="value" / KEY='value' strip one layer of matched
// quotes ('single' literal, "double" unescapes \" and \\); bare values pass
// through. `secrets ls --show` prints the same canonical quoted form, so its
// output is valid input here. The quotes are a client convention - the relay
// stores the unquoted value.
const secretsUnq = (v) => {
  const dq = /^"([\s\S]*)"$/.exec(v); if (dq) return dq[1].replace(/\\(["\\])/g, "$1");
  const sq = /^'([\s\S]*)'$/.exec(v); if (sq) return sq[1];
  return v;
};
const secretsQuo = (v) => '"' + String(v).replace(/(["\\])/g, "\\$1") + '"';
function secretsKv(pairs, file) {
  const set = {};
  const add = (line, from) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`${from}: "${line.length > 40 ? line.slice(0, 37) + "…" : line}" is not KEY=VALUE`);
    set[m[1]] = secretsUnq(m[2]);
  };
  for (const p of pairs) add(p, "argument");
  if (file) {
    for (let line of fs.readFileSync(file, "utf8").split("\n")) {
      line = line.trim().replace(/^export\s+/, "");
      if (!line || line.startsWith("#")) continue;
      add(line, file);
    }
  }
  return set;
}
// after a successful store, one advisory availability probe: the relay accepted
// the secrets, but only an up-to-date FLEET injects them (fleet-AND flag)
async function secretsFleetWarn() {
  try {
    const av = await api("GET", "/availability");
    if (av && av.aggregate && av.secrets !== true)
      say("! stored on the relay, but the live fleet doesn't inject secrets yet (availability.secrets is not true) — they apply once the fleet updates");
  } catch {}
}
async function cmdSecrets(rest) {
  const sub = rest.shift();
  const usage = "usage: enclave secrets set <id> KEY=VALUE… [--file .env] [--restart]\n"
              + "     | enclave secrets ls <id> [--show]\n"
              + "     | enclave secrets rm <id> KEY… [--restart]\n"
              + "     | enclave secrets clear <id> [--restart]";
  if (!["set", "ls", "list", "rm", "clear"].includes(sub || "")) throw new Error(usage);
  const f = flags(rest, { bool: ["--show", "--restart"], val: ["--file"] });
  if (!f._[0]) throw new Error(usage);
  const account = loadKey();
  const id = await resolveId(f._[0], account);
  if (!isB32(id)) throw new Error("secrets need an on-chain deployment (bytes32 id)");
  const kvArgs = f._.slice(1);

  let r;
  if (sub === "set") {
    const set = secretsKv(kvArgs, f.file);
    if (!Object.keys(set).length) throw new Error("nothing to set: pass KEY=VALUE arguments and/or --file .env");
    r = await secretsCall(account, id, JSON.stringify({ set }));
    say(`stored ${Object.keys(set).length} secret${Object.keys(set).length === 1 ? "" : "s"} (rev ${r.rev}): ${r.names.join(", ")}`);
    await secretsFleetWarn();
  } else if (sub === "rm") {
    if (!kvArgs.length) throw new Error("usage: enclave secrets rm <id> KEY [KEY…]");
    r = await secretsCall(account, id, JSON.stringify({ del: kvArgs }));
    say(r.names.length ? `removed; ${r.names.length} left (rev ${r.rev}): ${r.names.join(", ")}` : "removed; no secrets left");
  } else if (sub === "clear") {
    if (!(await confirm(`clear ALL secrets on ${short(id)}?`))) return say("aborted");
    r = await secretsCall(account, id, JSON.stringify({ clear: true }));
    say("cleared");
  } else {                                                   // ls
    r = await secretsCall(account, id, null);
    if (opt.json) return jout(f.show ? r : { ...r, env: undefined });
    if (!r.names.length) return say(`no secrets stored for ${short(id)} (set some: enclave secrets set ${short(id)} KEY=VALUE)`);
    say(`rev ${r.rev} · ${r.updatedAt || ""}`.trim());
    for (const n of r.names) say(f.show ? `${n}=${secretsQuo(r.env[n])}` : `${n}  (${Buffer.byteLength(r.env[n], "utf8")} bytes; --show to reveal)`);
    return;
  }
  if (opt.json) return jout(r);
  if (f.restart) {
    const rr = await api("POST", `/v1/deployments/${id}/restart`, { auth: account })
      .catch((e) => ({ error: e.message }));
    say(rr.error ? `restart failed: ${rr.error} (a queued/stopped app applies them when it next starts)`
                 : "restarted — the app now runs with the new secrets");
  } else if (sub !== "clear") {
    say("a running app applies them on its next start: enclave restart " + short(id));
  }
}

// ---- encrypted volumes: wallet key derivation + credentials envelope ----------
// BYTE-EXACT contract shared with scripts/enclave-encvol.sh and the
// encrypted-volumes app's JS, pinned by test/encvol-e2e.py stage 3:
//   password/salt = sha256_hex( sig + "\n" + "enclave-encvol-v1:password"/":salt" )
//   envelope      = "encv1:" + base64( iv[16] || AES-256-CTR(encKey, iv, credsJSON) || HMAC-SHA256(macKey, iv||ct)[32] )
//   encKey/macKey = sha256( sig + "\n" + "enclave-encvol-v1:creds-enc"/":creds-mac" )
// The envelope rides the PUBLIC App Config as "credsEnvelope"; it is exactly
// as sensitive as the volume itself (the same wallet guards both).
const encvolMessage = (keyId) =>
  `Enclave encrypted volume key v1\nvolume: ${keyId}\n\nSigning derives this volume's encryption key. Only sign in apps you trust with its contents.`;
const encvolSha = (s) => crypto.createHash("sha256").update(s).digest();

// --sig passes a personal_sign from any wallet through; otherwise the CLI
// wallet signs the canonical message itself (viem signs deterministically -
// RFC 6979 - so the same key always derives the same volume key).
async function encvolSig(f) {
  let sig = (f.sig || env.ENCVOL_WALLET_SIG || "").trim().toLowerCase();
  if (!sig) {
    const keyId = f["key-id"];
    if (!keyId) throw new Error("need --key-id <keyId> (sign with the CLI wallet) or --sig 0x… (a personal_sign made anywhere else)");
    sig = (await loadKey().signMessage({ message: encvolMessage(keyId) })).toLowerCase();
  }
  if (!/^0x[0-9a-f]{130}$/.test(sig)) throw new Error("signature must be 65-byte ECDSA hex (0x + 130 hex chars)");
  return sig;
}

async function cmdEncvol(rest) {
  const sub = rest.shift();
  const f = flags(rest, { val: ["--key-id", "--sig", "--access-key", "--secret-key", "--session-token"] });
  if (sub === "message") {
    const keyId = f["key-id"] || f._[0];
    if (!keyId) throw new Error("usage: enclave encvol message <keyId>");
    return say(encvolMessage(keyId));
  }
  if (sub === "derive") {
    const sig = await encvolSig(f);
    const password = encvolSha(sig + "\nenclave-encvol-v1:password").toString("hex");
    const salt = encvolSha(sig + "\nenclave-encvol-v1:salt").toString("hex");
    if (opt.json) return jout({ sig, password, salt });
    say(`export ENCVOL_PASSWORD=${password}`);
    say(`export ENCVOL_SALT=${salt}`);
    stderr.write("These decrypt the volume - treat them like the data itself.\n");
    return;
  }
  if (sub === "seal-creds") {
    const sig = await encvolSig(f);
    const accessKeyId = f["access-key"] || env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = f["secret-key"] || env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = f["session-token"] || env.AWS_SESSION_TOKEN;
    if (!accessKeyId || !secretAccessKey)
      throw new Error("seal-creds needs --access-key + --secret-key (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in the environment)");
    // ENCVOL_SEAL_IV: test hook so the pinned e2e vector is reproducible.
    const ivHex = (env.ENCVOL_SEAL_IV || "").trim();
    if (ivHex && !/^[0-9a-f]{32}$/.test(ivHex)) throw new Error("ENCVOL_SEAL_IV must be 32 lowercase hex chars");
    const iv = ivHex ? Buffer.from(ivHex, "hex") : crypto.randomBytes(16);
    const pt = JSON.stringify(sessionToken
      ? { accessKeyId, secretAccessKey, sessionToken }
      : { accessKeyId, secretAccessKey });
    const cipher = crypto.createCipheriv("aes-256-ctr", encvolSha(sig + "\nenclave-encvol-v1:creds-enc"), iv);
    const ivct = Buffer.concat([iv, cipher.update(pt, "utf8"), cipher.final()]);
    const tag = crypto.createHmac("sha256", encvolSha(sig + "\nenclave-encvol-v1:creds-mac")).update(ivct).digest();
    const envelope = "encv1:" + Buffer.concat([ivct, tag]).toString("base64");
    if (opt.json) return jout({ envelope });
    say(envelope);
    stderr.write(`\nSealed. Add "credsEnvelope" to the volume's encVolumes entry in the (public)
App Config - it is ciphertext under the SAME wallet that guards the volume:

      "unlock": "wallet",
      "credsEnvelope": "${envelope}"

One signature in the app then derives the crypt key AND opens these
credentials - no S3 fields to enter, after any restart.\n`);
    return;
  }
  throw new Error("usage: enclave encvol <message|derive|seal-creds> [--key-id K | --sig 0x…] …");
}

// ---- help + dispatch ---------------------------------------------------------------
const HELP = `enclave ${VERSION} · confidential compute from your terminal (https://enclave.host)

usage: enclave <command> [args]  [--json] [-x] [-y|--yes] [--base URL] [--rpc URL]

identity
  key new [--force]          generate a wallet key -> ${KEY_FILE}
  key import                 import a private key (hidden prompt / stdin pipe)
  login [--print]            sign in with your Enclave account (passkey) instead:
                             approve a link from your phone or any signed-in
                             browser; --print echoes the API bearer for scripts
  logout                     discard the account session token
  whoami                     wallet balances and/or account session + credit

deployments
  deploy <app> --fund <usd>  create + fund + wait until live; prints the URL
         [--gpu 0..1] [--cpu 0..1]      shares of one card / one node (default: app minimums)
         [--fund-eth <eth>] [--private] [--port N] [--ports CSV] [--no-wait]
         [--waf '{"rps":10,"burst":40,"maxBodyMb":10,"blockScanners":true}']
                                        per-IP rate limit + request filter, enforced in-enclave
         [--config '{"api_key":"…"}']   app-config override for THIS deployment: replaces the
                                        version's config as its ENCLAVE_CONFIG ('{}' = empty;
                                        the catalog default and other deployments are untouched)
         [--secrets '{"NAME":"value"}'] [--secrets-file .env]
                                        PRIVATE env vars staged on the relay (never on-chain):
                                        the enclave injects them into the app at every start
  secrets set <id> KEY=VALUE… [--file .env] [--restart]
                             store/update private env vars for a deployment (S3
                             keys etc): relay-stored, encrypted at rest, injected
                             by the lease-holding enclave; a wallet signature per
                             change, checked against the on-chain owner
  secrets ls <id> [--show]   list them (values masked without --show)
  secrets rm <id> KEY…       remove some; "secrets clear <id>" removes all
                             (--restart on any of these applies changes now)
  ls                         your deployments: live, queued and unfunded
  status <id>                one deployment: state, lease, balance, URL
  logs <id> [-f] [--tail N]  the app's stdout/stderr (-f polls)
  fund <id> --usdc 5|--eth 0.002   top up runtime by the second
  attest [<id>]              fetch attestation + verify it LOCALLY (no key needed); nonzero exit on FAIL
  restart <id>               stop + relaunch the app in place (same version,
                             endpoint and balance; app state is ephemeral) - the
                             fix for a wedged instance, no wallet tx needed
  stop <id>                  suspend: setActive(false) on-chain + DELETE the instance
                             (the remaining balance stays on the deployment)
  resume <id>                setActive(true): re-queue a stopped deployment; it
                             relaunches from its remaining balance
  upgrade <id> [<version>]   switch to another approved version of the same app
                             (default: its latest); paid time carries over - the
                             runner restarts the app in place on the new version

catalog
  publish <app.wasm> --slug S [--version V --name N --desc D --config JSON]
          [--mem MB --cpu-gflops N --vram MB --gpu-gflops N --ports CSV]
          [--fee $/hr]        your hourly fee, paid straight to your wallet out
                             of deployers' fundings (capped on-chain; immutable
                             per version and covered by approval, like ports)
  apps [query]               browse/search the on-chain catalog

encrypted volumes (rclone-crypt over S3; push data with scripts/enclave-encvol.sh)
  encvol message <keyId>     print the canonical message a wallet signs for a volume key
  encvol derive     --key-id K | --sig 0x…   volume password/salt, signed by the CLI
                             wallet (deterministic) or derived from a given signature
  encvol seal-creds --key-id K | --sig 0x…  [--access-key A --secret-key S]
                             encrypt S3 credentials (default: AWS_* env) under the wallet
                             key -> a "credsEnvelope" for the PUBLIC App Config; the app
                             then unlocks with one signature, nothing typed

platform
  pricing | availability | gpu | account

<app>  is  [publisher/]slug[:version] from the on-chain catalog (CIDs can't
       deploy: a CID names bytes, not a version; config differs per version)
<id>   is  the bytes32 deployment id (0x…), any unique 0x-prefix of it, or a legacy dep_… id

Global: --json machine output · -x print every REST call + transaction ·
--base/--rpc (ENCLAVE_API_BASE/ENCLAVE_RPC) target an enclave or your own RPC ·
ENCLAVE_KEY overrides the key file. Auth is SIWE (wallet) or an Enclave account
session (enclave login); keys never leave this machine. Account sessions read
account-provisioned/credit deployments (ls, whoami, account) but can't sign
transactions - deploying and funding by credit stays on enclave.host for now.`;

const COMMANDS = {
  key: cmdKey, login: cmdLogin, logout: cmdLogout,
  whoami: cmdWhoami, deploy: cmdDeploy, ls: cmdLs, list: cmdLs,
  status: cmdStatus, logs: cmdLogs, fund: cmdFund, attest: cmdAttest,
  restart: cmdRestart, stop: cmdStop, suspend: cmdStop, resume: cmdResume,
  upgrade: cmdUpgrade, "set-version": cmdUpgrade,
  secrets: cmdSecrets,
  publish: cmdPublish, apps: cmdApps,
  pricing: cmdPricing, availability: cmdAvailability, gpu: cmdGpu, account: cmdAccount,
  encvol: cmdEncvol,
};

// Resolve the platform's contract addresses from the on-chain address book
// before dispatch (one eth_call, hard 4s cap; baked DEFAULTS on any failure so
// offline use and tests never block; ENCLAVE_ADDRESS_BOOK="" opts out).
async function resolveAddressBook() {
  const book = env.ENCLAVE_ADDRESS_BOOK !== undefined ? env.ENCLAVE_ADDRESS_BOOK : DEFAULTS.ADDRESS_BOOK_ADDRESS;
  if (!book) return;
  try {
    const abi = [{ type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];
    const [keys, values] = await Promise.race([
      pub().readContract({ address: book, abi, functionName: "all" }),
      sleep(4000).then(() => { throw new Error("timeout"); }),
    ]);
    const map = { registry: "REGISTRY_ADDRESS", deployments: "DEPLOYMENTS_ADDRESS",
                  appCatalog: "APP_CATALOG_ADDRESS", enclavePay: "FORWARDER_ADDRESS" };
    keys.forEach((kh, i) => {
      let k = ""; for (let b = 2; b < kh.length; b += 2) { const c = parseInt(kh.slice(b, b + 2), 16); if (!c) break; k += String.fromCharCode(c); }
      const name = map[k], v = values[i];
      if (name && DEFAULTS[name] !== undefined && !/^0x0{40}$/i.test(v)) DEFAULTS[name] = v;
    });
    trace("address book " + book + " resolved");
  } catch (e) { trace("address book unresolved (" + (e?.shortMessage || e?.message) + "); baked defaults in effect"); }
}

const cmd = args.shift();
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { say(HELP); exit(0); }
if (cmd === "version" || cmd === "--version") { say(VERSION); exit(0); }
if (!COMMANDS[cmd]) die(`unknown command "${cmd}"; run: enclave help`);
// `key new`/`key import` are purely local and `login`/`logout` touch only the
// API, so skip the address-book resolve — no reason to make them wait on an RPC.
const OFFLINE = cmd === "key" || cmd === "login" || cmd === "logout";
try {
  if (!OFFLINE) await resolveAddressBook();
  await COMMANDS[cmd](args);
} catch (e) {
  die(e?.message || String(e));
}
