// EnclaveReviews site surface — the Apps page hand-encodes post/setHidden and
// decodes Review[] pages, one Review, and the store grid's talliesOf pair with
// the minimal codec in js/core/chain.js. Reviews add two shapes the codec had
// never carried: a bytes32[] ARGUMENT (talliesOf, the grid's one-call read) and
// a single returned STRUCT (getReview). These tests pin both against viem, plus
// the hand-copied REV_SEL map against the compiled ABI.
//
//   run: node --test test/reviews.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, encodeAbiParameters, toFunctionSelector } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { encCall, decodeStruct, decodeStructArray, decodeTallies, REV_SEL, REVIEW_SCHEMA, REVIEW_MAX_BODY, DEP_SCHEMA } =
  await import(path.join(REPO, "site/js/core/chain.js"));
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "EnclaveReviews.abi.json"), "utf8"));
const SOL = fs.readFileSync(path.join(REPO, "contracts", "EnclaveReviews.sol"), "utf8");

const APP_ID = "0x" + "ab".repeat(32);
const APP_2 = "0x" + "cd".repeat(32);
const DEP_ID = "0x" + "77".repeat(32);
const WHO = "0x1111111111111111111111111111111111111111";
const eq = (got, want) => assert.equal(got.toLowerCase(), want.toLowerCase());

test("REV_SEL selectors match the compiled ABI (viem-derived)", () => {
  const byName = Object.fromEntries(ABI.filter((f) => f.type === "function").map((f) => [f.name, toFunctionSelector(f).slice(2)]));
  const expect = {
    post: "post", setHidden: "setHidden", canReview: "canReview",
    reviewCount: "reviewCount", getReviewsPage: "getReviewsPage", getReview: "getReview",
    tallyOf: "tallyOf", talliesOf: "talliesOf", reviewsSchema: "reviewsSchema",
    owner: "owner", deployments: "deployments", setDeployments: "setDeployments", MAX_BODY: "MAX_BODY",
  };
  for (const [key, fn] of Object.entries(expect))
    assert.equal(REV_SEL[key], byName[fn], `REV_SEL.${key} vs ABI ${fn}`);
});

test("review calls encode like viem", () => {
  const viem = (functionName, args) => encodeFunctionData({ abi: ABI, functionName, args });
  eq(encCall(REV_SEL.post, [{ t: "bytes32", v: APP_ID }, { t: "bytes32", v: DEP_ID }, { t: "uint", v: 5 }, { t: "str", v: "ran it for a month, no drama" }]),
     viem("post", [APP_ID, DEP_ID, 5, "ran it for a month, no drama"]));
  eq(encCall(REV_SEL.post, [{ t: "bytes32", v: APP_ID }, { t: "bytes32", v: DEP_ID }, { t: "uint", v: 1 }, { t: "str", v: "" }]),
     viem("post", [APP_ID, DEP_ID, 1, ""]), "a bare rating (empty comment)");
  eq(encCall(REV_SEL.setHidden, [{ t: "bytes32", v: APP_ID }, { t: "addr", v: WHO }, { t: "bool", v: true }]),
     viem("setHidden", [APP_ID, WHO, true]));
  eq(encCall(REV_SEL.canReview, [{ t: "bytes32", v: APP_ID }, { t: "bytes32", v: DEP_ID }, { t: "addr", v: WHO }]),
     viem("canReview", [APP_ID, DEP_ID, WHO]));
  eq(encCall(REV_SEL.getReviewsPage, [{ t: "bytes32", v: APP_ID }, { t: "uint", v: 0 }, { t: "uint", v: 50 }]),
     viem("getReviewsPage", [APP_ID, 0n, 50n]));
  eq(encCall(REV_SEL.getReview, [{ t: "bytes32", v: APP_ID }, { t: "addr", v: WHO }]), viem("getReview", [APP_ID, WHO]));
});

test("a multi-byte comment encodes like viem (the star of a UTF-8 padding bug)", () => {
  const body = "运行良好 · 5★ — no complaints";
  eq(encCall(REV_SEL.post, [{ t: "bytes32", v: APP_ID }, { t: "bytes32", v: DEP_ID }, { t: "uint", v: 4 }, { t: "str", v: body }]),
     encodeFunctionData({ abi: ABI, functionName: "post", args: [APP_ID, DEP_ID, 4, body] }));
});

test("bytes32[] arguments (talliesOf - the grid's one-call read) encode like viem", () => {
  const viem = (args) => encodeFunctionData({ abi: ABI, functionName: "talliesOf", args: [args] });
  eq(encCall(REV_SEL.talliesOf, [{ t: "bytes32[]", v: [APP_ID, APP_2] }]), viem([APP_ID, APP_2]));
  eq(encCall(REV_SEL.talliesOf, [{ t: "bytes32[]", v: [] }]), viem([]), "an empty page");
  eq(encCall(REV_SEL.talliesOf, [{ t: "bytes32[]", v: Array.from({ length: 20 }, (_, i) => "0x" + String(i).padStart(64, "0")) }]),
     viem(Array.from({ length: 20 }, (_, i) => "0x" + String(i).padStart(64, "0"))), "a full store page");
});

const REVIEW_ABI = { type: "tuple[]", components: [
  { name: "reviewer", type: "address" }, { name: "stars", type: "uint8" }, { name: "hidden", type: "bool" },
  { name: "createdAt", type: "uint64" }, { name: "updatedAt", type: "uint64" },
  { name: "deployment", type: "bytes32" }, { name: "body", type: "string" },
]};
const ROWS = [
  { reviewer: WHO, stars: 5, hidden: false, createdAt: 1_770_000_000n, updatedAt: 1_770_000_000n, deployment: DEP_ID, body: "solid" },
  { reviewer: "0x2222222222222222222222222222222222222222", stars: 1, hidden: true, createdAt: 1n, updatedAt: 2n, deployment: DEP_ID, body: "" },
  { reviewer: "0x3333333333333333333333333333333333333333", stars: 3, hidden: false, createdAt: 9n, updatedAt: 9n, deployment: DEP_ID, body: "运行良好 — fine" },
];

test("Review[] (dynamic tuples) decodes against a viem encoding", () => {
  const got = decodeStructArray(encodeAbiParameters([REVIEW_ABI], [ROWS]), REVIEW_SCHEMA);
  assert.equal(got.length, 3);
  eq(got[0].reviewer, WHO);
  assert.equal(got[0].stars, 5);
  assert.equal(got[0].hidden, false);
  assert.equal(got[0].createdAt, 1_770_000_000);
  eq(got[0].deployment, DEP_ID);
  assert.equal(got[0].body, "solid");
  assert.equal(got[1].hidden, true, "a moderated review still decodes, flagged");
  assert.equal(got[1].body, "", "an empty comment is a real value, not a missing field");
  assert.equal(got[2].body, "运行良好 — fine", "multi-byte comments survive the utf-8 decode");
  assert.equal(decodeStructArray(encodeAbiParameters([REVIEW_ABI], [[]]), REVIEW_SCHEMA).length, 0, "no reviews yet");
});

test("one returned struct (getReview) decodes against a viem encoding", () => {
  const one = { type: "tuple", components: REVIEW_ABI.components };
  const got = decodeStruct(encodeAbiParameters([one], [ROWS[0]]), REVIEW_SCHEMA);
  eq(got.reviewer, WHO);
  assert.equal(got.stars, 5);
  assert.equal(got.body, "solid");
  // a wallet that never reviewed the app: the contract returns a zero record,
  // which must read as "none" and not as a 0-star review by 0x0
  const none = decodeStruct(encodeAbiParameters([one], [{ reviewer: "0x" + "0".repeat(40), stars: 0, hidden: false, createdAt: 0n, updatedAt: 0n, deployment: "0x" + "0".repeat(64), body: "" }]), REVIEW_SCHEMA);
  assert.equal(none.stars, 0);
  eq(none.reviewer, "0x" + "0".repeat(40));
});

test("decodeStruct still reads a Deployment (the depGet path it now shares)", () => {
  const dep = { type: "tuple", components: [
    { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" },
    { name: "ports", type: "string" }, { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" },
    { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
    { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
    { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
    { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
  ]};
  const row = { id: DEP_ID, owner: WHO, appRef: `catalog://${APP_ID.slice(2)}/0`, ports: "", configCid: "",
    gpuMilli: 250, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1_770_000_000n,
    rate: 42n, balance6: 5_000_000n, spent6: 1_000_000n, runner: DEP_ID, runnerOperator: WHO, leaseUntil: 1_770_003_600n };
  const got = decodeStruct(encodeAbiParameters([dep], [row]), DEP_SCHEMA);
  eq(got.id, DEP_ID);
  assert.equal(got.appRef, row.appRef);
  assert.equal(got.balance6, 5_000_000);
  assert.equal(got.leaseUntil, 1_770_003_600);
});

test("talliesOf's parallel uint32 arrays decode back onto the apps we asked about", () => {
  const hex = encodeAbiParameters([{ type: "uint32[]" }, { type: "uint32[]" }], [[3, 0], [13, 0]]);
  const got = decodeTallies(hex, [APP_ID, APP_2]);
  assert.deepEqual(got, [{ appId: APP_ID, count: 3, sum: 13 }, { appId: APP_2, count: 0, sum: 0 }]);
  // 13/3 = 4.33 - the average is the reader's division, so no rounding is
  // baked into the chain data
  assert.equal((got[0].sum / got[0].count).toFixed(2), "4.33");
  assert.deepEqual(decodeTallies(encodeAbiParameters([{ type: "uint32[]" }, { type: "uint32[]" }], [[], []]), []), []);
  assert.deepEqual(decodeTallies("0x", [APP_ID]), [], "an empty RPC reply is not a zero rating");
});

test("the site's body cap matches the contract's MAX_BODY", () => {
  const m = /uint256 public constant MAX_BODY = (\d+);/.exec(SOL);
  assert.ok(m, "MAX_BODY constant found in EnclaveReviews.sol");
  assert.equal(REVIEW_MAX_BODY, Number(m[1]), "chain.js REVIEW_MAX_BODY vs the contract");
});

test("the appRef parser's window matches how the site builds a catalog ref", () => {
  // the contract slices "catalog://0x<64 hex>/" by fixed offsets (12..76, then
  // '/'), so a change to catalogRef's format would silently orphan every new
  // review - pin the two against each other. catalog.js binds to `document` at
  // import, so this reads its one-line definition rather than loading it.
  const src = fs.readFileSync(path.join(REPO, "site/js/core/catalog.js"), "utf8");
  assert.match(src, /export const catalogRef = \(appId, index\) => "catalog:\/\/" \+ appId \+ "\/" \+ index;/,
    "catalogRef still builds catalog://<appId>/<index>");
  const catalogRef = (appId, index) => "catalog://" + appId + "/" + index;
  const ref = catalogRef(APP_ID, 7);
  assert.equal(ref.slice(0, 12), "catalog://0x");
  assert.equal(ref[76], "/");
  assert.equal(ref.slice(12, 76), APP_ID.slice(2));
  assert.ok(ref.length >= 78, "prefix + 64 hex + '/' + at least one index digit");
});
