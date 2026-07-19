// End-to-end tests for the enclave CLI (cli/enclave.mjs) against an offline
// double of the platform: a stub HTTP API (real SIWE verification, JWT-shaped
// tokens) and a stub Base JSON-RPC node (real calldata in, ABI-encoded answers
// out — transactions are signed by the CLI for real and decoded here).
//
//   run: node --test test/cli.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionResult, parseTransaction, verifyMessage, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "cli", "enclave.mjs");
// The checked-in ABIs describe the IN-REPO (next) contract revisions. The
// LIVE rev-3 ledger and rev-4 catalog still speak the pre-fee create /
// publishVersion shapes, so those legacy overloads ride along here - the
// stub decodes whatever the CLI sends for whichever revision it plays
// (S.depRev / S.catRev), exactly like the real chain would.
const CREATE_LEGACY = { type: "function", name: "create", stateMutability: "nonpayable",
  inputs: [{ name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
           { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
           { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
           { name: "configCid", type: "string" }],
  outputs: [{ type: "bytes32" }] };
const PUBLISH_LEGACY = { type: "function", name: "publishVersion", stateMutability: "nonpayable",
  inputs: [{ name: "slug", type: "string" }, { name: "name", type: "string" },
           { name: "description", type: "string" }, { name: "version", type: "string" },
           { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
           { name: "ports", type: "string" }, { name: "config", type: "string" }],
  outputs: [{ type: "bytes32" }, { type: "uint256" }] };
const DEP_ABI = [...JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "EnclaveDeployments.abi.json"), "utf8")), CREATE_LEGACY];
const CAT_ABI = [...JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "EnclaveAppCatalog.abi.json"), "utf8")), PUBLISH_LEGACY];

const PK = "0x" + "11".repeat(32);
const OWNER = privateKeyToAccount(PK).address;
// The stub chain answers at whatever addresses the CLI currently ships —
// read them from its DEFAULTS so scripts/sync-contract-addresses.sh (contract
// redeploys) can never desync these tests again.
const CLI_SRC = fs.readFileSync(CLI, "utf8");
const cliDefault = (key) => {
  const m = CLI_SRC.match(new RegExp(key + String.raw`:\s*"(0x[0-9a-fA-F]{40})"`));
  if (!m) throw new Error(`no ${key} default in cli/enclave.mjs`);
  return m[1].toLowerCase();
};
const DEPLOYMENTS = cliDefault("DEPLOYMENTS_ADDRESS");
const CATALOG = cliDefault("APP_CATALOG_ADDRESS");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const DEP_CREATED_TOPIC = "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239";
const ID = "0x" + "ab".repeat(32);                     // the id the stub chain mints
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const APP_ID = "0x" + "cd".repeat(32);

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (addr) => `${b64u({ alg: "HS256" })}.${b64u({ sub: addr, exp: Math.floor(Date.now() / 1000) + 43200 })}.stub`;
const dep32 = (x) => "0x" + x.replace(/^0x/, "").padStart(64, "0");

// ---- the platform double -----------------------------------------------------
// state the tests poke at between runs
const S = {
  logins: 0, apiCalls: [], txs: [],            // recorded traffic
  claimed: false,                              // get(ID) shows a live lease?
  active: true,                                // get(ID).active (false = suspended)
  apiDeployment: null,                         // GET /v1/deployments/:id answer
  numVersions: 0n,
  versionCount: 1,                             // catalog versions the stub app lists
  v2: null,                                    // overrides for the second version (upgrade tests)
  depRev: 3n,                                  // deploymentsSchema the stub plays (3 = the live pre-fee ledger)
  catRev: 4n,                                  // catalogSchema the stub plays (4 = the live pre-fee catalog)
  verFee: 0n,                                  // versionFee(appId, *) on the rev-5 catalog (µUSDC/s)
};

function apiServer() {
  const nonces = new Map();
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = ""; for await (const c of req) body += c;
    const json = (code, o, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(type === "application/json" ? JSON.stringify(o) : o); };
    S.apiCalls.push({ method: req.method, path: u.pathname, body, auth: req.headers.authorization || null });

    if (u.pathname === "/v1/auth/nonce") {
      const address = u.searchParams.get("address");
      const nonce = Math.random().toString(36).slice(2, 10);
      nonces.set(nonce, address);
      const message = `enclave.host wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Enclave. This signature is free and will not move funds.\n\nURI: https://enclave.host\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 600000).toISOString()}`;
      return json(200, { address, message, nonce });
    }
    if (u.pathname === "/v1/auth/login") {
      const { message, signature } = JSON.parse(body);
      const nonce = message.match(/\nNonce: (\S+)\n/)?.[1];
      const address = message.match(/^(0x[0-9a-fA-F]{40})$/m)?.[1];
      if (!nonces.has(nonce) || nonces.get(nonce) !== address) return json(401, { error: "bad_nonce" });
      if (!(await verifyMessage({ address, message, signature }))) return json(401, { error: "bad_sig" });
      S.logins++;
      return json(200, { token: jwt(address), tokenType: "Bearer", address });
    }
    const authed = /^Bearer .+/.test(req.headers.authorization || "");
    if (u.pathname === "/v1/deployments" && req.method === "GET")
      return authed ? json(200, { data: S.apiDeployment && S.claimed ? [S.apiDeployment] : [], cursor: null }) : json(401, { error: "auth" });
    if (u.pathname === "/v1/pricing")
      return json(200, {
        deploymentsContract: DEPLOYMENTS, chainId: 8453, usdc: USDC,
        usdcDomain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
        node: { vcpus: 32, ramGb: 32, gflops: 200, wholeNodePerSecondUsdc: 0.000556 },
        billingIncrementSeconds: 1,
      });
    if (u.pathname === "/availability")
      return json(200, { aggregate: true, enclaves: 2, gpuShareFree: 0.5, cpuShareFree: 0.9 });
    if (u.pathname === "/v1/claim-hint") { S.claimed = true; return json(200, { accepted: true, status: "sweeping" }); }
    if (u.pathname === "/v1/apps/upload-token" && req.method === "POST") {
      // wallet-signed upload authorization: recover the signer from the
      // enclave-upload:<sha256>:<expiry> message and hand back a one-time token,
      // exactly as api-relay does before the IPFS gateway will accept the bytes.
      const { hash, expiry, signature } = JSON.parse(body);
      const address = await recoverMessageAddress({ message: `enclave-upload:${hash}:${expiry}`, signature });
      return json(200, { token: `upload-${hash.slice(0, 16)}`, address, expiry });
    }
    if (u.pathname === "/v1/account")
      return authed ? json(200, { address: OWNER, chainId: 8453,
        payment: { forwarder: "0x" + "aa".repeat(20), usdc: USDC, assets: ["USDC", "ETH"] },
        deployments: { running: 1, awaitingPayment: 0, total: 1, totalTimeRemainingSec: 3600 } }) : json(401, { error: "auth" });
    const dep = u.pathname.match(/^\/v1\/deployments\/([^/]+)(\/.*)?$/);
    if (dep) {
      if (!authed) return json(401, { error: "auth" });
      const [, id, sub] = dep;
      if (sub === "/logs") return json(200, "hello from the app\n", "text/plain");
      if (req.method === "DELETE") return S.apiDeployment ? json(200, { id, status: "terminated", ranSeconds: 42 }) : json(404, { error: "not_found" });
      if (!sub) return S.apiDeployment && S.claimed ? json(200, S.apiDeployment) : json(404, { error: "not_found" });
    }
    json(404, { error: "no_route", path: u.pathname });
  });
}

// stub chain: answers eth_call by decoding real calldata against the checked-in
// ABIs, and accepts real signed transactions (decoded + recorded for asserts)
function rpcServer() {
  const depRecord = () => ({
    id: ID, owner: OWNER, appRef: "catalog://" + "0x" + "cd".repeat(32) + "/0", ports: "http:8088", configCid: "",
    gpuMilli: 0, cpuMilli: 10, appPort: 8088, isPublic: true, active: S.active,
    createdAt: BigInt(Math.floor(Date.now() / 1000) - 60), rate: 6n,
    balance6: 2_000000n, spent6: 0n,
    runner: S.claimed ? "0x" + "ee".repeat(32) : "0x" + "0".repeat(64),
    runnerOperator: S.claimed ? "0x" + "ee".repeat(20) : "0x" + "0".repeat(40),
    leaseUntil: S.claimed ? BigInt(Math.floor(Date.now() / 1000) + 1800) : 0n,
  });
  const version = { cid: CID, version: "1", vramMb: 0, gpuGflops: 0, memMb: 256, cpuGflops: 10,
                    createdAt: 1n, verified: true, yanked: false, ports: "http:8088", approval: 1,
                    config: "" };   // rev-3 Version tuple carries the default config
  const version2 = () => ({ ...version, version: "2", ...S.v2 });   // the upgrade target (S.v2 shapes it per test)
  function call(to, data) {
    const abi = to === DEPLOYMENTS ? DEP_ABI : to === CATALOG ? CAT_ABI
      : [{ type: "function", name: "balanceOf", stateMutability: "view",
           inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
    const { functionName, args } = decodeFunctionData({ abi, data });
    const out = {
      balanceOf: () => [100_000000n],
      pricePerSec6: () => [1667n],
      cpuPricePerSec6: () => [556n],
      get: () => [depRecord()],
      getPage: () => [Number(args[0]) === 0 ? [depRecord()] : []],
      count: () => [1n],
      secondsFundable: () => [333333n],
      appCount: () => [1n],
      catalogSchema: () => [S.catRev],       // default: the live (rev-4) catalog; fee tests flip to 5
      deploymentsSchema: () => [S.depRev],   // default: the live rev-3 ledger; fee tests flip to 4
      versionFee: () => [S.verFee],          // rev-5 surface (the CLI never calls it below rev 5)
      maxFeePerSec6: () => [1389n],          // the publish-time cap (~$5.00/hour)
      feeOf: () => [OWNER, S.verFee],        // rev-4 surface: the deployment's fee snapshot
      getAppsPage: () => [Number(args[0]) === 0 ? [{ appId: APP_ID, publisher: OWNER, slug: "hello-world",
        name: "Hello World", description: "first app", versionCount: S.versionCount, createdAt: 1n, updatedAt: 1n, active: true }] : []],
      getVersionsPage: () => [Number(args[1]) === 0 ? [version, version2()].slice(0, S.versionCount) : []],
      numVersions: () => [S.numVersions],
      appIdOf: () => [APP_ID],
      cidStatus: () => [true, APP_ID, 0n, 1, false, true, [0, 0, 256, 10]],
    }[functionName];
    if (!out) throw new Error("unhandled eth_call: " + functionName);
    const result = out();
    return encodeFunctionResult({ abi, functionName, result: result.length === 1 ? result[0] : result });
  }
  return http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
    try {
      switch (method) {
        case "eth_chainId": return reply("0x2105");
        case "eth_blockNumber": return reply("0x100");
        case "eth_getBalance": return reply("0xde0b6b3a7640000");           // 1 ETH
        case "eth_getTransactionCount": return reply("0x" + S.txs.length.toString(16));
        case "eth_maxPriorityFeePerGas": return reply("0xf4240");
        case "eth_estimateGas": return reply("0x30000");
        case "eth_gasPrice": return reply("0x3b9aca00");
        case "eth_getBlockByNumber": return reply({ number: "0x100", hash: "0x" + "12".repeat(32),
          baseFeePerGas: "0x3b9aca00", timestamp: "0x0", transactions: [] });
        case "eth_call": return reply(call(params[0].to.toLowerCase(), params[0].data));
        case "eth_sendRawTransaction": {
          const tx = parseTransaction(params[0]);
          const abi = tx.to.toLowerCase() === DEPLOYMENTS ? DEP_ABI : CAT_ABI;
          const dec = decodeFunctionData({ abi, data: tx.data });
          const hash = "0x" + (70 + S.txs.length).toString(16).padStart(64, "0");
          S.txs.push({ to: tx.to.toLowerCase(), value: tx.value || 0n, hash, ...dec });
          return reply(hash);
        }
        case "eth_getTransactionReceipt": {
          const tx = S.txs.find((t) => t.hash === params[0]);
          const logs = tx?.functionName === "create"
            ? [{ address: DEPLOYMENTS, topics: [DEP_CREATED_TOPIC, ID, dep32(OWNER)], data: "0x",
                 blockNumber: "0x100", blockHash: "0x" + "12".repeat(32), transactionHash: params[0],
                 transactionIndex: "0x0", logIndex: "0x0", removed: false }]
            : [];
          return reply({ transactionHash: params[0], transactionIndex: "0x0", blockNumber: "0x100",
            blockHash: "0x" + "12".repeat(32), from: OWNER, to: tx?.to || null, contractAddress: null,
            cumulativeGasUsed: "0x30000", gasUsed: "0x30000", effectiveGasPrice: "0x3b9aca00",
            status: "0x1", type: "0x2", logsBloom: "0x" + "0".repeat(512), logs });
        }
        default: throw new Error("unhandled rpc method: " + method);
      }
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } }));
    }
  });
}

function ipfsServer() {
  return http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (req.url !== "/add-wasm") { res.writeHead(404); return res.end(); }
    if (buf.readUInt32LE(0) !== 0x6d736100 || (buf[6] | (buf[7] << 8)) !== 1) {
      res.writeHead(415); return res.end("not a component");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ cid: CID }));
  });
}

// ---- harness -------------------------------------------------------------------
let apiPort, rpcPort, ipfsPort, confDir;
const servers = [];
test.before(async () => {
  confDir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-cli-test-"));
  for (const [mk, set] of [[apiServer, (p) => apiPort = p], [rpcServer, (p) => rpcPort = p], [ipfsServer, (p) => ipfsPort = p]]) {
    const s = mk(); servers.push(s);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    set(s.address().port);
  }
});
test.after(() => servers.forEach((s) => s.close()));

function run(cliArgs, { input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...cliArgs, "--yes"], {
      env: { ...process.env, ENCLAVE_KEY: PK,
             ENCLAVE_API_BASE: `http://127.0.0.1:${apiPort}`,
             ENCLAVE_RPC: `http://127.0.0.1:${rpcPort}`,
             ENCLAVE_IPFS_UPLOAD: `http://127.0.0.1:${ipfsPort}/add-wasm`,
             ENCLAVE_ADDRESS_BOOK: "",   // opt out of the on-chain address book: the double must stay offline (and the 4s resolve cap × every invocation would blow the suite timeout)
             XDG_CONFIG_HOME: confDir },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => err += d);
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// ---- tests -----------------------------------------------------------------------
test("whoami: address + balances from chain, SIWE login verified server-side", async () => {
  const r = await run(["whoami", "--json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.address, OWNER);
  assert.equal(j.usdc6, "100000000");                       // stub balanceOf
  assert.equal(S.logins, 1);                                // one real SIWE round-trip
});

test("bearer tokens are cached across invocations", async () => {
  const before = S.logins;
  const r = await run(["account", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).deployments.running, 1);
  const acct = S.apiCalls.findLast((c) => c.path === "/v1/account");
  assert.match(acct.auth, /^Bearer /);
  assert.equal(S.logins, before);                           // no new login: cache hit
});

test("ls: merges the API view with on-chain queue items", async () => {
  S.claimed = false; S.apiDeployment = null;
  const r = await run(["ls", "--json"]);
  assert.equal(r.code, 0, r.err);
  const rows = JSON.parse(r.out).deployments;
  assert.equal(rows.length, 1);                             // chain-only (unclaimed) row
  assert.equal(rows[0].id, ID);
  assert.equal(rows[0].status, "queued");
  assert.match(rows[0].app, /^catalog:\/\/0x[0-9a-f]{64}\/0$/);
});

test("deploy: create tx -> Created id, EIP-3009 fund bound to id, claim-hint, wait, URL", async () => {
  S.claimed = false; S.txs.length = 0;
  S.apiDeployment = { id: ID, status: "running", image: { reference: `catalog://${APP_ID}/0` },
                      resources: { gpuShare: 0, cpuShare: 0.01 }, timeRemainingSec: 3600, public: true };
  const r = await run(["deploy", "hello-world:1", "--fund", "2"]);
  assert.equal(r.code, 0, r.err);

  const create = S.txs.find((t) => t.functionName === "create");
  assert.ok(create, "create tx sent");
  const [appRef, gpuMilli, cpuMilli, appPort, ports, isPublic] = create.args;
  assert.equal(appRef, `catalog://${APP_ID}/0`);            // slug:version -> its on-chain version RECORD
  assert.equal(gpuMilli, 0);
  assert.equal(cpuMilli, 50);                               // app minimum: max(256MB/32GB, 10Gf/200Gf) -> 5%
  assert.equal(appPort, 8088);                              // from the version's http:8088
  assert.equal(ports, "http:8088");
  assert.equal(isPublic, true);

  const fund = S.txs.find((t) => t.functionName === "fundWithAuthorization");
  assert.ok(fund, "fund tx sent");
  const [fid, from, value, , , nonce] = fund.args;
  assert.equal(fid, ID);
  assert.equal(from, OWNER);
  assert.equal(value, 2_000000n);                           // $2 -> 6dp
  assert.equal(nonce.slice(0, 34), ID.slice(0, 34));        // EIP-3009 nonce bound to id[0:16]
  assert.equal(fund.to, DEPLOYMENTS);

  const hint = S.apiCalls.find((c) => c.path === "/v1/claim-hint");
  assert.ok(hint, "claim-hint posted");
  assert.equal(JSON.parse(hint.body).id, ID);
  assert.match(r.out, new RegExp(`/x/${ID}`));              // direct-base URL form
  assert.match(r.out, /running/);
});

test("logs: prints the deployment's output", async () => {
  const r = await run(["logs", ID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hello from the app/);
});

test("status: merges API record and ledger lease", async () => {
  const r = await run(["status", ID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /running/);
  assert.match(r.out, /lease/);
  assert.match(r.out, /on-chain/);
});

test("id prefixes resolve against the ledger", async () => {
  const r = await run(["status", ID.slice(0, 12), "--json"]);   // 10 hex chars
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).chain.id, ID);
});

test("fund: tops up an existing deployment with USDC", async () => {
  S.txs.length = 0;
  const r = await run(["fund", ID, "--usdc", "5"]);
  assert.equal(r.code, 0, r.err);
  const fund = S.txs.find((t) => t.functionName === "fundWithAuthorization");
  assert.equal(fund.args[2], 5_000000n);
  assert.match(r.out, /balance \$2\.00/);                   // stub balance readback
});

test("stop: setActive(false) on-chain, then DELETE", async () => {
  S.txs.length = 0;
  const r = await run(["stop", ID]);
  assert.equal(r.code, 0, r.err);
  const sa = S.txs.find((t) => t.functionName === "setActive");
  assert.deepEqual(sa.args, [ID, false]);
  const del = S.apiCalls.findLast((c) => c.path === `/v1/deployments/${ID}` && c.method === "DELETE");
  assert.ok(del, "DELETE sent");
  assert.match(r.out, /terminated/);
});

test("resume: setActive(true) on-chain + claim-hint nudge", async () => {
  S.txs.length = 0; S.active = false;                       // the ledger shows a suspended record
  const r = await run(["resume", ID]);
  assert.equal(r.code, 0, r.err);
  const sa = S.txs.find((t) => t.functionName === "setActive");
  assert.deepEqual(sa.args, [ID, true]);
  const hint = S.apiCalls.findLast((c) => c.path === "/v1/claim-hint" && c.method === "POST");
  assert.ok(hint, "claim-hint posted");
  assert.equal(JSON.parse(hint.body).id, ID);
  assert.match(r.out, /re-queued/);
  S.active = true;
});

test("resume of an already-active deployment sends no tx", async () => {
  S.txs.length = 0;
  const r = await run(["resume", ID]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!S.txs.some((t) => t.functionName === "setActive"), "no setActive tx");
  assert.match(r.out, /already active/);
});

test("upgrade: setAppRef to the latest approved version + claim-hint nudge", async () => {
  // a second, smaller approved release exists; the deployment (10% cpu) fits it
  S.txs.length = 0; S.claimed = true; S.versionCount = 2; S.v2 = { memMb: 64, cpuGflops: 2 };
  const r = await run(["upgrade", ID]);
  assert.equal(r.code, 0, r.err);
  const tx = S.txs.find((t) => t.functionName === "setAppRef");
  assert.ok(tx, "setAppRef tx sent");
  assert.equal(tx.args[0].toLowerCase(), ID.toLowerCase());
  assert.equal(tx.args[1], `catalog://${APP_ID}/1`);        // newest approved version's RECORD
  const hint = S.apiCalls.findLast((c) => c.path === "/v1/claim-hint" && c.method === "POST");
  assert.ok(hint, "claim-hint posted");
  assert.match(r.out, /switched to hello-world:2/);
  assert.match(r.out, /restarts the app in place/);         // leased: the runner applies it live
  S.versionCount = 1; S.v2 = null; S.claimed = false;
});

test("upgrade refuses a version that outgrows the deployment's immutable shares", async () => {
  // 50 GB of RAM on the stub's 32 GB node = a 100% cpu share; the record bought 1%
  S.txs.length = 0; S.versionCount = 2; S.v2 = { memMb: 51200 };
  const r = await run(["upgrade", ID, "2"]);
  assert.notEqual(r.code, 0, "must refuse before any signature");
  assert.ok(!S.txs.length, "no tx sent");
  assert.match(r.err, /needs at least/);
  assert.match(r.err, /shares are immutable/);
  S.versionCount = 1; S.v2 = null;
});

test("upgrade to the version already running is a no-op", async () => {
  S.txs.length = 0; S.versionCount = 2; S.v2 = { memMb: 64, cpuGflops: 2 };
  const r = await run(["upgrade", ID, "1"]);                // the record points at index 0 = "1"
  assert.equal(r.code, 0, r.err);
  assert.ok(!S.txs.length, "no tx sent");
  assert.match(r.out, /already runs hello-world:1/);
  S.versionCount = 1; S.v2 = null;
});

test("publish: validates the component, pins, cuts a catalog version", async () => {
  S.txs.length = 0; S.numVersions = 0n;
  const wasm = path.join(confDir, "app.wasm");
  // minimal component preamble: \0asm, version 13, layer 1 (a component)
  fs.writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]));
  const r = await run(["publish", wasm, "--slug", "hello-world"]);
  assert.equal(r.code, 0, r.err);
  const pv = S.txs.find((t) => t.functionName === "publishVersion");
  const [slug, name, , version, cid, res, ports] = pv.args;
  assert.equal(slug, "hello-world");
  assert.equal(name, "hello-world");
  assert.equal(version, "1");                               // numVersions=0 -> "1"
  assert.equal(cid, CID);
  assert.deepEqual([...res], [0, 0, 256, 10]);              // default resource spec
  assert.equal(ports, "");
  assert.match(r.out, /approval is pending/);
});

/* ---- the publisher-fee surface (rev-4 ledger + rev-5 catalog) ------------ */
test("deploy snapshots a paid app's publisher fee into create (rev-4 ledger)", async () => {
  S.claimed = false; S.txs.length = 0; S.depRev = 4n; S.catRev = 5n; S.verFee = 278n;   // ~$1.00/hr
  S.apiDeployment = { id: ID, status: "running", image: { reference: `catalog://${APP_ID}/0` },
                      resources: { gpuShare: 0, cpuShare: 0.01 }, timeRemainingSec: 3600, public: true };
  const r = await run(["deploy", "hello-world:1", "--fund", "2"]);
  assert.equal(r.code, 0, r.err);
  const create = S.txs.find((t) => t.functionName === "create");
  assert.ok(create, "create tx sent");
  assert.equal(create.args.length, 9);                      // rev-4 shape: fee snapshot appended
  const [, , , , , , , feeRecipient, feePerSec6] = create.args;
  assert.equal(feeRecipient, OWNER);                        // the app's publisher wallet
  assert.equal(feePerSec6, 278n);                           // the version's fee, copied verbatim
  assert.match(r.out, /publisher fee/);                     // said out loud before the confirm
  S.depRev = 3n; S.catRev = 4n; S.verFee = 0n;
});

test("deploy refuses a paid app on a pre-fee ledger (fail closed, before any tx)", async () => {
  S.txs.length = 0; S.depRev = 3n; S.catRev = 5n; S.verFee = 278n;
  const r = await run(["deploy", "hello-world:1", "--fund", "2"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /publisher fee.*predates/i);
  assert.ok(!S.txs.length, "no tx sent");
  S.catRev = 4n; S.verFee = 0n;
});

test("publish --fee cuts a rev-5 version carrying the fee", async () => {
  S.txs.length = 0; S.numVersions = 0n; S.catRev = 5n;
  const wasm = path.join(confDir, "app-fee.wasm");
  fs.writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]));
  const r = await run(["publish", wasm, "--slug", "hello-world", "--fee", "1"]);
  assert.equal(r.code, 0, r.err);
  const pv = S.txs.find((t) => t.functionName === "publishVersion");
  assert.ok(pv, "publishVersion tx sent");
  assert.equal(pv.args.length, 9);                          // rev-5 shape: fee appended
  assert.equal(pv.args[8], 278n);                           // $1/hr -> µUSDC per second
  S.catRev = 4n;
});

test("publish --fee above the on-chain cap refuses with the ceiling", async () => {
  S.txs.length = 0; S.catRev = 5n;
  const wasm = path.join(confDir, "app-fee.wasm");
  fs.writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]));
  const r = await run(["publish", wasm, "--slug", "hello-world", "--fee", "6"]);   // 6 $/hr -> 1667 > 1389
  assert.equal(r.code, 1);
  assert.match(r.err, /over the platform's cap/);
  assert.ok(!S.txs.length, "no tx sent");
  S.catRev = 4n;
});

test("publish rejects a core wasm module (layer 0)", async () => {
  const wasm = path.join(confDir, "core.wasm");
  fs.writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  const r = await run(["publish", wasm, "--slug", "hello-world"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /core wasm module, not a component/);
});

test("apps: lists the catalog with approval state", async () => {
  const r = await run(["apps"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hello-world:1/);
  assert.match(r.out, /approved/);
});

test("availability + pricing render the fleet numbers", async () => {
  const a = await run(["availability"]);
  assert.match(a.out, /2 live enclave/);
  const p = await run(["pricing"]);
  assert.match(p.out, /cpu node/);
  assert.match(p.out, new RegExp(DEPLOYMENTS, "i"));
});
