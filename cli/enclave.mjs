#!/usr/bin/env node
// enclave — the Enclave platform CLI. One file, wallet-native, no accounts.
//
// Every command maps 1:1 onto the public HTTP API (https://api.enclave.host/v1)
// and the on-chain contracts on Base — the CLI holds the pieces, it owns
// nothing: auth is a SIWE signature, payment is your USDC, deployments are
// EnclaveDeployments work items your key created. Run any command with -x to see
// the exact API traffic and transactions, ready to replay with curl.
//
//   enclave key new | import         bring a wallet (or ENCLAVE_KEY env)
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

const VERSION = "0.1.0";

// ---- platform constants -----------------------------------------------------
// Addresses are Base mainnet (chain 8453), kept in lockstep with
// enclaves/*/tinfoil-config.yml and site/index.html by
// scripts/sync-contract-addresses.sh — same values, one authority.
const DEFAULTS = {
  apiBase: "https://api.enclave.host",
  chainId: 8453,
  rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org",
         "https://1rpc.io/base", "https://mainnet.base.org"],
  DEPLOYMENTS_ADDRESS: "0x267f7F792CA84482698b2f6774B028522247B6CD",
  APP_CATALOG_ADDRESS: "0x21F2798A51F5970dD43A5D8fAdA48b1b8D59cc67",
  REGISTRY_ADDRESS: "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2",
  ADDRESS_BOOK_ADDRESS: "0xab214342d5A490150A4A977063A2f88E21F80907",     // EnclaveAddressBook; written by scripts/deploy-address-book.mjs — when set, the CLI resolves the addresses above from it at start ("" = baked only)
  USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ipfsUpload: env.ENCLAVE_IPFS_UPLOAD || "https://ipfs.enclave.host/add-wasm",
  appDomain: "app.enclave.host",
};

// Minimal ABIs — mirror contracts/*.abi.json (checked in, re-emitted by the
// deploy scripts); embedded so the installed binary is self-contained.
const DEPLOYMENT_TUPLE = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "sshPubKey", type: "string" }, { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
  { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
const DEPLOYMENTS_ABI = [
  { type: "function", name: "create", stateMutability: "nonpayable",
    inputs: [{ name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
             { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
             { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
             { name: "sshPubKey", type: "string" }, { name: "configCid", type: "string" }],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "fundWithAuthorization", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "from", type: "address" },
             { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
             { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
             { name: "signature", type: "bytes" }], outputs: [] },
  { type: "function", name: "fundEth", stateMutability: "payable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setActive", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "active", type: "bool" }], outputs: [] },
  { type: "function", name: "get", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: DEPLOYMENT_TUPLE }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: DEPLOYMENT_TUPLE }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "secondsFundable", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Created",
    inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
             { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
             { name: "cpuMilli", type: "uint16" }, { name: "rate", type: "uint256" }] },
];
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
const VERSION_TUPLE = [
  { name: "cid", type: "string" }, { name: "version", type: "string" },
  { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
  { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" },
  { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
  { name: "yanked", type: "bool" }, { name: "ports", type: "string" },
  { name: "approval", type: "uint8" },
];
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
];
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
    if (required) throw new Error("no wallet key. Run `enclave key new` (or `enclave key import`, or set ENCLAVE_KEY)");
    return null;
  }
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("the configured key is not a 32-byte hex private key");
  return privateKeyToAccount(pk);
}
function saveKey(pk) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, pk + "\n", { mode: 0o600 });
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
  if (opt.yes || !stdin.isTTY || !stdout.isTTY) return true;
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
  trace(`tx sent ${hash} — waiting for receipt`);
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
// api("GET", "/v1/deployments", { auth: account }) -> parsed JSON; throws on HTTP error
async function api(method, p, { body, auth, ok404, text } = {}) {
  const url = API_BASE + p;
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = "Bearer " + await bearer(auth);
  trace(`curl -s${method === "GET" ? "" : "X " + method} '${url}'`
        + (auth ? " -H 'authorization: Bearer …'" : "")
        + (body !== undefined ? ` -d '${JSON.stringify(body)}'` : ""));
  let r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
      const page = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, "getPage", [BigInt(start), 100n]);
      _pageCache.push(...page);
      if (page.length < 100) break;
    }
  }
  return owner ? _pageCache.filter((d) => d.owner.toLowerCase() === owner.toLowerCase()) : _pageCache;
}

// [publisher/]slug[:version] | bare CID | ipfs://… -> { ref, ver? } with the
// same client-side resolution + approval gate the console applies (runners
// re-check on their side; this just fails fast with a readable reason).
async function resolveAppRef(input) {
  if (/^ipfs:\/\//i.test(input) || /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{20,})$/.test(input)) {
    const cid = input.replace(/^ipfs:\/\//i, "");
    const [listed, , , approval, yanked, appActive, res] =
      await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "cidStatus", [cid]);
    if (!listed) throw new Error(`CID ${cid} is not in the catalog — publish it first (enclave publish)`);
    if (yanked) throw new Error(`CID ${cid} is yanked`);
    if (!appActive) throw new Error(`the app owning CID ${cid} is deactivated`);
    if (Number(approval) !== 1) throw new Error(`CID ${cid} is ${APPROVAL_WORD[Number(approval)] || "unapproved"} — runners only claim approved versions`);
    return { ref: "ipfs://" + cid, ver: { vramMb: res[0], gpuGflops: res[1], memMb: res[2], cpuGflops: res[3], ports: "" } };
  }
  const m = input.match(/^(?:([0-9a-zA-Z.]+|0x[0-9a-fA-F]{40})\/)?([a-z0-9][a-z0-9-]*)(?::(.+))?$/);
  if (!m) throw new Error(`"${input}" is not an app reference ([publisher/]slug[:version], a CID, or ipfs://…)`);
  const [, pubFilter, slug, verLabel] = m;
  let apps = (await catalogApps()).filter((a) => a.slug === slug && a.active);
  if (pubFilter) apps = apps.filter((a) => a.publisher.toLowerCase() === pubFilter.toLowerCase());
  if (!apps.length) throw new Error(`no active catalog app with slug "${slug}"${pubFilter ? ` by ${pubFilter}` : ""}`);
  if (apps.length > 1 && !pubFilter)
    throw new Error(`slug "${slug}" is published by ${apps.length} publishers — disambiguate as <publisher>/${slug}`);
  const app = apps[0];
  const versions = await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "getVersionsPage",
                              [app.appId, 0n, BigInt(Math.max(1, Number(app.versionCount)))]);
  let ver;
  if (verLabel !== undefined) {
    ver = versions.find((v) => v.version === verLabel && !v.yanked);
    if (!ver) throw new Error(`app "${slug}" has no (un-yanked) version labeled "${verLabel}"`);
  } else {
    ver = [...versions].reverse().find((v) => !v.yanked && Number(v.approval) === 1);
    if (!ver) throw new Error(`app "${slug}" has no approved version yet`);
  }
  if (Number(ver.approval) !== 1)
    throw new Error(`${slug}:${ver.version} is ${APPROVAL_WORD[Number(ver.approval)]} — runners only claim approved versions`);
  return { ref: "ipfs://" + ver.cid, ver, app };
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
  const value = BigInt(Math.round(amountUsd * 100)) * 10000n;   // whole cents -> 6dp
  const bal = await read(DEFAULTS.USDC_ADDRESS, ERC20_ABI, "balanceOf", [account.address]);
  if (bal < value) throw new Error(`wallet holds ${usd6(bal)} USDC on Base, needs ${usd6(value)} — fund ${account.address}`);
  let dom = null;
  try { dom = (await api("GET", "/v1/pricing")).usdcDomain; } catch {}
  const domain = dom
    ? { name: dom.name, version: dom.version, chainId: Number(dom.chainId), verifyingContract: dom.verifyingContract }
    : { name: "USD Coin", version: "2", chainId: DEFAULTS.chainId, verifyingContract: DEFAULTS.USDC_ADDRESS };
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
  await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
    functionName: "fundWithAuthorization",
    args: [id, account.address, value, 0n, validBefore, nonce, signature] });
  return value;
}

// ---- attestation verification (the real thing, run locally) ----------------------
async function verifyEnclaveOrigin(origin, repo) {
  let Verifier;
  try { ({ Verifier } = await import("@tinfoilsh/verifier")); }
  catch { throw new Error("@tinfoilsh/verifier is not installed — reinstall the CLI (npm i -g enclave-cli)"); }
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
  say(r.pass ? "verdict     PASS — measurements match the signed release; TLS terminates inside this enclave"
             : `verdict     FAIL — do not send data${r.error ? ` (${r.error})` : ""}`);
}
async function attestDeployment(account, id) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const att = await api("GET", `/v1/deployments/${id}/attestation?nonce=${nonce}`, { auth: account });
  const origin = new URL(att.verification.attestationEndpoint).origin;
  const repo = att.verification.repo;
  if (!repo) throw new Error("attestation response carries no enclave repo — cannot verify");
  return { att, nonce, origin, repo, result: await verifyEnclaveOrigin(origin, repo) };
}

// ---- commands ---------------------------------------------------------------------
async function cmdKey(rest) {
  const sub = rest[0];
  if (sub === "new") {
    const f = flags(rest.slice(1), { bool: ["--force"] });
    if (fs.existsSync(KEY_FILE) && !f.force)
      throw new Error(`${KEY_FILE} already exists — pass --force to overwrite it (this abandons the old address!)`);
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
  const account = loadKey();
  const [eth, usdc] = await Promise.all([
    pub().getBalance({ address: account.address }),
    read(DEFAULTS.USDC_ADDRESS, ERC20_ABI, "balanceOf", [account.address]),
  ]);
  let running = null;
  try {
    const ls = await api("GET", "/v1/deployments", { auth: account });
    running = (ls.data || []).filter((d) => d.status === "running").length;
  } catch {} // API being down shouldn't hide your own balances
  if (opt.json) return jout({ address: account.address, ethWei: eth, usdc6: usdc, running, keyFile: env.ENCLAVE_KEY ? "(env)" : KEY_FILE });
  kv([["address", account.address],
      ["usdc", usd6(usdc) + " (Base)"],
      ["eth", formatUnits(eth, 18).replace(/(\.\d{6})\d+$/, "$1") + " (gas)"],
      ["running", running === null ? "(api unreachable)" : String(running)],
      ["key", env.ENCLAVE_KEY ? "ENCLAVE_KEY env" : KEY_FILE]]);
}

async function cmdLs() {
  const account = loadKey();
  const [apiList, mine] = await Promise.all([
    api("GET", "/v1/deployments", { auth: account }).then((r) => r.data || []).catch(() => []),
    chainDeployments(account.address).catch(() => []),
  ]);
  const seen = new Set(apiList.map((d) => String(d.id).toLowerCase()));
  const rows = apiList.map((d) => ({
    id: d.id, app: d.image?.reference || "", status: d.status,
    shares: `${d.resources?.gpuShare ? Math.round(d.resources.gpuShare * 100) + "% gpu " : ""}${Math.round((d.resources?.cpuShare || 0) * 100)}% cpu`,
    left: d.timeRemainingSec != null ? dur(d.timeRemainingSec) : "",
    url: d.status === "running" ? appUrl(d.id) : "",
  }));
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
  const account = loadKey();
  if (!rest[0]) throw new Error("usage: enclave status <id>");
  const id = await resolveId(rest[0], account);
  const rec = await api("GET", `/v1/deployments/${id}`, { auth: account, ok404: true });
  let chainRec = null;
  if (isB32(id)) try { chainRec = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, "get", [id]); } catch {}
  if (!rec && !chainRec) throw new Error(`no deployment ${rest[0]} (not on any live enclave, not on the ledger)`);
  if (opt.json) return jout({ api: rec, chain: chainRec });
  const leased = chainRec && Number(chainRec.leaseUntil) * 1000 > Date.now();
  kv([
    ["id", id],
    ["app", rec?.image?.reference || chainRec?.appRef],
    ["status", rec?.status || (chainRec ? (!chainRec.active ? "stopped" : leased ? "claimed (no live enclave record yet)" : "queued — waiting for an enclave to claim") : null)],
    ["visibility", (rec ? rec.public : chainRec?.isPublic) ? "public" : "private (owner bearer required)"],
    rec?.resources ? ["shares", `gpu ${Math.round((rec.resources.gpuShare || 0) * 100)}% · cpu ${Math.round((rec.resources.cpuShare || 0) * 100)}%`]
                   : chainRec ? ["shares", `gpu ${Number(chainRec.gpuMilli) / 10}% · cpu ${Number(chainRec.cpuMilli) / 10}%`] : null,
    chainRec ? ["rate", `${usd6(chainRec.rate)}/s (${usd6(chainRec.rate * 3600n)}/h)`] : rec ? ["rate", `$${rec.ratePerSecondUsdc}/s`] : null,
    chainRec ? ["balance", `${usd6(chainRec.balance6)} on-chain (${dur(chainRec.rate > 0n ? Number(chainRec.balance6 / chainRec.rate) : 0)})`] : null,
    rec?.timeRemainingSec != null ? ["remaining", dur(rec.timeRemainingSec)] : null,
    leased ? ["lease", `until ${new Date(Number(chainRec.leaseUntil) * 1000).toISOString()} (runner ${short(chainRec.runner)}, operator ${chainRec.runnerOperator})`] : null,
    ["url", appUrl(id)],
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
  const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, "get", [id]);
  if (d.owner === "0x0000000000000000000000000000000000000000") throw new Error(`no deployment ${short(id)} on the ledger`);
  if (f.usdc) {
    const amt = numFlag(f.usdc, "--usdc");
    if (!(await confirm(`fund ${short(id)} with ${usd6(BigInt(Math.round(amt * 1e6)))} USDC (buys ~${dur(d.rate > 0n ? amt * 1e6 / Number(d.rate) : 0)})?`)))
      return say("aborted");
    await fundUsdc(account, id, amt);
  } else {
    const amt = numFlag(f.eth, "--eth");
    if (!(await confirm(`fund ${short(id)} with ${amt} ETH (credited at the Chainlink ETH/USD rate)?`))) return say("aborted");
    await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
      functionName: "fundEth", args: [id], value: parseEther(String(amt)) });
  }
  const fresh = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, "get", [id]);
  if (opt.json) return jout({ id, balance6: fresh.balance6, fundableSec: fresh.rate > 0n ? Number(fresh.balance6 / fresh.rate) : 0 });
  say(`balance ${usd6(fresh.balance6)} — ${dur(fresh.rate > 0n ? Number(fresh.balance6 / fresh.rate) : 0)} of runtime at ${usd6(fresh.rate * 3600n)}/h`);
}

async function cmdAttest(rest) {
  if (!rest[0]) {
    // no id: verify the enclave serving this API base (the enclave-level report)
    const att = await api("GET", "/v1/attestation");
    const origin = new URL(att.verification.attestationEndpoint).origin;
    const r = await verifyEnclaveOrigin(origin, att.verification.repo);
    if (opt.json) return jout({ origin, repo: att.verification.repo, ...r });
    printVerdict(r, origin, att.verification.repo);
    if (!r.pass) exit(1);
    return;
  }
  const account = loadKey();      // per-deployment attestation is owner-gated
  const id = await resolveId(rest[0], account);
  const { att, origin, repo, result } = await attestDeployment(account, id);
  if (opt.json) return jout({ id, origin, repo, ...result, vm: att.vm ? { technology: att.vm.technology, measurements: att.vm.measurements } : null, gpu: att.gpu ? { ccMode: att.gpu.ccMode, nonce: att.gpu.nonce } : null });
  kv([["deployment", id], att.app?.digest ? ["app digest", att.app.digest] : null]);
  printVerdict(result, origin, repo);
  if (att.vm?.technology) say(`vm          ${att.vm.technology} quote present (registers in --json)`);
  if (att.gpu) say(`gpu         CC report ${att.gpu.report ? "present" : "absent"}${att.gpu.ccMode ? `, ccMode=${att.gpu.ccMode}` : ""}${att.gpu.nonce ? `, signed over our nonce` : ""}`);
  if (!result.pass) exit(1);
}


async function cmdStop(rest) {
  const account = loadKey();
  if (!rest[0]) throw new Error("usage: enclave stop <id>");
  const id = await resolveId(rest[0], account);
  if (!(await confirm(`stop ${short(id)}? (terminates the app; on-chain balance is spent, not refunded)`))) return say("aborted");
  if (isB32(id)) {
    // take the work item off the queue first so no enclave re-claims it…
    const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, "get", [id]).catch(() => null);
    if (d && d.active && d.owner.toLowerCase() === account.address.toLowerCase())
      await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
        functionName: "setActive", args: [id, false] });
  }
  // …then tear down the running instance (the runner also notices ActiveSet on
  // its next sweep; DELETE just makes it immediate)
  const r = await api("DELETE", `/v1/deployments/${id}`, { auth: account, ok404: true });
  if (opt.json) return jout(r || { id, status: "stopped", note: "ledger item deactivated; no live enclave record" });
  say(r ? `${r.status}${r.ranSeconds ? ` after ${dur(r.ranSeconds)}` : ""}${r.note ? ` — ${r.note}` : ""}`
        : "deactivated on-chain; no enclave was serving it");
}

async function cmdDeploy(rest) {
  const account = loadKey();
  const f = flags(rest, {
    val: ["--gpu", "--cpu", "--fund", "--fund-eth", "--port", "--ports", "--ssh-key", "--config-cid"],
    bool: ["--private", "--public", "--no-wait"],
  });
  if (!f._[0]) throw new Error("usage: enclave deploy <app> [--gpu 0..1] [--cpu 0..1] --fund <usd> [flags]");
  const { ref, ver } = await resolveAppRef(f._[0]);

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
  const sshPubKey = f["ssh-key"] ? fs.readFileSync(f["ssh-key"], "utf8").trim() : "";
  const configCid = f["config-cid"] || "";

  // price it before asking for money (same snapshot formula create() applies)
  const [pricePerSec6, cpuPricePerSec6] = await Promise.all([
    read(DEFAULTS.DEPLOYMENTS_ADDRESS,
         [{ type: "function", name: "pricePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
         "pricePerSec6"),
    read(DEFAULTS.DEPLOYMENTS_ADDRESS,
         [{ type: "function", name: "cpuPricePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
         "cpuPricePerSec6"),
  ]);
  const rate = (pricePerSec6 * BigInt(gpuMilli) + cpuPricePerSec6 * BigInt(cpuMilli) + 999n) / 1000n;
  const fundUsd = f.fund !== undefined ? numFlag(f.fund, "--fund") : 0;
  const fundEth = f["fund-eth"] !== undefined ? numFlag(f["fund-eth"], "--fund-eth") : 0;
  if (!fundUsd && !fundEth)
    throw new Error(`nothing to fund it with — add --fund <usd> (rate is ${usd6(rate * 3600n)}/h; runners skip unfunded work)`);
  const eth = await pub().getBalance({ address: account.address });
  if (eth === 0n) throw new Error(`${account.address} has no Base ETH for transaction gas — bridge a little first`);
  const buys = fundUsd ? dur(fundUsd * 1e6 / Number(rate)) : `(ETH at the live rate)`;
  if (!(await confirm(`deploy ${f._[0]} — gpu ${gpuMilli / 10}% cpu ${cpuMilli / 10}% at ${usd6(rate * 3600n)}/h, `
                    + `fund ${fundUsd ? "$" + fundUsd.toFixed(2) : fundEth + " ETH"} ≈ ${buys}?`))) return say("aborted");

  // 1. create — the id is minted on-chain, read back from the Created event
  const rcpt = await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
    functionName: "create",
    args: [ref, gpuMilli, cpuMilli, appPort, portsCsv, isPublic, sshPubKey, configCid] });
  const log = (rcpt.logs || []).find((l) => l.topics?.[0] === DEP_CREATED_TOPIC
    && l.address.toLowerCase() === DEFAULTS.DEPLOYMENTS_ADDRESS.toLowerCase());
  if (!log) throw new Error("create succeeded but no Created event in the receipt — inspect tx " + rcpt.transactionHash);
  const id = log.topics[1];
  say(`created ${id}`);

  // 2. fund (separate tx — the deployment already exists; if this fails it's inert, not lost)
  try {
    if (fundUsd) await fundUsdc(account, id, fundUsd);
    else await sendTx(account, { address: DEFAULTS.DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
      functionName: "fundEth", args: [id], value: parseEther(String(fundEth)) });
  } catch (e) {
    throw new Error(`created but NOT funded (${e.message}) — top up later: enclave fund ${id} --usdc ${fundUsd || 5}`);
  }
  say(`funded ${fundUsd ? "$" + fundUsd.toFixed(2) : fundEth + " ETH"}`);

  // 3. nudge the fleet (advisory; the ~60s sweep would find it anyway)
  try {
    const h = await api("POST", "/v1/claim-hint", { body: { id } });
    if (h.accepted === false && h.reason) say(`claim-hint declined: ${h.reason} (the sweep may still claim it)`);
  } catch {}

  if (f["no-wait"]) return say(opt.json ? JSON.stringify({ id, url: appUrl(id) }) : `not waiting — check: enclave status ${id}`);

  // 4. wait: ledger lease first, then the runner's own status
  say("waiting for an enclave to claim…");
  let claimed = null;
  for (let i = 0; i < 90 && !claimed; i++) {
    await sleep(2000);
    const d = await read(DEFAULTS.DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, "get", [id]).catch(() => null);
    if (d && !/^0x0+$/.test(d.runner) && Number(d.leaseUntil) * 1000 > Date.now()) claimed = d;
  }
  if (!claimed) throw new Error(`no enclave claimed it yet (still queued; funded work is retried every sweep) — watch: enclave status ${id}`);
  say(`claimed by ${short(claimed.runner)} (operator ${claimed.runnerOperator})`);
  const done = { running: 1, failed: 1, terminated: 1, expired: 1 };
  let rec = null;
  for (let i = 0; i < 180; i++) {
    rec = await api("GET", `/v1/deployments/${id}`, { auth: account, ok404: true });
    if (rec && done[rec.status]) break;
    await sleep(2500);
  }
  if (!rec || rec.status !== "running")
    throw new Error(`deployment is "${rec?.status || "unknown"}" — logs: enclave logs ${id}`);
  if (opt.json) return jout({ id, status: rec.status, url: appUrl(id) });
  say(`running — ${appUrl(id)}`);
  say(`verify before sending data: enclave attest ${id}`);
}

async function cmdPublish(rest) {
  const account = loadKey();
  const f = flags(rest, { val: ["--slug", "--name", "--desc", "--version", "--mem", "--cpu-gflops",
                                "--vram", "--gpu-gflops", "--ports"] });
  const file = f._[0];
  if (!file || !f.slug) throw new Error("usage: enclave publish <app.wasm> --slug <slug> [--name --desc --version --mem MB --cpu-gflops N --vram MB --gpu-gflops N --ports CSV]");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(f.slug)) throw new Error("slug: lowercase letters, digits, hyphens (max 40)");
  const bytes = fs.readFileSync(file);
  // same gate the IPFS gateway and runners apply: a wasi:http *component*
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100)
    throw new Error(`${file} is not a wasm binary (bad magic)`);
  const layer = bytes[6] | (bytes[7] << 8);
  if (layer === 0) throw new Error(`${file} is a core wasm module, not a component — build for wasm32-wasip2 (cargo component / componentize)`);
  if (layer !== 1) throw new Error(`${file} has unrecognized wasm layer ${layer} (expected a component)`);

  // version defaults to the next integer for your app (labels are free-form, matched exactly on deploy)
  let version = f.version;
  const appId = await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "appIdOf", [account.address, f.slug]);
  const existing = Number(await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "numVersions", [appId]).catch(() => 0n));
  if (!version) version = String(existing + 1);

  const res = [Math.round(numFlag(f.vram, "--vram") ?? 0), Math.round(numFlag(f["gpu-gflops"], "--gpu-gflops") ?? 0),
               Math.round(numFlag(f.mem, "--mem") ?? 256), Math.round(numFlag(f["cpu-gflops"], "--cpu-gflops") ?? 10)];
  if (!(await confirm(`publish ${file} (${(bytes.length / 1048576).toFixed(1)} MB) as ${f.slug}:${version} `
                    + `res=[vram ${res[0]}MB, gpu ${res[1]}Gf, mem ${res[2]}MB, cpu ${res[3]}Gf]?`))) return say("aborted");

  // 1. pin to IPFS (the gateway re-validates the component preamble)
  const upUrl = DEFAULTS.ipfsUpload;
  trace(`curl -sX POST ${upUrl} -H 'content-type: application/wasm' --data-binary @${file}`);
  const up = await fetch(upUrl, { method: "POST", headers: { "content-type": "application/wasm" }, body: bytes });
  const upBody = await up.text();
  if (!up.ok) throw new Error(`IPFS upload failed (${up.status}): ${upBody.slice(0, 200)}`);
  const cid = JSON.parse(upBody).cid;
  say(`pinned ipfs://${cid}`);

  // 2. cut the catalog version (publisher = your address; appId = keccak(publisher, slug))
  const rcpt = await sendTx(account, { address: DEFAULTS.APP_CATALOG_ADDRESS, abi: CATALOG_ABI,
    functionName: "publishVersion",
    args: [f.slug, f.name || f.slug, f.desc || "", version, cid, res, f.ports || ""] });
  if (opt.json) return jout({ slug: f.slug, version, cid, appId, tx: rcpt.transactionHash, approval: "pending" });
  say(`published ${f.slug}:${version} (tx ${rcpt.transactionHash})`);
  say(`approval is pending — runners only claim approved versions; deploy once approved:`);
  say(`  enclave deploy ${f.slug}:${version} --fund 2`);
}

async function cmdApps(rest) {
  const q = (rest[0] || "").toLowerCase();
  let apps = await catalogApps();
  if (q) apps = apps.filter((a) => (a.slug + " " + a.name + " " + a.description).toLowerCase().includes(q));
  const rows = [];
  for (const a of apps.slice(0, 50)) {
    const versions = a.versionCount
      ? await read(DEFAULTS.APP_CATALOG_ADDRESS, CATALOG_ABI, "getVersionsPage", [a.appId, 0n, BigInt(Number(a.versionCount))])
      : [];
    const latest = [...versions].reverse().find((v) => !v.yanked);
    rows.push({ slug: a.slug, name: a.name, publisher: a.publisher.slice(0, 10) + "…",
                version: latest ? latest.version : "—",
                approval: latest ? APPROVAL_WORD[Number(latest.approval)] : "",
                active: a.active ? "" : "inactive",
                versions, app: a });
  }
  if (opt.json) return jout({ apps: rows.map(({ app, versions, ...r }) => ({ ...r, appId: app.appId,
    versions: versions.map((v) => ({ version: v.version, cid: v.cid, approval: APPROVAL_WORD[Number(v.approval)], yanked: v.yanked })) })) });
  table(rows, [{ h: "app", f: (r) => r.slug + ":" + r.version }, { h: "name", k: "name" },
               { h: "publisher", k: "publisher" }, { h: "approval", k: "approval" }, { h: "", k: "active" }]);
  if (apps.length > 50) say(`(+${apps.length - 50} more — narrow with: enclave apps <query>)`);
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
  if (!g) return say("this enclave has no GPU (CPU-only) — try --base against the GPU enclave, or `enclave availability`");
  if (opt.json) return jout(g);
  const c = g.capacity || {};
  kv([["role", g.role], ["mps", g.mpsActive ? "active" : "off"],
      c.gpuShareFree != null ? ["gpu free", `${Math.round(c.gpuShareFree * 100)}%${c.vramFreeGb != null ? ` (${c.vramFreeGb} GB vram, ${c.smFree ?? "?"} SMs)` : ""}`] : null,
      ["sm total", g.smTotal != null ? String(g.smTotal) : undefined],
      ["tenants", String((g.tenants || []).length)]]);
  for (const t of g.tenants || []) say(`  ${t.pct}% ${t.status}${t.smGranted ? ` (${t.smGranted} SMs)` : ""}`);
}

async function cmdAccount() {
  const account = loadKey();
  const a = await api("GET", "/v1/account", { auth: account });
  if (opt.json) return jout(a);
  kv([["address", a.address], ["chain", String(a.chainId)],
      ["forwarder", a.payment?.forwarder], ["usdc", a.payment?.usdc],
      ["assets", (a.payment?.assets || []).join(", ")],
      ["running", String(a.deployments?.running ?? 0)],
      ["total", String(a.deployments?.total ?? 0)],
      ["funded time", dur(a.deployments?.totalTimeRemainingSec || 0)]]);
}

// ---- help + dispatch ---------------------------------------------------------------
const HELP = `enclave ${VERSION} — confidential compute from your terminal (https://enclave.host)

usage: enclave <command> [args]  [--json] [-x] [-y|--yes] [--base URL] [--rpc URL]

identity
  key new [--force]          generate a wallet key -> ${KEY_FILE}
  key import                 import a private key (hidden prompt / stdin pipe)
  whoami                     address, USDC + gas balances, running count

deployments
  deploy <app> --fund <usd>  create + fund + wait until live; prints the URL
         [--gpu 0..1] [--cpu 0..1]      shares of one card / one node (default: app minimums)
         [--fund-eth <eth>] [--private] [--port N] [--ports CSV]
         [--ssh-key FILE] [--config-cid CID] [--no-wait]
  ls                         your deployments — live, queued and unfunded
  status <id>                one deployment: state, lease, balance, URL
  logs <id> [-f] [--tail N]  the app's stdout/stderr (-f polls)
  fund <id> --usdc 5|--eth 0.002   top up runtime by the second
  attest [<id>]              fetch attestation + verify it LOCALLY; nonzero exit on FAIL
  stop <id>                  setActive(false) on-chain + DELETE the instance

catalog
  publish <app.wasm> --slug S [--version V --name N --desc D]
          [--mem MB --cpu-gflops N --vram MB --gpu-gflops N --ports CSV]
  apps [query]               browse/search the on-chain catalog

platform
  pricing | availability | gpu | account

<app>  is  [publisher/]slug[:version], a bare CID, or ipfs://<cid>
<id>   is  the bytes32 deployment id (0x…), any unique 0x-prefix of it, or a legacy dep_… id

Global: --json machine output · -x print every REST call + transaction ·
--base/--rpc (ENCLAVE_API_BASE/ENCLAVE_RPC) target an enclave or your own RPC ·
ENCLAVE_KEY overrides the key file. Auth is SIWE; keys never leave this machine.`;

const COMMANDS = {
  key: cmdKey, whoami: cmdWhoami, deploy: cmdDeploy, ls: cmdLs, list: cmdLs,
  status: cmdStatus, logs: cmdLogs, fund: cmdFund, attest: cmdAttest,
  stop: cmdStop, publish: cmdPublish, apps: cmdApps,
  pricing: cmdPricing, availability: cmdAvailability, gpu: cmdGpu, account: cmdAccount,
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
if (!COMMANDS[cmd]) die(`unknown command "${cmd}" — run: enclave help`);
try {
  await resolveAddressBook();
  await COMMANDS[cmd](args);
} catch (e) {
  die(e?.message || String(e));
}
