// Interop test for the checked-in bundle (src/vault.js).
//
// Loads the IIFE in a vm sandbox WITHOUT Buffer/process/node globals - the
// same deprivation a browser imposes - then proves the bundled protocol is
// byte-compatible with scripts/nan-vault.mjs (the source of truth) and that
// volId matches the canonical vectors pinned across the contract, the
// supervisor and the CLI.
//
// Run: node wasm/apps/vault/js/test-bundle.mjs
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { deriveKeypair, seal, unseal, newVEK, DERIVE_MESSAGE } from "../../../../scripts/nan-vault.mjs";

const bundle = readFileSync(fileURLToPath(new URL("../src/vault.js", import.meta.url)), "utf8");

// Browser-shaped sandbox: web crypto, encoders, NO Buffer/process/require.
const sandbox = {
  crypto: webcrypto,
  TextEncoder, TextDecoder,
  console,
  fetch: () => { throw new Error("no network in the test sandbox"); },
  navigator: { userAgent: "test" },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window = undefined;   // headless: the bundle must skip DOM init
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: "vault.js" });

const NV = sandbox.NanVault;
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

check("bundle exposes NanVault", !!NV);
check("DERIVE_MESSAGE matches the protocol", NV.DERIVE_MESSAGE === DERIVE_MESSAGE);

// canonical volId vectors (contract == supervisor == CLI == this bundle)
const DEPLOYER = "0x390Ea37f5b4e3b6D2F0ae8b3ff0E2c9D1A2b3c4d";
check("volId vector glm-weights",
  NV.volIdOf(DEPLOYER, "glm-weights") === "0x680eecbb1524003f4769dbb486d6710f30899b33a2318c244c9c87a4ebae84cc");
check("volId vector user-data",
  NV.volIdOf(DEPLOYER, "user-data") === "0x35fa79e88efdd00fbb152cba1d3cc6bc1dc9c25f8cf72715dae56202f093286d");

// key derivation: bundle and source produce the same keypair from one sig
const sig = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 3) & 0xff);
const kpSrc = deriveKeypair(sig);
const kpBun = NV.deriveKeypair(sig);
check("deriveKeypair matches source", NV.hex(kpBun.publicKey) === "0x" + Buffer.from(kpSrc.publicKey).toString("hex"));

// sealed-box interop, both directions
const vek = newVEK();
const bundleOpensSource = NV.unseal(seal(vek, kpSrc.publicKey), kpBun.secretKey);
const sourceOpensBundle = unseal(NV.seal(vek, kpBun.publicKey), kpSrc.secretKey);
check("bundle unseals a source-sealed VEK", Buffer.from(bundleOpensSource).equals(Buffer.from(vek)));
check("source unseals a bundle-sealed VEK", Buffer.from(sourceOpensBundle).equals(Buffer.from(vek)));

// wrong recipient must fail (crypto-enforced ACL)
let rejected = false;
try { NV.unseal(seal(vek, kpSrc.publicKey), deriveKeypair(sig.map((b) => b ^ 1)).secretKey); }
catch { rejected = true; }
check("wrong key cannot unseal", rejected);

// hex helpers round-trip without Buffer
check("hex/unhex round-trip", NV.hex(NV.unhex("0xdeadbeef")) === "0xdeadbeef");

process.exit(failures ? 1 : 0);
