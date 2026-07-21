// Pure-function coverage for the vault bridge: COSE -> P-256 coordinates
// (registration-time extraction), DER -> raw r/s (assertion signatures).
// The digest encoding itself is pinned by the Foundry suite AND the e2e,
// which drive the real contract with relay-computed digests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import { coseToXY } from "../relay/auth.js";
import { derToRS, buildControlCall, floatSweepAmount } from "../relay/vaultsvc.js";

function coseP256(x, y) {
  // map(5) { 1:2, 3:-7, -1:1, -2:bstr32(x), -3:bstr32(y) } - canonical CBOR
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
}

test("coseToXY extracts P-256 coordinates from a canonical COSE key", () => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
  const out = coseToXY(coseP256(x, y));
  assert.equal(out.x, "0x" + x.toString("hex"));
  assert.equal(out.y, "0x" + y.toString("hex"));
});

test("coseToXY refuses an Ed25519 COSE key (no vault coordinates)", () => {
  // the shape the CDP virtual authenticator produced before ES256 was pinned:
  // map(4) { 1:1(OKP), 3:-8(EdDSA), -1:6(Ed25519), -2:bstr32 }
  const ed = Buffer.concat([
    Buffer.from([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20]),
    Buffer.alloc(32, 7),
  ]);
  assert.throws(() => coseToXY(ed), /P-256/);
});

test("buildControlCall encodes the vault's two allowlisted ledger calls, pinned vs viem", async () => {
  const { toFunctionSelector, decodeFunctionData } = await import("viem");
  const id = "0x" + "ab".repeat(32);
  const suspend = await buildControlCall(id, "suspend");
  const resume = await buildControlCall(id, "resume");
  const version = await buildControlCall(id, "version", "catalog://3/1");
  // the SELECTORS are what EnclaveCreditVault.controlDeployment allowlists
  assert.equal(suspend.slice(0, 10), toFunctionSelector("setActive(bytes32,bool)"));
  assert.equal(resume.slice(0, 10), toFunctionSelector("setActive(bytes32,bool)"));
  assert.equal(version.slice(0, 10), toFunctionSelector("setAppRef(bytes32,string)"));
  const activeAbi = [{ type: "function", name: "setActive", inputs: [{ type: "bytes32" }, { type: "bool" }], outputs: [] }];
  assert.deepEqual(decodeFunctionData({ abi: activeAbi, data: suspend }).args, [id, false]);
  assert.deepEqual(decodeFunctionData({ abi: activeAbi, data: resume }).args, [id, true]);
  const refAbi = [{ type: "function", name: "setAppRef", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [] }];
  assert.deepEqual(decodeFunctionData({ abi: refAbi, data: version }).args, [id, "catalog://3/1"]);
  await assert.rejects(buildControlCall(id, "terminate"), /unknown control action/);
});

test("floatSweepAmount: hysteresis band, sweep-to-target above the ceiling", () => {
  const T = 200_000000n, C = 400_000000n;          // $200 target, $400 ceiling
  assert.equal(floatSweepAmount(0n, T, C), 0n);                       // empty float: nothing to sweep
  assert.equal(floatSweepAmount(T, T, C), 0n);                        // at target
  assert.equal(floatSweepAmount(C, T, C), 0n);                        // at the ceiling: still inside the band
  assert.equal(floatSweepAmount(C + 1n, T, C), C + 1n - T);           // one over: sweep down to TARGET, not ceiling
  assert.equal(floatSweepAmount(1_000_000000n, T, C), 800_000000n);   // $1000 -> $200 stays
  assert.equal(floatSweepAmount("1000000000", T, C), 800_000000n);    // string balances (JSON) coerce
});

test("derToRS round-trips real ECDSA signatures incl. leading-zero trims", () => {
  for (let i = 0; i < 20; i++) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const msg = createHash("sha256").update("m" + i).digest();
    const der = createSign("sha256").update("m" + i).sign(privateKey);
    const { r, s } = derToRS(der);
    assert.ok(r > 0n && r < 2n ** 256n && s > 0n && s < 2n ** 256n);
    // parity: node's own verifier accepts what we parsed (re-encode minimal DER)
    const enc = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h;
      let b = Buffer.from(h, "hex"); if (b[0] & 0x80) b = Buffer.concat([Buffer.alloc(1), b]);
      return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
    const rebuilt = (() => { const ri = enc(r), si = enc(s);
      return Buffer.concat([Buffer.from([0x30, ri.length + si.length]), ri, si]); })();
    assert.deepEqual([...rebuilt], [...der], "canonical DER round-trip " + i);
    void msg;
  }
});
