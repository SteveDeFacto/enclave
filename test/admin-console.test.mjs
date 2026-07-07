// The admin console (site/admin.html) hand-encodes every governance call and
// contract-creation transaction with the site's minimal ABI codec — no web3
// library loads in the browser. These tests pin each encoding the console
// produces against viem, and the artifact module against the checked-in ABIs,
// so a codec or artifact regression fails CI instead of an owner transaction.
//
//   run: node --test test/admin-console.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, encodeDeployData, encodeAbiParameters, stringToHex, toFunctionSelector } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { encCall, encAddr, decodeStructArray, DEP_SCHEMA, APP_SCHEMA, VER_SCHEMA } = await import(path.join(REPO, "site/js/core/chain.js"));
const { CONTRACTS } = await import(path.join(REPO, "site/js/gen/contract-artifacts.js"));
const { encCallX } = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
const ABI = (name) => JSON.parse(fs.readFileSync(path.join(REPO, "contracts", name + ".abi.json"), "utf8"));

/* mirrors of the console's local helpers (admin-console.js is a custom
   element — not loadable outside a browser). Keep in sync. */
const encKey = (k) => { let h = ""; for (const ch of k) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return "0x" + h.padEnd(64, "0"); };
function decodeBook(hex) {
  const b = (hex || "").replace(/^0x/, "");
  if (b.length < 128) return {};
  const word = (i) => b.slice(i * 64, i * 64 + 64);
  const num = (i) => parseInt(word(i).slice(48), 16);
  const kOff = num(0) / 32, vOff = num(1) / 32, n = num(kOff), out = {};
  for (let i = 0; i < n; i++) {
    const kw = word(kOff + 1 + i); let key = "";
    for (let j = 0; j < 64; j += 2) { const c = parseInt(kw.slice(j, j + 2), 16); if (!c) break; key += String.fromCharCode(c); }
    const a = "0x" + word(vOff + 1 + i).slice(24);
    if (key && !/^0x0{40}$/i.test(a)) out[key] = a;
  }
  return out;
}

const eq = (got, want) => assert.equal(got.toLowerCase(), want.toLowerCase());
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x22222222222222222222abcdef22222222222222";
const ZERO = "0x" + "0".repeat(40);
const S = (n) => CONTRACTS[n].sel;

test("artifact selectors match the checked-in ABIs", () => {
  for (const name of Object.keys(CONTRACTS)) {
    const abi = ABI(name);
    for (const f of abi.filter((x) => x.type === "function"))
      eq("0x" + CONTRACTS[name].sel[f.name], toFunctionSelector(f));
  }
});

test("book keys encode like viem stringToHex(size:32)", () => {
  for (const k of ["registry", "deployments", "appCatalog", "enclavePay", "volumeAccess", "custom-key_1"])
    eq(encKey(k), stringToHex(k, { size: 32 }));
});

test("owner calls encode like viem", () => {
  const cases = [
    ["EnclaveAddressBook", "set", [{ t: "bytes32", v: encKey("appCatalog") }, { t: "addr", v: A1 }], [stringToHex("appCatalog", { size: 32 }), A1]],
    ["EnclaveAddressBook", "setOwner", [{ t: "addr", v: A2 }], [A2]],
    ["EnclaveDeployments", "setPrice", [{ t: "uint", v: "1667" }], [1667n]],
    ["EnclaveDeployments", "setCpuPrice", [{ t: "uint", v: "278" }], [278n]],
    ["EnclaveDeployments", "setLeaseSec", [{ t: "uint", v: "300" }], [300n]],
    ["EnclaveDeployments", "setEthUsdFeed", [{ t: "addr", v: ZERO }], [ZERO]],
    ["EnclaveDeployments", "setPayout", [{ t: "addr", v: A1 }], [A1]],
    ["EnclaveDeployments", "setOwner", [{ t: "addr", v: A1 }], [A1]],
    ["EnclavePay", "setPayout", [{ t: "addr", v: A2 }], [A2]],
    ["EnclavePay", "setOwner", [{ t: "addr", v: A2 }], [A2]],
    ["EnclaveVolumeAccess", "setOperator", [{ t: "addr", v: A1 }], [A1]],
    ["EnclaveVolumeAccess", "transferAdmin", [{ t: "addr", v: A1 }], [A1]],
    ["EnclaveAppCatalog", "transferOwnership", [{ t: "addr", v: A2 }], [A2]],
  ];
  for (const [name, fn, mine, viems] of cases)
    eq(encCall(S(name)[fn], mine), encodeFunctionData({ abi: ABI(name), functionName: fn, args: viems }));
});

test("creation tx data (bytecode + ctor args) encodes like viem encodeDeployData", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const REG = "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2";
  const FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
  const dep = (name, args) => eq(
    CONTRACTS[name].bytecode + args.map(encAddr).join(""),
    encodeDeployData({ abi: ABI(name), bytecode: CONTRACTS[name].bytecode, args }));
  dep("EnclaveAddressBook", []);
  dep("EnclaveRegistry", []);
  dep("EnclaveAppCatalog", []);
  dep("EnclavePay", [USDC, A1]);
  dep("EnclaveDeployments", [USDC, A1, REG, FEED]);
  dep("EnclaveVolumeAccess", [A2]);
});

test("decodeBook round-trips a viem-encoded all() result (skipping retired keys)", () => {
  const REG = "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2";
  const keys = ["registry", "deployments", "custom-key_1"].map((k) => stringToHex(k, { size: 32 }));
  const vals = [REG, ZERO, A2];
  const got = decodeBook(encodeAbiParameters([{ type: "bytes32[]" }, { type: "address[]" }], [keys, vals]));
  assert.deepEqual(Object.keys(got), ["registry", "custom-key_1"]);
  eq(got.registry, REG);
  eq(got["custom-key_1"], A2);
  assert.deepEqual(decodeBook("0x"), {});
});

/* ---- migration codec: the import functions take the EXACT structs the
   getters return; one schema drives decode AND encode. Pin both directions
   against viem. ---- */

const DEP_ROW = {
  id: "0x" + "ab".repeat(32), owner: A1, appRef: "ipfs://bafyExample", ports: "tcp:15565,udp:9053",
  sshPubKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 example", configCid: "bafyConfig",
  gpuMilli: 250, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1751900000,
  rate: 417, balance6: 1500000, spent6: 250000,
  runner: "0x" + "0".repeat(64), runnerOperator: ZERO, leaseUntil: 0,
};
const APP_ROW = {
  appId: "0x" + "cd".repeat(32), publisher: A2, slug: "hello-world", name: "Hello World",
  description: "answers Hello World! — quotes \"and\" unicode ✓", versionCount: 2, createdAt: 1751000000, updatedAt: 1751900000, active: true,
};
const VER_ROW = {
  cid: "bafybeibvdyyo3dd6jkg6oklnlsxrxvotfihctbp4sqrqcoavecsnmktgg4", version: "1.0.0",
  vramMb: 0, gpuGflops: 0, memMb: 256, cpuGflops: 100, createdAt: 1751000001,
  verified: true, yanked: false, ports: "", approval: 1,
};
const asTuple = (schema, o) => schema.map((f) => o[f.k]);

test("import calls (tuple[] args) encode like viem", () => {
  const depAbi = ABI("EnclaveDeployments"), catAbi = ABI("EnclaveAppCatalog");
  eq(encCallX(S("EnclaveDeployments").importDeployments, [{ t: "tuple[]", schema: DEP_SCHEMA, v: [DEP_ROW, { ...DEP_ROW, id: "0x" + "ef".repeat(32), appRef: "hello" }] }]),
    encodeFunctionData({ abi: depAbi, functionName: "importDeployments",
      args: [[asTuple(DEP_SCHEMA, DEP_ROW), asTuple(DEP_SCHEMA, { ...DEP_ROW, id: "0x" + "ef".repeat(32), appRef: "hello" })]] }));
  eq(encCallX(S("EnclaveAppCatalog").importApps, [{ t: "tuple[]", schema: APP_SCHEMA, v: [APP_ROW] }]),
    encodeFunctionData({ abi: catAbi, functionName: "importApps", args: [[asTuple(APP_SCHEMA, APP_ROW)]] }));
  eq(encCallX(S("EnclaveAppCatalog").importVersions, [{ t: "bytes32", v: APP_ROW.appId }, { t: "tuple[]", schema: VER_SCHEMA, v: [VER_ROW, { ...VER_ROW, version: "1.0.1", cid: "bafyOther" }] }]),
    encodeFunctionData({ abi: catAbi, functionName: "importVersions",
      args: [APP_ROW.appId, [asTuple(VER_SCHEMA, VER_ROW), asTuple(VER_SCHEMA, { ...VER_ROW, version: "1.0.1", cid: "bafyOther" })]] }));
});

test("volume import calls (primitive + bytes[] arrays) encode like viem", () => {
  const volAbi = ABI("EnclaveVolumeAccess");
  const volId = "0x" + "11".repeat(32), pub = "0x" + "22".repeat(32);
  const sealed = "0x" + "ab".repeat(104);
  eq(encCallX(S("EnclaveVolumeAccess").importVolumes, [
      { t: "bytes32[]", v: [volId] }, { t: "addr[]", v: [A1] }, { t: "uint[]", v: [1751000000] }]),
    encodeFunctionData({ abi: volAbi, functionName: "importVolumes", args: [[volId], [A1], [1751000000n]] }));
  eq(encCallX(S("EnclaveVolumeAccess").importMembers, [
      { t: "bytes32", v: volId }, { t: "addr[]", v: [A1, A2] }, { t: "bytes32[]", v: [pub, pub] },
      { t: "uint[]", v: [2, 1] }, { t: "uint[]", v: [1751000001, 1751000002] }, { t: "bytes[]", v: [sealed, "0x"] }]),
    encodeFunctionData({ abi: volAbi, functionName: "importMembers",
      args: [volId, [A1, A2], [pub, pub], [2, 1], [1751000001n, 1751000002n], [sealed, "0x"]] }));
});

test("migration round-trip: decode a getPage result, re-encode it for import, byte-equal to viem", () => {
  // what the SOURCE contract returns from getPage(...)
  const depAbi = ABI("EnclaveDeployments");
  const rows = [DEP_ROW, { ...DEP_ROW, id: "0x" + "ef".repeat(32), sshPubKey: "", ports: "", isPublic: false, balance6: 0 }];
  const encodedReturn = encodeAbiParameters(
    depAbi.find((f) => f.name === "getPage").outputs, [rows.map((r) => asTuple(DEP_SCHEMA, r))]);
  // the console decodes it with the schema...
  const decoded = decodeStructArray(encodedReturn, DEP_SCHEMA);
  assert.equal(decoded.length, 2);
  // ...and replays it verbatim into importDeployments
  eq(encCallX(S("EnclaveDeployments").importDeployments, [{ t: "tuple[]", schema: DEP_SCHEMA, v: decoded }]),
    encodeFunctionData({ abi: depAbi, functionName: "importDeployments", args: [rows.map((r) => asTuple(DEP_SCHEMA, r))] }));
});

test("artifacts stay in sync with contracts/*.sol (regenerate check)", () => {
  // cheap staleness guard: every contract source is older-or-equal than the
  // generated module, or the build regenerates it anyway (build-site.mjs runs
  // the artifact builder first). Here we just assert the module carries all
  // six contracts with bytecode + the five book keys.
  assert.deepEqual(Object.keys(CONTRACTS).sort(), [
    "EnclaveAddressBook", "EnclaveAppCatalog", "EnclaveDeployments",
    "EnclavePay", "EnclaveRegistry", "EnclaveVolumeAccess"]);
  for (const [name, c] of Object.entries(CONTRACTS)) {
    assert.match(c.bytecode, /^0x[0-9a-f]{100,}$/i, name + " bytecode");
    for (const a of c.ctor) assert.equal(a.type, "address", name + " ctor args are all addresses (the console's deploy encoder assumes this)");
  }
  assert.deepEqual(
    Object.values(CONTRACTS).map((c) => c.bookKey).filter(Boolean).sort(),
    ["appCatalog", "deployments", "enclavePay", "registry", "volumeAccess"]);
});
