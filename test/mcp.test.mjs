// MCP endpoint (relay/mcp.js) — two layers.
//
// 1. The unsigned-transaction encoders are decoded BACK against the checked-in
//    contract ABI artifacts (contracts/*.abi.json, the authority the deploy
//    scripts emit) — not against mcp.js's own hand-mirrored ABI — so a drift
//    between the mirrored shapes and the real contracts breaks the build.
// 2. The protocol surface is driven end-to-end through a REAL api-relay child
//    (Host-dispatched via x-forwarded-host: mcp.enclave.host and
//    path-dispatched via /mcp), with a stub enclave behind the gateway so the
//    self-looped read tools answer, and a real wallet signature exercising the
//    upload-token mint. Chain-backed tools (catalog, tx planning) are covered
//    by layer 1 plus the CLI tests; the integration layer deliberately never
//    touches a real RPC.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { encodeCreateTx, encodeFundTxs, encodeSetActiveTx, encodeSetAppRefTx, encodePublishTx }
  from "../relay/mcp.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_DIR = path.join(ROOT, "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DEPS_ABI = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "EnclaveDeployments.abi.json")));
const CAT_ABI = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "EnclaveAppCatalog.abi.json")));

const D = "0x" + "d1".repeat(20);                              // deployments address (any)
const C = "0x" + "c1".repeat(20);                              // catalog address
const ID = "0x" + "ab".repeat(32);
const FEE_TO = "0x" + "fe".repeat(20);

// ---------- 1. encoders vs the checked-in ABI artifacts -----------------------
test("mcp encoders: create() calldata decodes against contracts/EnclaveDeployments.abi.json", () => {
  const tx = encodeCreateTx({ rev: 4, deployments: D, appRef: "catalog://" + ID + "/2",
    gpuMilli: 250, cpuMilli: 50, appPort: 8080, ports: "http:8080,tcp:7777", isPublic: true,
    envelope: '{"waf":{"rps":10}}', feeRecipient: FEE_TO, feePerSec6: 28n });
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.to, D);
  assert.equal(tx.value, "0x0");
  const { functionName, args } = decodeFunctionData({ abi: DEPS_ABI, data: tx.data });
  assert.equal(functionName, "create");
  assert.equal(args.length, 9, "rev-4 nine-arg create");
  assert.equal(args[0], "catalog://" + ID + "/2");
  assert.equal(args[1], 250);
  assert.equal(args[2], 50);
  assert.equal(args[3], 8080);
  assert.equal(args[4], "http:8080,tcp:7777");
  assert.equal(args[5], true);
  assert.equal(args[6], '{"waf":{"rps":10}}');
  assert.equal(String(args[7]).toLowerCase(), FEE_TO);
  assert.equal(args[8], 28n);
});

test("mcp encoders: USDC funding is approve + fund, whole cents only", () => {
  const [approve, fund] = encodeFundTxs({ deployments: D, id: ID, usd: 5 });
  const ERC20 = [{ type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] }];
  const a = decodeFunctionData({ abi: ERC20, data: approve.data });
  assert.equal(approve.to, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "approve targets Base USDC");
  assert.equal(String(a.args[0]).toLowerCase(), D);
  assert.equal(a.args[1], 5_000_000n, "$5 = 5e6 at 6dp");
  const f = decodeFunctionData({ abi: DEPS_ABI, data: fund.data });
  assert.equal(f.functionName, "fund");
  assert.deepEqual(f.args, [ID, 5_000_000n]);
  assert.throws(() => encodeFundTxs({ deployments: D, id: ID, usd: 0.005 }), /minimum/);
  assert.throws(() => encodeFundTxs({ deployments: D, id: ID, usd: 1.234 }), /whole cents/);
});

test("mcp encoders: fundEth carries the wei as tx value", () => {
  const [tx] = encodeFundTxs({ deployments: D, id: ID, ethWei: 2_000_000_000_000_000n });
  const { functionName, args } = decodeFunctionData({ abi: DEPS_ABI, data: tx.data });
  assert.equal(functionName, "fundEth");
  assert.deepEqual(args, [ID]);
  assert.equal(BigInt(tx.value), 2_000_000_000_000_000n);
});

test("mcp encoders: setActive / setAppRef decode against the ledger ABI", () => {
  const stop = decodeFunctionData({ abi: DEPS_ABI, data: encodeSetActiveTx({ deployments: D, id: ID, active: false }).data });
  assert.equal(stop.functionName, "setActive");
  assert.deepEqual(stop.args, [ID, false]);
  const up = decodeFunctionData({ abi: DEPS_ABI, data: encodeSetAppRefTx({ deployments: D, id: ID, appRef: "catalog://" + ID + "/3" }).data });
  assert.equal(up.functionName, "setAppRef");
  assert.deepEqual(up.args, [ID, "catalog://" + ID + "/3"]);
});

test("mcp encoders: publishVersion (rev 5) decodes against contracts/EnclaveAppCatalog.abi.json", () => {
  const tx = encodePublishTx({ rev: 5, appCatalog: C, slug: "my-app", name: "My App",
    description: "d", version: "3", cid: "bafy" + "a".repeat(46), res: [0, 0, 256, 10],
    ports: "http:8080", config: '{"MODEL":"x"}', feePerSec6: 28n });
  const { functionName, args } = decodeFunctionData({ abi: CAT_ABI, data: tx.data });
  assert.equal(functionName, "publishVersion");
  assert.equal(args.length, 9, "rev-5 nine-arg overload");
  assert.deepEqual(args.slice(0, 5), ["my-app", "My App", "d", "3", "bafy" + "a".repeat(46)]);
  assert.deepEqual(args[5], [0, 0, 256, 10]);
  assert.equal(args[6], "http:8080");
  assert.equal(args[7], '{"MODEL":"x"}');
  assert.equal(args[8], 28n);
});

// ---------- 2. protocol, through a real api-relay child ------------------------
async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}
function stubEnclave() {
  return http.createServer((req, res) => {
    const j = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/availability") return j({ gpu: true, gpuShareFree: 1, cpuShareFree: 1, maxShare: 1 });
    if (req.url === "/v1/pricing") return j({ model: "stub-pricing", card: { vramGb: 80, tflops: 100 }, node: { ramGb: 100, gflops: 5000 } });
    res.statusCode = 404; j({ error: "not_found" });
  });
}
// the child's BASE_RPC: answers every eth_call with empty data, so mcp.js's
// address-book refresh fails decode and keeps its baked defaults — and nothing
// in this test ever reaches a real RPC
function stubRpc() {
  return http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => ({ jsonrpc: "2.0", id: m.id, result: "0x" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
}
const UPLOAD_KEY = "test-upload-key";
async function startRelay(t) {
  const enclave = stubEnclave(); enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  const rpc = stubRpc(); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
    env: { ...process.env, ENCLAVES: `http://127.0.0.1:${enclave.address().port}`,
           API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
           BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0",
           ADDRESS_BOOK_ADDRESS: "", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
           APP_DOMAIN: "app.enclave.host", UPLOAD_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write("[relay] " + d));
  t.after(() => { child.kill("SIGKILL"); enclave.close(); rpc.close(); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + "/health"); if (r.ok) return origin; } catch {}
    await delay(100);
  }
  throw new Error("relay never answered /health");
}
// POST a JSON-RPC message to the MCP surface (Host-dispatched: the relay
// trusts x-forwarded-host by default, which is also how Caddy hands it over)
async function mcp(origin, body, { pathName = "/", status } = {}) {
  const r = await fetch(origin + pathName, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": "mcp.enclave.host" },
    body: JSON.stringify(body),
  });
  if (status !== undefined) assert.equal(r.status, status);
  return r.status === 202 ? null : r.json();
}
const call = (origin, name, args) =>
  mcp(origin, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("mcp protocol: full surface through the relay", async (t) => {
  const origin = await startRelay(t);

  // -- initialize: version echo, identity, stateless (no session header)
  const init = await mcp(origin, { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal(init.result.protocolVersion, "2025-03-26", "a supported client version is echoed");
  assert.equal(init.result.serverInfo.name, "enclave");
  assert.ok(init.result.capabilities.tools, "declares the tools capability");
  assert.match(init.result.instructions, /unsigned/i, "instructions state the no-keys trust model");
  const initFuture = await mcp(origin, { jsonrpc: "2.0", id: 2, method: "initialize",
    params: { protocolVersion: "2099-01-01" } });
  assert.equal(initFuture.result.protocolVersion, "2025-06-18", "unknown client versions get our latest");

  // -- notifications get 202 and no body
  await mcp(origin, { jsonrpc: "2.0", method: "notifications/initialized" }, { status: 202 });

  // -- batch compat (2025-03-26 clients may batch)
  const batch = await mcp(origin, [
    { jsonrpc: "2.0", id: 10, method: "ping" },
    { jsonrpc: "2.0", id: 11, method: "nope/nope" },
  ]);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0].result, {});
  assert.equal(batch[1].error.code, -32601);

  // -- tools/list: every tool is well-formed
  const list = await mcp(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const tools = list.result.tools;
  assert.ok(tools.length >= 24, `expected the full surface, got ${tools.length}`);
  for (const tl of tools) {
    assert.ok(tl.name && tl.description, tl.name + " has a description");
    assert.equal(tl.inputSchema.type, "object");
  }
  const names = new Set(tools.map((x) => x.name));
  for (const n of ["guide", "pricing", "availability", "list_apps", "get_app", "plan_deploy",
                   "build_fund", "build_stop", "build_resume", "build_upgrade", "build_publish",
                   "upload_token", "auth_nonce", "auth_login", "claim_hint", "get_deployment",
                   "deployment_logs", "fleet_attestation"])
    assert.ok(names.has(n), "tool " + n);

  // -- guide (static, no upstream)
  const guide = await call(origin, "guide", { topic: "getting-started" });
  assert.ok(!guide.result.isError);
  assert.match(guide.result.content[0].text, /plan_deploy/);

  // -- read tools loop through the relay's own gateway to the stub enclave
  const pricing = await call(origin, "pricing", {});
  assert.equal(pricing.result.structuredContent.model, "stub-pricing");
  const avail = await call(origin, "availability", {});
  assert.equal(avail.result.structuredContent.aggregate, true, "fleet-aggregate view");
  assert.equal(avail.result.structuredContent.enclaves, 1);

  // -- upload_token: a real wallet signature buys a real HMAC mint
  const account = privateKeyToAccount("0x" + "11".repeat(32));
  const hash = createHash("sha256").update("wasm bytes").digest("hex");
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const signature = await account.signMessage({ message: `enclave-upload:${hash}:${expiry}` });
  const tok = await call(origin, "upload_token", { hash, expiry, signature });
  assert.ok(!tok.result.isError, JSON.stringify(tok.result));
  const sc = tok.result.structuredContent;
  assert.equal(sc.address, account.address.toLowerCase());
  assert.equal(sc.token, createHmac("sha256", UPLOAD_KEY).update(`${sc.address}:${hash}:${expiry}`).digest("hex"),
    "the minted token is the add-gateway's exact HMAC");
  assert.match(sc.upload, /add-wasm/);

  // -- owner-only tools refuse without a token, pointing at the auth flow
  const logs = await call(origin, "deployment_logs", { id: "0x" + "ab".repeat(32) });
  assert.equal(logs.result.isError, true);
  assert.match(logs.result.content[0].text, /auth_nonce/);

  // -- tool errors are in-band, not JSON-RPC errors
  const nope = await call(origin, "no_such_tool", {});
  assert.equal(nope.result.isError, true);
  const missing = await call(origin, "get_deployment", {});
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /required/);

  // -- unknown method is a JSON-RPC error
  const bad = await mcp(origin, { jsonrpc: "2.0", id: 9, method: "resources/read" });
  assert.equal(bad.error.code, -32601);

  // -- transport shape: GET is informational for humans, 405 for SSE; DELETE 405
  const getInfo = await fetch(origin + "/", { headers: { "x-forwarded-host": "mcp.enclave.host" } });
  assert.equal(getInfo.status, 200);
  assert.equal((await getInfo.json()).name, "enclave");
  const sse = await fetch(origin + "/", { headers: { "x-forwarded-host": "mcp.enclave.host", accept: "text/event-stream" } });
  assert.equal(sse.status, 405, "no server-initiated stream: SSE GET is refused");
  const del = await fetch(origin + "/", { method: "DELETE", headers: { "x-forwarded-host": "mcp.enclave.host" } });
  assert.equal(del.status, 405, "stateless server: nothing to DELETE");

  // -- CORS: any origin, tools headers allowed (agents in browsers)
  const pre = await fetch(origin + "/", { method: "OPTIONS", headers: { "x-forwarded-host": "mcp.enclave.host" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-headers"), /Authorization/);

  // -- path dispatch: /mcp works on the API host itself (no mcp Host needed)
  const viaPath = await fetch(origin + "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(viaPath.status, 200);
  assert.deepEqual((await viaPath.json()).result, {});

  // -- and an app subdomain's own /mcp path is NOT shadowed by ours: it keeps
  // routing to the deployment (404s here because no enclave owns that id)
  const appHost = await fetch(origin + "/mcp", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": "0123abcd.app.enclave.host" },
    body: "{}",
  });
  assert.equal(appHost.status, 404, "app-subdomain /mcp stays tenant namespace");
});
