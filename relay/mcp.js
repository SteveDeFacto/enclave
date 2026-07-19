// Enclave MCP server — the coding-agent front door. Serves the Model Context
// Protocol (Streamable HTTP transport: JSON-RPC 2.0 over POST, stateless JSON
// responses) at https://mcp.enclave.host/ (any path) and at /mcp on the API
// host, dispatched from api-relay.js by Host header / path.
//
// SECURITY INVARIANT — this box never holds keys, and the MCP surface keeps
// it that way. No tool accepts a private key, no tool signs anything, and no
// tool submits transactions. The split is:
//   * read tools        -> the relay's own public gateway (loopback self-call:
//                          the same fleet-routed /v1 surface external clients
//                          hit) and public on-chain state via BASE_RPC
//   * write operations  -> "build_*" tools that VALIDATE the request against
//                          live chain state (approval gates, share minimums,
//                          fee snapshots, caps — the same checks the CLI runs)
//                          and return UNSIGNED Base transactions {chainId, to,
//                          data, value} for the agent to sign with the USER'S
//                          wallet, plus signature-flow helpers (SIWE login,
//                          upload tokens) where the client signs a message
//                          locally and trades the signature here
//   * secrets           -> session tokens ride per-call `token` params or the
//                          Authorization header; they are enclave-verified
//                          upstream, never minted or trusted here (same
//                          stance as api-relay's tokenAddress note)
// Encrypted-volume key derivation is CLIENT-SIDE ONLY and deliberately absent:
// a wallet signature that derives an encryption key must never transit a
// relay. The `guide` tool says so instead of doing it.
//
// Config (env, all optional):
//   MCP_DOMAIN         comma list of Host values served (default mcp.enclave.host)
//   API_RELAY_PORT     the local gateway port for self-calls (default 8100 —
//                      same var api-relay.js listens on)
//   BASE_RPC           preferred Base RPC; always backed by a public fallback
//                      pool (a single throttled RPC once killed the claim path)
//   ADDRESS_BOOK_ADDRESS / DEPLOYMENTS_ADDRESS / APP_CATALOG_ADDRESS
//                      contract roots; the book (default baked) overrides the
//                      baked defaults at runtime, same one-tx-repoint model as
//                      addressbook.js / the CLI
//
// Protocol notes: stateless (no Mcp-Session-Id minted, DELETE is 405), POST
// answers application/json (the spec allows JSON-only servers), GET is 405 for
// stream clients (no server-initiated messages) and an informational JSON for
// humans. tools/call errors are in-band (isError), not JSON-RPC errors.

import { createHash } from "node:crypto";
import { createPublicClient, http as viemHttp, fallback, encodeFunctionData } from "viem";
import { base } from "viem/chains";

const PORT = parseInt(process.env.API_RELAY_PORT || "8100", 10);
const SELF = `http://127.0.0.1:${PORT}`;
const MCP_DOMAINS = (process.env.MCP_DOMAIN || "mcp.enclave.host").toLowerCase()
  .split(",").map((s) => s.trim()).filter(Boolean);

// Baked Base-mainnet roots — kept in lockstep with cli/enclave.mjs DEFAULTS /
// scripts/sync-contract-addresses.sh; the address book re-points them live.
const CHAIN_ID = 8453;
const BOOK_ADDRESS = (process.env.ADDRESS_BOOK_ADDRESS || "0xab214342d5A490150A4A977063A2f88E21F80907").trim();
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ADDR = {
  deployments: (process.env.DEPLOYMENTS_ADDRESS || "0x0A7dE5D205c10B812AbaF0b89f3A243466bCEe01").trim(),
  appCatalog: (process.env.APP_CATALOG_ADDRESS || "0xaB0462E55c18E295A221e4Eaa8738F25eB0696D7").trim(),
};
const API_BASE = "https://api.enclave.host";
const APP_DOMAIN = "app.enclave.host";
const IPFS_UPLOAD = "https://ipfs.enclave.host";
const EXPECTED_REPO = "EnclaveHost/enclave";

// ---- chain plumbing -----------------------------------------------------------
const RPCS = [...new Set([...(process.env.BASE_RPC ? [process.env.BASE_RPC] : []),
  "https://base-rpc.publicnode.com", "https://base.drpc.org",
  "https://1rpc.io/base", "https://mainnet.base.org"])];
let _pub = null;
const pub = () => _pub ||
  (_pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => viemHttp(u))) }));
const read = (address, abi, functionName, args = []) =>
  pub().readContract({ address, abi, functionName, args });

// address book: ascii key right-padded to bytes32 (same derivation everywhere)
const bookKey = (name) => "0x" + Buffer.from(name, "ascii").toString("hex").padEnd(64, "0");
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view",
  inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
let _bookAt = 0;
async function addresses() {
  if (!BOOK_ADDRESS || Date.now() - _bookAt < 600_000) return ADDR;
  for (const [key, field] of [["deployments", "deployments"], ["appCatalog", "appCatalog"]]) {
    try {
      const a = await read(BOOK_ADDRESS, BOOK_ABI, "addr", [bookKey(key)]);
      if (a && !/^0x0{40}$/i.test(a)) ADDR[field] = a;
    } catch { /* keep current; next call retries */ }
  }
  _bookAt = Date.now();
  return ADDR;
}

// ---- contract shapes (mirror cli/enclave.mjs; sniffed like depAbi/catRev) ------
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
const createInputsFor = (rev) => [
  { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
  { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
  { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
  ...(rev >= 2 ? [] : [{ name: "sshPubKey", type: "string" }]),
  { name: "configCid", type: "string" },
  ...(rev >= 4 ? [{ name: "feeRecipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] : []),
];
const depsAbiFor = (rev) => [
  { type: "function", name: "create", stateMutability: "nonpayable", inputs: createInputsFor(rev), outputs: [{ type: "bytes32" }] },
  { type: "function", name: "fund", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "value", type: "uint256" }], outputs: [] },
  { type: "function", name: "fundEth", stateMutability: "payable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setActive", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "active", type: "bool" }], outputs: [] },
  { type: "function", name: "setAppRef", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "appRef", type: "string" }], outputs: [] },
  { type: "function", name: "feeOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "recipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: rev >= 2 ? DEPLOYMENT_TUPLE : DEPLOYMENT_TUPLE_V1 }] },
  { type: "function", name: "secondsFundable", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
];
const U256_VIEW = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
let _depRev = { at: 0, rev: 2 };
async function depRev() {
  if (Date.now() - _depRev.at < 600_000) return _depRev.rev;
  const { deployments } = await addresses();
  let rev = 2;
  try { rev = Number(await read(deployments, U256_VIEW("deploymentsSchema"), "deploymentsSchema")) || 2; }
  catch (e) { if (/revert/i.test(e?.shortMessage || e?.message || "")) rev = 1; else throw e; }
  _depRev = { at: Date.now(), rev };
  return rev;
}
// keccak256("Created(bytes32,address,string,uint16,uint16,uint256)") — the
// minted deployment id is topics[1] of this event in the create receipt.
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
const VERSION_TUPLE_V3 = [...VERSION_TUPLE, { name: "config", type: "string" }];
const publishInputsFor = (rev) => [
  { name: "slug", type: "string" }, { name: "name", type: "string" },
  { name: "description", type: "string" }, { name: "version", type: "string" },
  { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
  { name: "ports", type: "string" },
  ...(rev >= 3 ? [{ name: "config", type: "string" }] : []),
  ...(rev >= 5 ? [{ name: "feePerSec6", type: "uint256" }] : []),
];
const catAbiFor = (rev) => [
  { type: "function", name: "getAppsPage", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: APP_TUPLE }] },
  { type: "function", name: "getVersionsPage", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "tuple[]", components: rev >= 4 ? VERSION_TUPLE_V3 : VERSION_TUPLE }] },
  { type: "function", name: "numVersions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "appIdOf", stateMutability: "pure",
    inputs: [{ type: "address" }, { type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "versionFee", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "publishVersion", stateMutability: "nonpayable", inputs: publishInputsFor(rev), outputs: [{ type: "bytes32" }, { type: "uint256" }] },
];
let _catRev = { at: 0, rev: 2 };
async function catRev() {
  if (Date.now() - _catRev.at < 600_000) return _catRev.rev;
  const { appCatalog } = await addresses();
  let rev = 2;
  try { rev = Number(await read(appCatalog, U256_VIEW("catalogSchema"), "catalogSchema")) || 2; } catch { rev = 2; }
  _catRev = { at: Date.now(), rev };
  return rev;
}
const APPROVAL_WORD = ["pending", "approved", "rejected"];

let _apps = { at: 0, rows: null };
async function catalogApps() {
  if (_apps.rows && Date.now() - _apps.at < 30_000) return _apps.rows;
  const { appCatalog } = await addresses();
  const abi = catAbiFor(await catRev());
  const rows = [];
  for (let start = 0; ; start += 50) {
    const page = await read(appCatalog, abi, "getAppsPage", [BigInt(start), 50n]);
    rows.push(...page);
    if (page.length < 50) break;
  }
  _apps = { at: Date.now(), rows };
  return rows;
}
async function readVersions(appId, count) {
  const { appCatalog } = await addresses();
  const abi = catAbiFor(await catRev());
  const versions = await read(appCatalog, abi, "getVersionsPage", [appId, 0n, BigInt(Math.max(1, Number(count)))]);
  return versions.map((v) => ({ config: "", ...v }));
}
async function versionFee6(appId, index) {
  if ((await catRev()) < 5) return 0n;
  const { appCatalog } = await addresses();
  return await read(appCatalog, catAbiFor(5), "versionFee", [appId, BigInt(index)]);
}

// [publisher/]slug[:version] -> the on-chain version RECORD (same resolution +
// approval gate as the CLI: runners re-check on their side, this fails fast
// with a readable reason; CIDs are refused — a CID names bytes, not a version)
async function resolveAppRef(input) {
  if (/^ipfs:\/\//i.test(input) || /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{20,})$/.test(String(input)))
    throw new Error("CIDs can't deploy: a CID names bytes, not a version. Use [publisher/]slug[:version] from the catalog (list_apps).");
  const m = String(input).match(/^(?:([0-9a-zA-Z.]+|0x[0-9a-fA-F]{40})\/)?([a-z0-9][a-z0-9-]*)(?::(.+))?$/);
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
  return { ref: `catalog://${app.appId}/${vi}`, index: vi, ver, app };
}

// minimum shares for an app's specs on the fleet's hardware — the runner's own
// formula (spec / server spec, larger of the memory and compute axes, ceil to
// the percent grain), computed against /v1/pricing's node + card numbers
function minShares(ver, pricing) {
  const node = pricing?.node || {}, card = pricing?.card || {};
  const axis = (need, have) => need > 0 && have > 0 ? need / have : 0;
  const cpu = Math.max(axis(Number(ver.memMb), (node.ramGb || 0) * 1024),
                       axis(Number(ver.cpuGflops), node.gflops || 0));
  const gpu = Math.max(axis(Number(ver.vramMb), (card.vramGb || 0) * 1024),
                       axis(Number(ver.gpuGflops), (card.tflops || 0) * 1000));
  const grain = (x) => Math.min(1000, Math.ceil(x * 100) * 10);
  return { gpuMilli: grain(gpu), cpuMilli: Math.max(10, grain(cpu)) };
}

// ---- unsigned-transaction encoders (pure; pinned by test/mcp.test.mjs) --------
const tx = (to, data, value = 0n, describe = "") =>
  ({ chainId: CHAIN_ID, to, data, value: "0x" + value.toString(16), function: describe });
export function encodeCreateTx({ rev, deployments, appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, envelope, feeRecipient, feePerSec6 }) {
  const args = [appRef, gpuMilli, cpuMilli, appPort, ports, isPublic,
                ...(rev >= 2 ? [] : [""]), envelope || "",
                ...(rev >= 4 ? [feeRecipient, feePerSec6] : [])];
  return tx(deployments, encodeFunctionData({ abi: depsAbiFor(rev), functionName: "create", args }), 0n,
    `EnclaveDeployments.create(${appRef})`);
}
export function encodeFundTxs({ deployments, id, usd, ethWei }) {
  if (ethWei != null)
    return [tx(deployments, encodeFunctionData({ abi: depsAbiFor(2), functionName: "fundEth", args: [id] }), BigInt(ethWei),
      "EnclaveDeployments.fundEth (credited as USDC at the live Chainlink ETH/USD rate)")];
  // USDC is billed in whole cents (contract balances are 6dp)
  const cents = usd * 100;
  if (usd < 0.01) throw new Error(`minimum USDC funding is $0.01 (got $${usd}); amounts are billed in whole cents`);
  if (Math.abs(cents - Math.round(cents)) > 1e-9)
    throw new Error(`USDC funding is billed in whole cents: $${usd} isn't a whole number of cents`);
  const value = BigInt(Math.round(cents)) * 10000n;
  const ERC20 = [{ type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
  return [
    tx(USDC_ADDRESS, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [deployments, value] }), 0n,
      `USDC.approve(EnclaveDeployments, ${(Number(value) / 1e6).toFixed(2)})`),
    tx(deployments, encodeFunctionData({ abi: depsAbiFor(2), functionName: "fund", args: [id, value] }), 0n,
      `EnclaveDeployments.fund(${id.slice(0, 10)}…, $${(Number(value) / 1e6).toFixed(2)})`),
  ];
}
export function encodeSetActiveTx({ deployments, id, active }) {
  return tx(deployments, encodeFunctionData({ abi: depsAbiFor(2), functionName: "setActive", args: [id, active] }), 0n,
    `EnclaveDeployments.setActive(${id.slice(0, 10)}…, ${active})`);
}
export function encodeSetAppRefTx({ deployments, id, appRef }) {
  return tx(deployments, encodeFunctionData({ abi: depsAbiFor(3), functionName: "setAppRef", args: [id, appRef] }), 0n,
    `EnclaveDeployments.setAppRef(${id.slice(0, 10)}…, ${appRef})`);
}
export function encodePublishTx({ rev, appCatalog, slug, name, description, version, cid, res, ports, config, feePerSec6 }) {
  const args = [slug, name, description, version, cid, res, ports,
                ...(rev >= 3 ? [config || ""] : []), ...(rev >= 5 ? [feePerSec6] : [])];
  return tx(appCatalog, encodeFunctionData({ abi: catAbiFor(rev), functionName: "publishVersion", args }), 0n,
    `EnclaveAppCatalog.publishVersion(${slug}:${version})`);
}

// ---- self-calls (the relay's own public gateway, loopback) ---------------------
const bearerize = (t) => !t ? null : /^bearer /i.test(t) ? t : `Bearer ${t}`;
async function self(method, path, { token, body, raw } = {}) {
  const headers = { accept: "application/json" };
  const auth = bearerize(token);
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(SELF + path, { method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000) });
  const text = await r.text();
  if (raw) { if (!r.ok) throw new Error(`${path} -> ${r.status}: ${text.slice(0, 300)}`); return text; }
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${data.message || data.error || text.slice(0, 300)}`);
  return data;
}

const isB32 = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ""));
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));
const usdHr = (perSec6) => "$" + (Number(perSec6) * 3600 / 1e6).toFixed(4) + "/h";
const appLabel = (id) => isB32(id) ? id.slice(2, 10).toLowerCase() : String(id).replace(/^dep_/, "");
const appUrl = (id) => `https://${appLabel(id)}.${APP_DOMAIN}`;
async function depGet(id) {
  const { deployments } = await addresses();
  const d = await read(deployments, depsAbiFor(await depRev()), "get", [id]);
  if (!d || /^0x0{40}$/i.test(d.owner)) throw new Error(`no deployment ${id} on the ledger`);
  return d;
}
// full-id resolution for tx builders (accepts a unique 0x-hex prefix like the CLI)
async function resolveFullId(input) {
  if (isB32(input)) return input.toLowerCase();
  const hex = String(input).replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{8,63}$/.test(hex)) throw new Error(`"${input}" is not a deployment id (bytes32 or a 0x-hex prefix of one)`);
  const v = await self("GET", `/v1/deployments/0x${hex}`);   // the gateway resolves prefixes against the ledger
  if (!isB32(v.id)) throw new Error(`could not resolve "${input}" to an on-chain id`);
  return String(v.id).toLowerCase();
}

// ---- guides -------------------------------------------------------------------
const SIGNING_NOTE = `Signing and sending transactions: every build_* tool returns unsigned Base (chainId ${CHAIN_ID}) transactions {chainId, to, data, value}. Sign and send them IN ORDER with the wallet that owns (or should own) the deployment. Keys never leave your machine. Examples:
  cast send <to> --value <value> <data-as-calldata> --private-key $KEY --rpc-url https://mainnet.base.org   (foundry: cast send <to> <data> ...)
  viem: walletClient.sendTransaction({ to, data, value: BigInt(value) })
  or use the enclave CLI, which wraps these flows end to end: curl -fsSL https://get.enclave.host | sh`;

const GUIDES = {
  "getting-started": `Enclave (enclave.host) runs apps inside hardware TEEs (confidential VMs) on flagship NVIDIA GPUs and CPU nodes. If it can sign, it can compute: the only identity is a wallet on Base (chainId ${CHAIN_ID}); there are no accounts.

What you need:
1. A wallet on Base with a little ETH for gas.
2. USDC on Base to fund runtime (or fund with ETH, converted at the live Chainlink rate).

The flow (each step has a tool):
1. list_apps / get_app: browse the on-chain app catalog.
2. plan_deploy: validate + price a deployment, get the unsigned create transaction.
3. Sign and send it; the new deployment id is topics[1] of the Created event (topic ${DEP_CREATED_TOPIC}) in the receipt.
4. build_fund: unsigned funding transactions (USDC approve+fund, or fundEth). Sign and send.
5. claim_hint: nudge the fleet to claim it now (otherwise the ~60s sweep finds it).
6. get_deployment until status is "running"; the app serves at https://<first-8-hex-of-id>.${APP_DOMAIN}.
7. Verify the enclave before sending secrets: see guide topic "attestation".

Reads (pricing, availability, catalog, deployment status) need no auth. Owner-only reads (logs, account) need a session token: auth_nonce -> sign the message with personal_sign -> auth_login. ${SIGNING_NOTE}`,

  deploy: `Deploying an app, step by step:
1. Pick a catalog app: list_apps, then get_app for versions. Only APPROVED versions are claimable.
2. plan_deploy { app: "[publisher/]slug[:version]", fundUsd: 5 } with optional gpuShare/cpuShare (fractions 0..1 of one card / one node; defaults are the app's minimums on the fleet hardware), appPort, ports (CSV like "http:8080,tcp:7777,udp:53"), public (default true), waf (per-IP rate-limit/filter object, e.g. {"rps":10,"blockScanners":true}).
3. It returns the unsigned create tx plus the priced rate per hour (platform shares + any publisher fee, snapshotted immutably at create). Sign and send.
4. The receipt's Created event (topic ${DEP_CREATED_TOPIC}) carries the id in topics[1].
5. build_fund { id, usd: 5 } (whole cents) or { id, eth: 0.002 }; sign and send. Runners skip unfunded work.
6. claim_hint { id }, then poll get_deployment { id }: awaiting_payment -> queued -> claimed -> running. Queued-over-capacity work starts by itself when capacity frees.
7. The app URL is https://<first-8-hex-of-id>.${APP_DOMAIN} (its own origin). Websockets work. Declared tcp:/udp: ports get a dedicated public IPv6 (in the deployment record's network field).
Notes: shares are immutable after create; a deployment that under-provisions its app's minimums is never claimed. Stop/resume/upgrade are build_stop / build_resume / build_upgrade. ${SIGNING_NOTE}`,

  publish: `Publishing an app to the catalog (wasm component -> IPFS -> on-chain version, then an approval gate):
1. Build a wasm32-wasip2 COMPONENT (wasi:http). Core modules are refused.
2. sha256 the bytes, pick expiry = now + up to 600 seconds (unix), and personal_sign EXACTLY the string:
   enclave-upload:<sha256hex>:<expiry>
3. upload_token { hash, expiry, signature } returns { token, address, expiry }.
4. POST the raw bytes to ${IPFS_UPLOAD}/add-wasm with headers content-type: application/wasm, x-upload-address, x-upload-expiry, x-upload-token. The response carries { cid }.
   curl -sX POST ${IPFS_UPLOAD}/add-wasm -H 'content-type: application/wasm' -H "x-upload-address: <address>" -H "x-upload-expiry: <expiry>" -H "x-upload-token: <token>" --data-binary @app.wasm
5. build_publish { publisher, slug, cid, ... } returns the unsigned publishVersion tx. Optional: version label (default: next integer), name, description, resource specs (vramMb, gpuGflops, memMb, cpuGflops; deploy dials size shares from these), ports CSV, config (the version's default ENCLAVE_CONFIG JSON, immutable), feeUsdPerHour (YOUR per-deployment publisher fee, paid straight to your wallet out of each funding, capped by the platform).
6. Sign and send. The version starts PENDING; runners only claim approved versions. Images for the app page go to /add-image with the same signed-upload flow.
${SIGNING_NOTE}`,

  funding: `Money model: rates are on-chain per-second USDC (6 decimals). A deployment's rate = (pricePerSec6 * gpuMilli + cpuPricePerSec6 * cpuMilli, ceil-divided by 1000) + the version's publisher fee, all snapshotted at create; the pricing tool shows the live numbers and plan_deploy prices the exact deployment. Funding is prepaid and burns per second while leased.
- USDC: build_fund { id, usd } returns approve + fund transactions (whole cents only). The CLI's gasless-style EIP-3009 path (fundWithAuthorization) exists too; the approve+fund pair is equivalent and simpler.
- ETH: build_fund { id, eth } returns one fundEth transaction; credited as USDC at the live Chainlink ETH/USD rate.
- Top up any time with build_fund. timeRemainingSec in get_deployment = prepaid lease tail + what the balance still buys.
- Stopping (build_stop) keeps the balance on the record; build_resume continues it. Funds on a record are spent only while it runs.`,

  attestation: `Never trust the gateway: verify the enclave BEFORE sending it secrets.
- attestation returns the fleet attestation document; deployment_attestation { id } returns the hosting enclave's (needs a session token).
- REAL verification runs client-side with @tinfoilsh/verifier against the pinned source repo ${EXPECTED_REPO} (hardware TEE quote -> vendor root, Sigstore provenance, measurement match, TLS binding). Never verify against a repo name the API returns; pin ${EXPECTED_REPO}.
- Easiest: the enclave CLI does it in one command: enclave attest [<id>]  (curl -fsSL https://get.enclave.host | sh)
- Session tokens are minted in-enclave (ES256); the JWKS is at ${API_BASE}/v1/session-jwks and inside the attestation document, so a verified enclave transitively authenticates the API.`,

  volumes: `Two kinds of volumes:
1. Model volumes (read-only weights, e.g. GGUF): availability lists them under "volumes" with the enclaves that carry them. Apps mount them at /models/<name>. Deploy on an enclave that carries the volume (placement follows your claim).
2. Encrypted volumes (tenant data over S3-compatible storage, rclone crypt): the encryption key derives from a wallet signature CLIENT-SIDE ONLY. Use the enclave CLI: "enclave encvol message <keyId>" prints the message to sign; "enclave encvol derive/seal-creds" derive the password/salt and seal S3 credentials. NEVER send that signature to any server or tool, including this one; anyone holding it can derive the volume key. The sealed envelope and derived password go in your app's config; decryption happens inside the enclave.`,

  networking: `Ports and reachability:
- ports CSV on a version/deployment: "http:8080,tcp:25565,udp:53". The http entry (or appPort) serves at the deployment's own origin https://<first-8-hex-of-id>.${APP_DOMAIN} (TLS terminates inside enclaves for app traffic; websockets pass through).
- Declared tcp:/udp: ports are served on a dedicated per-deployment public IPv6 (get_deployment's network field once running). IPv4-only clients can bridge with websocat via the app origin.
- public: true (default) lists the deployment and serves it to anyone; private deployments still get their origin but are for the owner's use.
- waf option at create: {"rps":N,"burst":N,"maxBodyMb":N,"blockScanners":true} enforced per requester IP by the enclave's own proxy (availability shows whether the live fleet supports it: "waf": true).
- Outbound: deployments can get dedicated-IP egress (per-deployment IPv6) on supported fleets.`,

  fees: `Publisher fees: a catalog version may carry feePerSec6 (set via build_publish's feeUsdPerHour, capped by the platform's maxFeePerSec6). Deploying such a version snapshots {publisher, fee} immutably into the deployment record; every funding pays the publisher pro-rata, straight to their wallet, no platform custody. get_app shows each version's fee. An upgrade (build_upgrade) can only move to a version whose fee fits the deployment's original snapshot; otherwise deploy fresh.`,

  cli: `The enclave CLI wraps every flow here with local key management:
  curl -fsSL https://get.enclave.host | sh
  enclave key new / import      wallet (or set ENCLAVE_KEY)
  enclave apps                  catalog
  enclave deploy <app> --fund 5 create + fund + wait, one command
  enclave status/logs/attest    watch and verify
  enclave fund/stop/resume/upgrade
  enclave publish app.wasm --slug my-app [--fee 0.10]
  enclave encvol ...            encrypted-volume key derivation (client-side)
MCP and the CLI are equivalent surfaces; MCP returns unsigned transactions instead of signing locally.`,
};

// ---- tools --------------------------------------------------------------------
const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const P = {
  id: { type: "string", description: "Deployment id: bytes32 0x… (or a unique 0x-hex prefix, 8+ chars)" },
  token: { type: "string", description: "Session token from auth_login (falls back to this request's Authorization header)" },
  app: { type: "string", description: "Catalog app reference: [publisher/]slug[:version]" },
};

const TOOLS = [
  {
    name: "guide",
    description: "How-to guides for the Enclave platform (confidential compute for wasm apps, paid in USDC on Base). Topics: getting-started, deploy, publish, funding, attestation, volumes, networking, fees, cli. Start with getting-started.",
    inputSchema: S({ topic: { type: "string", enum: Object.keys(GUIDES), description: "Which guide to read" } }, ["topic"]),
    handler: async ({ topic }) => GUIDES[topic] || `Unknown topic. Topics: ${Object.keys(GUIDES).join(", ")}`,
  },
  {
    name: "platform_status",
    description: "Gateway health: live enclave count, fleet build metadata.",
    inputSchema: S({}),
    handler: async () => {
      const health = await self("GET", "/health");
      const version = await self("GET", "/v1/version").catch(() => null);
      return { gateway: "api-relay", ...health, fleetVersion: version };
    },
  },
  {
    name: "pricing",
    description: "Live platform rates and billing model (per-second USDC on Base; share prices for one GPU card / one CPU node, hardware sizing numbers used for share minimums).",
    inputSchema: S({}),
    handler: async () => self("GET", "/v1/pricing"),
  },
  {
    name: "availability",
    description: "Live fleet capacity: free GPU/CPU shares, hardware sizing minima (spec*), attached model volumes, and whether the fleet enforces the per-deployment WAF envelope.",
    inputSchema: S({}),
    handler: async () => self("GET", "/availability"),
  },
  {
    name: "gpu_capacity",
    description: "Live GPU partitioning detail (per-tenant SM grants / MPS view).",
    inputSchema: S({}),
    handler: async () => self("GET", "/v1/gpu"),
  },
  {
    name: "list_apps",
    description: "List the on-chain app catalog (public). Optional substring query over slug/name/description.",
    inputSchema: S({ query: { type: "string", description: "Case-insensitive substring filter" } }),
    handler: async ({ query }) => {
      const q = (query || "").toLowerCase();
      const rows = (await catalogApps())
        .filter((a) => !q || (a.slug + " " + a.name + " " + a.description).toLowerCase().includes(q))
        .map((a) => ({ publisher: a.publisher, slug: a.slug, name: a.name, description: a.description,
                       versions: Number(a.versionCount), active: a.active }));
      return { apps: rows, hint: "get_app for versions/fees; plan_deploy to deploy" };
    },
  },
  {
    name: "get_app",
    description: "One catalog app with all its versions: approval status, resource specs, ports, per-version config, publisher fee.",
    inputSchema: S({ app: { type: "string", description: "[publisher/]slug (no version)" } }, ["app"]),
    handler: async ({ app }) => {
      const m = String(app).match(/^(?:([0-9a-zA-Z.]+|0x[0-9a-fA-F]{40})\/)?([a-z0-9][a-z0-9-]*)$/);
      if (!m) throw new Error(`"${app}" is not [publisher/]slug`);
      let apps = (await catalogApps()).filter((a) => a.slug === m[2]);
      if (m[1]) apps = apps.filter((a) => a.publisher.toLowerCase() === m[1].toLowerCase());
      if (!apps.length) throw new Error(`no catalog app with slug "${m[2]}"`);
      if (apps.length > 1) throw new Error(`slug "${m[2]}" has ${apps.length} publishers; use <publisher>/${m[2]}`);
      const a = apps[0];
      const versions = await readVersions(a.appId, a.versionCount);
      const fees = await Promise.all(versions.map((_, i) => versionFee6(a.appId, i).catch(() => 0n)));
      return {
        publisher: a.publisher, slug: a.slug, name: a.name, description: a.description,
        appId: a.appId, active: a.active,
        versions: versions.map((v, i) => ({
          index: i, version: v.version, cid: v.cid, approval: APPROVAL_WORD[Number(v.approval)] || String(v.approval),
          yanked: v.yanked, ports: v.ports, config: v.config || "",
          specs: { vramMb: Number(v.vramMb), gpuGflops: Number(v.gpuGflops), memMb: Number(v.memMb), cpuGflops: Number(v.cpuGflops) },
          publisherFeePerHour: fees[i] > 0n ? usdHr(fees[i]) : null,
        })),
      };
    },
  },
  {
    name: "list_deployments",
    description: "List a wallet's deployments: live fleet view (with a session token) merged with the on-chain ledger, so queued/stopped/unfunded work appears too. Ledger rows are public; pass owner to scope without a token.",
    inputSchema: S({ owner: { type: "string", description: "Wallet address 0x… (required without a token)" }, token: P.token }),
    handler: async ({ owner }, ctx) => {
      if (owner && !isAddr(owner)) throw new Error("owner must be a 0x… address");
      return self("GET", `/v1/deployments${owner ? `?owner=${owner}` : ""}`, { token: ctx.token });
    },
  },
  {
    name: "get_deployment",
    description: "One deployment's record: status (awaiting_payment | queued | claimed | running | stopped | unfunded), rate, balance, time remaining, network addresses. Public ledger data; a session token adds the hosting enclave's live view.",
    inputSchema: S({ id: P.id, token: P.token }, ["id"]),
    handler: async ({ id }, ctx) => {
      const d = await self("GET", `/v1/deployments/${encodeURIComponent(id)}`, { token: ctx.token });
      return { ...d, url: d.id ? appUrl(d.id) : undefined };
    },
  },
  {
    name: "deployment_logs",
    description: "Worker logs for a deployment (owner only; needs a session token from auth_login).",
    inputSchema: S({ id: P.id, tail: { type: "number", description: "Lines from the end (default 100)" }, token: P.token }, ["id"]),
    handler: async ({ id, tail }, ctx) => {
      if (!ctx.token) throw new Error("logs are owner-only: pass token (see auth_nonce/auth_login)");
      return self("GET", `/v1/deployments/${encodeURIComponent(id)}/logs?tail=${Math.max(1, Math.min(10000, Number(tail) || 100))}`,
        { token: ctx.token, raw: true });
    },
  },
  {
    name: "fleet_attestation",
    description: "The fleet's enclave attestation document (public). Verify CLIENT-SIDE with @tinfoilsh/verifier pinned to the repo EnclaveHost/enclave, or `enclave attest`; never trust this gateway's copy blindly.",
    inputSchema: S({}),
    handler: async () => ({ attestation: await self("GET", "/v1/attestation"),
      verify: `Client-side only: @tinfoilsh/verifier with configRepo pinned to ${EXPECTED_REPO} (see guide topic "attestation")` }),
  },
  {
    name: "deployment_attestation",
    description: "The attestation of the enclave hosting one deployment (owner token required). Verify client-side; see guide topic \"attestation\".",
    inputSchema: S({ id: P.id, token: P.token }, ["id"]),
    handler: async ({ id }, ctx) => {
      if (!ctx.token) throw new Error("pass token (see auth_nonce/auth_login)");
      const nonce = createHash("sha256").update(String(Math.random()) + Date.now()).digest("hex");
      return self("GET", `/v1/deployments/${encodeURIComponent(id)}/attestation?nonce=${nonce}`, { token: ctx.token });
    },
  },
  {
    name: "account",
    description: "Account summary for the signed-in wallet: payment addresses (forwarder, USDC), deployment counts. Needs a session token.",
    inputSchema: S({ token: P.token }),
    handler: async (_a, ctx) => {
      if (!ctx.token) throw new Error("pass token (see auth_nonce/auth_login)");
      return self("GET", "/v1/account", { token: ctx.token });
    },
  },
  {
    name: "auth_nonce",
    description: "Step 1 of sign-in: fetch the SIWE message for a wallet. Sign it locally with personal_sign, then call auth_login. Only needed for owner-scoped reads (logs, account, live status detail); all transactions work without a session.",
    inputSchema: S({ address: { type: "string", description: "Wallet address 0x…" } }, ["address"]),
    handler: async ({ address }) => {
      if (!isAddr(address)) throw new Error("address must be a 0x… wallet address");
      const n = await self("GET", `/v1/auth/nonce?address=${address}`);
      return { ...n, next: "personal_sign the `message` with this wallet, then auth_login { message, signature }" };
    },
  },
  {
    name: "auth_login",
    description: "Step 2 of sign-in: exchange the signed SIWE message for a session token (ES256, minted inside the enclave). Pass the token to owner-scoped tools, or set it as this MCP server's Authorization header.",
    inputSchema: S({ message: { type: "string", description: "The exact message from auth_nonce" },
                     signature: { type: "string", description: "personal_sign signature 0x…" } }, ["message", "signature"]),
    handler: async ({ message, signature }) => self("POST", "/v1/auth/login", { body: { message, signature } }),
  },
  {
    name: "claim_hint",
    description: "Nudge the fleet to claim a funded on-chain deployment right now (otherwise the ~60s sweep finds it). Advisory and unauthenticated.",
    inputSchema: S({ id: P.id }, ["id"]),
    handler: async ({ id }) => self("POST", "/v1/claim-hint", { body: { id } }),
  },
  {
    name: "restart_deployment",
    description: "Restart a running deployment in place (owner only; needs a session token).",
    inputSchema: S({ id: P.id, token: P.token }, ["id"]),
    handler: async ({ id }, ctx) => {
      if (!ctx.token) throw new Error("pass token (see auth_nonce/auth_login)");
      return self("POST", `/v1/deployments/${encodeURIComponent(id)}/restart`, { token: ctx.token, body: {} });
    },
  },
  {
    name: "terminate_hosted",
    description: "Tear down the hosted instance promptly after an on-chain stop (owner only; needs a session token). On-chain stop itself is build_stop; without this the runner tears it down on its next ledger pass anyway.",
    inputSchema: S({ id: P.id, token: P.token }, ["id"]),
    handler: async ({ id }, ctx) => {
      if (!ctx.token) throw new Error("pass token (see auth_nonce/auth_login)");
      return self("DELETE", `/v1/deployments/${encodeURIComponent(id)}`, { token: ctx.token });
    },
  },
  {
    name: "upload_token",
    description: "Trade a wallet signature for a one-time IPFS upload token (publishing step). Sign EXACTLY `enclave-upload:<sha256hex>:<expiry>` (personal_sign; expiry = unix seconds within +600s), then POST the bytes to " + IPFS_UPLOAD + "/add-wasm (or /add-image) with headers x-upload-address/-expiry/-token. See guide topic \"publish\".",
    inputSchema: S({
      hash: { type: "string", description: "sha256 hex of the exact bytes to upload" },
      expiry: { type: "number", description: "Unix seconds; must match the signed string, within the next 600s" },
      signature: { type: "string", description: "personal_sign of enclave-upload:<hash>:<expiry>" },
    }, ["hash", "expiry", "signature"]),
    handler: async ({ hash, expiry, signature }) => {
      const t = await self("POST", "/v1/apps/upload-token", { body: { hash, expiry, signature } });
      return { ...t, upload: `curl -sX POST ${IPFS_UPLOAD}/add-wasm -H 'content-type: application/wasm' -H 'x-upload-address: ${t.address}' -H 'x-upload-expiry: ${expiry}' -H 'x-upload-token: ${t.token}' --data-binary @app.wasm` };
    },
  },
  {
    name: "plan_deploy",
    description: "Validate and price a deployment of a catalog app, returning the unsigned create transaction. Runs the same gates the CLI does: approval, share minimums on the fleet's hardware, the platform GPU cap, and the publisher-fee snapshot. After the create tx mines, the id is topics[1] of the Created event; then build_fund and claim_hint.",
    inputSchema: S({
      app: P.app,
      gpuShare: { type: "number", description: "Fraction of one GPU card, 0..1 (default: the app's minimum)" },
      cpuShare: { type: "number", description: "Fraction of one CPU node, 0..1 (default: the app's minimum)" },
      appPort: { type: "number", description: "The app's HTTP port (default: the version's http: port, else 8080)" },
      ports: { type: "string", description: "CSV overriding the version's ports, e.g. \"http:8080,tcp:7777\"" },
      public: { type: "boolean", description: "Listed and open to anyone (default true)" },
      waf: { type: "object", description: "Per-IP protection envelope, e.g. {\"rps\":10,\"burst\":40,\"blockScanners\":true}", additionalProperties: true },
      fundUsd: { type: "number", description: "Planned USDC funding (used to estimate runtime; funding itself is build_fund after create)" },
    }, ["app"]),
    handler: async (a) => {
      const { ref, index, ver, app } = await resolveAppRef(a.app);
      const pricing = await self("GET", "/v1/pricing").catch(() => null);
      const mins = minShares(ver, pricing);
      let gpuMilli = a.gpuShare !== undefined ? Math.round(Number(a.gpuShare) * 1000) : mins.gpuMilli;
      let cpuMilli = a.cpuShare !== undefined ? Math.round(Number(a.cpuShare) * 1000) : Math.max(mins.cpuMilli, 10);
      if (!(gpuMilli >= 0 && gpuMilli <= 1000) || !(cpuMilli >= 0 && cpuMilli <= 1000))
        throw new Error("gpuShare/cpuShare are fractions of one card/node (0..1)");
      if (cpuMilli < 1) cpuMilli = 10;
      if (gpuMilli > 0 && gpuMilli < cpuMilli) gpuMilli = cpuMilli;      // contract: gpuMilli >= cpuMilli
      const portsCsv = a.ports !== undefined ? String(a.ports) : (ver.ports || "");
      const httpEntry = portsCsv.split(",").map((s) => s.trim()).find((s) => /^http:/i.test(s));
      const appPort = a.appPort !== undefined ? Math.round(Number(a.appPort))
        : httpEntry ? parseInt(httpEntry.split(":")[1], 10) : 8080;
      let envelope = "";
      if (a.waf !== undefined) {
        if (!a.waf || Array.isArray(a.waf) || typeof a.waf !== "object" || !Object.keys(a.waf).length)
          throw new Error("waf must be a non-empty object, e.g. {\"rps\":10}");
        envelope = JSON.stringify({ waf: a.waf });
      }
      const { deployments } = await addresses();
      const [pricePerSec6, cpuPricePerSec6, maxGpuMilli] = await Promise.all([
        read(deployments, U256_VIEW("pricePerSec6"), "pricePerSec6"),
        read(deployments, U256_VIEW("cpuPricePerSec6"), "cpuPricePerSec6"),
        read(deployments, [{ type: "function", name: "maxGpuMilli", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }],
          "maxGpuMilli").then(Number).catch(() => 1000),
      ]);
      if (gpuMilli > maxGpuMilli)
        throw new Error(mins.gpuMilli > maxGpuMilli
          ? `${a.app} needs at least a ${mins.gpuMilli / 10}% GPU share but the platform caps deployments at ${maxGpuMilli / 10}% of a card right now`
          : `gpuShare ${gpuMilli / 10}% is over the platform's per-deployment cap of ${maxGpuMilli / 10}%`);
      const fee6 = await versionFee6(app.appId, index);
      const rev = await depRev();
      if (fee6 > 0n && rev < 4)
        throw new Error(`${a.app} charges a publisher fee, which the live ledger contract predates; it can't be deployed until the ledger upgrade`);
      const rate = (pricePerSec6 * BigInt(gpuMilli) + cpuPricePerSec6 * BigInt(cpuMilli) + 999n) / 1000n + fee6;
      const create = encodeCreateTx({ rev, deployments, appRef: ref, gpuMilli, cpuMilli, appPort,
        ports: portsCsv, isPublic: a.public !== false, envelope,
        feeRecipient: fee6 > 0n ? app.publisher : "0x0000000000000000000000000000000000000000", feePerSec6: fee6 });
      return {
        app: `${app.slug}:${ver.version}`, appRef: ref,
        shares: { gpuMilli, cpuMilli, note: "immutable after create; minimums for this version: " + JSON.stringify(mins) },
        ratePerHour: usdHr(rate), publisherFeePerHour: fee6 > 0n ? usdHr(fee6) : null,
        estimatedRuntime: a.fundUsd ? `${Math.floor(a.fundUsd * 1e6 / Number(rate) / 3600)}h ${Math.floor(a.fundUsd * 1e6 / Number(rate) % 3600 / 60)}m for $${a.fundUsd}` : undefined,
        transactions: [create],
        next: `1) sign+send the create tx  2) id = topics[1] of the Created event (topic ${DEP_CREATED_TOPIC})  3) build_fund { id, usd | eth }  4) claim_hint { id }  5) get_deployment until running; app URL https://<first-8-hex-of-id>.${APP_DOMAIN}`,
      };
    },
  },
  {
    name: "build_fund",
    description: "Unsigned funding transactions for a deployment: { usd } returns USDC approve + fund (whole cents; billed per second), { eth } returns one payable fundEth (credited at the live Chainlink rate). Anyone can fund any deployment.",
    inputSchema: S({ id: P.id,
      usd: { type: "number", description: "USDC amount in dollars (whole cents)" },
      eth: { type: "number", description: "ETH amount (alternative to usd)" } }, ["id"]),
    handler: async ({ id, usd, eth }) => {
      if ((usd == null) === (eth == null)) throw new Error("pass exactly one of usd or eth");
      const full = await resolveFullId(id);
      const { deployments } = await addresses();
      const txs = usd != null
        ? encodeFundTxs({ deployments, id: full, usd: Number(usd) })
        : encodeFundTxs({ deployments, id: full, ethWei: BigInt(Math.round(Number(eth) * 1e18)) });
      return { id: full, transactions: txs, next: `sign+send in order, then claim_hint { id: "${full}" }` };
    },
  },
  {
    name: "build_stop",
    description: "Unsigned setActive(false) transaction: stops billing-eligible work on-chain (owner-only on-chain; the tx reverts for non-owners). The runner tears the instance down on its next ledger pass, or immediately via terminate_hosted. Remaining balance stays on the record for build_resume.",
    inputSchema: S({ id: P.id }, ["id"]),
    handler: async ({ id }) => {
      const full = await resolveFullId(id);
      const { deployments } = await addresses();
      return { id: full, transactions: [encodeSetActiveTx({ deployments, id: full, active: false })],
               next: "optionally terminate_hosted { id, token } for immediate teardown" };
    },
  },
  {
    name: "build_resume",
    description: "Unsigned setActive(true) transaction to resume a stopped deployment (owner only on-chain). Follow with claim_hint.",
    inputSchema: S({ id: P.id }, ["id"]),
    handler: async ({ id }) => {
      const full = await resolveFullId(id);
      const { deployments } = await addresses();
      return { id: full, transactions: [encodeSetActiveTx({ deployments, id: full, active: true })],
               next: `claim_hint { id: "${full}" } so the fleet picks it up now` };
    },
  },
  {
    name: "build_upgrade",
    description: "Unsigned setAppRef transaction switching a deployment to another version of its app (paid time and the endpoint carry over; the runner restarts it in place). Validates approval, the immutable share fit, and the publisher-fee snapshot, like the CLI. Default: the app's latest approved version.",
    inputSchema: S({ id: P.id, version: { type: "string", description: "Target version label (default: latest approved)" } }, ["id"]),
    handler: async ({ id, version }) => {
      const rev = await depRev();
      if (rev < 3) throw new Error("the live EnclaveDeployments contract predates version changes (deploymentsSchema < 3)");
      const full = await resolveFullId(id);
      const d = await depGet(full);
      const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(d.appRef || "");
      if (!m) throw new Error(`${full.slice(0, 10)}… references "${d.appRef}"; only catalog-versioned deployments can switch versions`);
      const app = (await catalogApps()).find((x) => x.appId.toLowerCase() === m[1].toLowerCase());
      if (!app) throw new Error(`the catalog has no app ${m[1]} (delisted?)`);
      const versions = await readVersions(app.appId, app.versionCount);
      let vi;
      if (version !== undefined) {
        vi = versions.findIndex((v) => v.version === version && !v.yanked);
        if (vi < 0) throw new Error(`app "${app.slug}" has no (un-yanked) version labeled "${version}"`);
      } else {
        vi = versions.findLastIndex((v) => !v.yanked && Number(v.approval) === 1);
        if (vi < 0) throw new Error(`app "${app.slug}" has no approved version`);
      }
      const ver = versions[vi];
      if (vi === Number(m[2])) return { id: full, note: `already runs ${app.slug}:${ver.version} (index ${vi}); nothing to do`, transactions: [] };
      if (Number(ver.approval) !== 1)
        throw new Error(`${app.slug}:${ver.version} is ${APPROVAL_WORD[Number(ver.approval)]}; runners only serve approved versions`);
      const pricing = await self("GET", "/v1/pricing").catch(() => null);
      const mins = minShares(ver, pricing);
      if (Number(d.gpuMilli) < mins.gpuMilli || Number(d.cpuMilli) < mins.cpuMilli)
        throw new Error(`${app.slug}:${ver.version} needs gpu ${mins.gpuMilli / 10}% / cpu ${mins.cpuMilli / 10}% but this deployment bought gpu ${Number(d.gpuMilli) / 10}% / cpu ${Number(d.cpuMilli) / 10}% and shares are immutable; deploy it fresh instead`);
      const newFee = await versionFee6(app.appId, vi);
      if (newFee > 0n) {
        const { deployments } = await addresses();
        const [snapTo, snapFee] = rev >= 4 ? await read(deployments, depsAbiFor(rev), "feeOf", [full])
                                           : ["0x0000000000000000000000000000000000000000", 0n];
        if (snapFee < newFee || String(snapTo).toLowerCase() !== app.publisher.toLowerCase())
          throw new Error(`${app.slug}:${ver.version} charges ${usdHr(newFee)} publisher fee, above this deployment's immutable create-time snapshot (${usdHr(snapFee)}); deploy it fresh instead`);
      }
      const { deployments } = await addresses();
      return { id: full, owner: d.owner, from: d.appRef, to: `catalog://${app.appId}/${vi}`, version: ver.version,
        transactions: [encodeSetAppRefTx({ deployments, id: full, appRef: `catalog://${app.appId}/${vi}` })],
        next: `sign+send with the owner wallet (${d.owner}), then claim_hint { id: "${full}" }` };
    },
  },
  {
    name: "build_publish",
    description: "Unsigned publishVersion transaction cutting a new catalog version from an already-pinned wasm CID (see upload_token / guide topic \"publish\" for the pin step). The version starts pending approval. feeUsdPerHour sets YOUR publisher fee, paid to the publishing wallet.",
    inputSchema: S({
      publisher: { type: "string", description: "The wallet that will sign (appId = keccak(publisher, slug))" },
      slug: { type: "string", description: "lowercase letters/digits/hyphens, max 40" },
      cid: { type: "string", description: "IPFS CID of the pinned wasm component" },
      version: { type: "string", description: "Free-form label (default: next integer for this app)" },
      name: { type: "string" }, description: { type: "string" },
      vramMb: { type: "number" }, gpuGflops: { type: "number" },
      memMb: { type: "number", description: "default 256" }, cpuGflops: { type: "number", description: "default 10" },
      ports: { type: "string", description: "CSV, e.g. \"http:8080,tcp:25565\"" },
      config: { type: "string", description: "Default/template ENCLAVE_CONFIG JSON (≤4096 bytes, immutable per version)" },
      feeUsdPerHour: { type: "number", description: "Publisher fee in USD per hour (0 = free; platform-capped)" },
    }, ["publisher", "slug", "cid"]),
    handler: async (a) => {
      if (!isAddr(a.publisher)) throw new Error("publisher must be a 0x… wallet address");
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.slug)) throw new Error("slug: lowercase letters, digits, hyphens (max 40)");
      if (a.config) {
        if (Buffer.byteLength(a.config) > 4096) throw new Error("config too long (max 4096 bytes)");
        let o; try { o = JSON.parse(a.config); } catch (e) { throw new Error("config isn't valid JSON: " + e.message); }
        if (!o || Array.isArray(o) || typeof o !== "object") throw new Error("config must be a JSON object");
      }
      const rev = await catRev();
      if (a.config && rev < 4) throw new Error("config needs the rev-4 catalog");
      const feeUsdHr = Number(a.feeUsdPerHour) || 0;
      if (feeUsdHr < 0) throw new Error("feeUsdPerHour can't be negative");
      const feePerSec6 = BigInt(Math.round(feeUsdHr * 1e6 / 3600));
      const { appCatalog } = await addresses();
      if (feePerSec6 > 0n) {
        if (rev < 5) throw new Error("publisher fees need the rev-5 catalog; publish free or wait for the catalog upgrade");
        const max = await read(appCatalog, U256_VIEW("maxFeePerSec6"), "maxFeePerSec6");
        if (feePerSec6 > max) throw new Error(`feeUsdPerHour ${feeUsdHr} is over the platform cap of ${usdHr(max)}`);
      }
      const appId = await read(appCatalog, catAbiFor(rev), "appIdOf", [a.publisher, a.slug]);
      const existing = Number(await read(appCatalog, catAbiFor(rev), "numVersions", [appId]).catch(() => 0n));
      const version = a.version || String(existing + 1);
      const res = [Math.round(Number(a.vramMb) || 0), Math.round(Number(a.gpuGflops) || 0),
                   Math.round(Number(a.memMb) || 256), Math.round(Number(a.cpuGflops) || 10)];
      return {
        slug: a.slug, version, appId, cid: a.cid,
        publisherFeePerHour: feePerSec6 > 0n ? usdHr(feePerSec6) : null,
        transactions: [encodePublishTx({ rev, appCatalog, slug: a.slug, name: a.name || a.slug,
          description: a.description || "", version, cid: a.cid, res, ports: a.ports || "",
          config: a.config || "", feePerSec6 })],
        next: `sign+send with ${a.publisher} (the publisher identity). Approval starts pending; deploy once approved: plan_deploy { app: "${a.slug}:${version}" }`,
      };
    },
  },
];

// ---- MCP protocol (Streamable HTTP, stateless JSON mode) ----------------------
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "enclave", title: "Enclave (enclave.host)", version: "1.0.0" };
const INSTRUCTIONS = `Enclave runs apps inside hardware TEE enclaves, paid per second in USDC on Base. This server exposes the FULL platform surface for coding agents. Trust model: no tool ever sees a private key. Reads are direct; every state change returns UNSIGNED Base (chainId ${CHAIN_ID}) transactions to sign with the user's own wallet, and signature flows (sign-in, uploads) take locally produced signatures. Start with the guide tool (topic "getting-started"). Typical deploy: list_apps -> plan_deploy -> sign+send create -> build_fund -> sign+send -> claim_hint -> get_deployment until running.`;

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "600",
};
const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...MCP_CORS });
  res.end(JSON.stringify(body));
};
// JSON must never carry a BigInt to the wire
const clean = (o) => JSON.parse(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : v));

// modest per-IP shaping: chain-backed tools are cached, but tools/call still
// fans into RPCs — same token-bucket shape as api-relay's limiters
const buckets = new Map();
function allow(key, capacity = 120, refillPerSec = 10) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
  if (buckets.size > 10000) for (const [k, v] of buckets) { if (now - v.at > 300_000) buckets.delete(k); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

async function callTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool "${name}". tools/list has the catalog.` }], isError: true };
  for (const req of tool.inputSchema.required || [])
    if (args?.[req] === undefined)
      return { content: [{ type: "text", text: `Missing required argument "${req}" for ${name}.` }], isError: true };
  try {
    const out = await tool.handler(args || {}, ctx);
    if (typeof out === "string") return { content: [{ type: "text", text: out }] };
    const o = clean(out);
    return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }], structuredContent: o };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e?.shortMessage || e?.message || String(e)}` }], isError: true };
  }
}

async function dispatch(msg, ctx) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0")
    return rpcError(msg?.id, -32600, "Invalid Request: expected a JSON-RPC 2.0 message");
  const { id, method, params } = msg;
  if (method === undefined) return null;                       // a client response; nothing to do
  if (id === undefined || id === null) return null;            // notification (initialized, cancelled, ...)
  switch (method) {
    case "initialize": {
      const want = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      if (typeof params?.name !== "string") return rpcError(id, -32602, "params.name is required");
      return rpcResult(id, await callTool(params.name, params.arguments, ctx));
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function readBody(req, max = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (ch) => { n += ch.length; if (n > max) { req.destroy(); reject(new Error("body too large")); } else chunks.push(ch); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function isMcpHost(host) {
  return MCP_DOMAINS.includes(String(host || "").toLowerCase().split(":")[0]);
}

export async function handleMcp(req, res, _u) {
  if (req.method === "OPTIONS") { res.writeHead(204, MCP_CORS); return res.end(); }
  if (req.method === "GET") {
    // no server-initiated stream: SSE clients get the spec's 405; humans get directions
    if (/text\/event-stream/.test(req.headers.accept || ""))
      { res.writeHead(405, { Allow: "POST", ...MCP_CORS }); return res.end(); }
    return send(res, 200, { name: SERVER_INFO.name, protocol: "Model Context Protocol (Streamable HTTP)",
      endpoint: "POST JSON-RPC here", tools: TOOLS.length,
      connect: { "claude code": "claude mcp add --transport http enclave https://mcp.enclave.host/mcp",
                 generic: "POST initialize/tools/list/tools/call as JSON-RPC 2.0" },
      docs: "https://enclave.host/develop" });
  }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST, OPTIONS", ...MCP_CORS }); return res.end(); }
  const ipKey = (req.socket?.remoteAddress || "") + "|" + (req.headers["x-forwarded-for"] || "").split(",")[0];
  if (!allow(ipKey)) return send(res, 429, rpcError(null, -32000, "rate limited; retry shortly"));
  let body;
  try { body = JSON.parse((await readBody(req)).toString() || ""); }
  catch (e) { return send(res, 400, rpcError(null, -32700, "Parse error: " + e.message)); }
  const ctx = { token: req.headers.authorization || null };
  const wrap = (msg) => dispatch(msg, { ...ctx, token: msg?.params?.arguments?.token ?? ctx.token });
  if (Array.isArray(body)) {                                   // 2025-03-26 batching compat
    const out = (await Promise.all(body.map(wrap))).filter(Boolean);
    return out.length ? send(res, 200, out) : (res.writeHead(202, MCP_CORS), res.end());
  }
  const out = await wrap(body);
  return out ? send(res, 200, out) : (res.writeHead(202, MCP_CORS), res.end());
}
