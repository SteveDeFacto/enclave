// In-enclave ACME (supervisor.js) — the pure half: CSR/DER, RFC 7638
// thumbprints, JWS/EAB signing, dns-01 TXT derivation. The supervisor is a
// monolith with boot side effects, so instead of importing it we drive its
// env-gated self-test seam (ACME_SELFTEST=csr|vectors prints one JSON line and
// exits BEFORE any socket/state work) as a child process, then validate the
// outputs against INDEPENDENT implementations: openssl for the hand-built
// PKCS#10, jose (a second RFC 7638 implementation) for thumbprints, and raw
// node:crypto recomputation for the EAB HMAC and TXT value.
//
// The full ACME network flow (account/order/finalize against ZeroSSL) is
// deliberately untested here: it needs real EAB credentials and public DNS,
// and every network entry point in the supervisor is gated on those envs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint } from "jose";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

// Spawn the supervisor in self-test mode; the seam exits before boot, so this
// is fast and side-effect free. Warnings go to stderr; the payload is the last
// stdout line. The ACME/registry/book envs are cleared so nothing else stirs.
async function selftest(mode, extraEnv = {}) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", ACME_SELFTEST: mode,
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "",
           ...extraEnv } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
let _vectors = null;
const vectors = async () => (_vectors ??= await selftest("vectors"));

// RFC 7515 Appendix A.3's P-256 key — the fixed vector the selftest hashes.
const VEC_JWK = { kty: "EC", crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };

// ---------- CSR builder (the hand-rolled DER) --------------------------------

test("CSR: openssl verifies the self-signature and reads the SAN", async (t) => {
  const out = await selftest("csr", { ACME_SELFTEST_NAME: "test.app.enclave.host" });
  assert.match(out.csrPem, /^-----BEGIN CERTIFICATE REQUEST-----\n/);
  assert.match(out.keyPem, /^-----BEGIN PRIVATE KEY-----\n/);   // pkcs8, ready for tls.createSecureContext
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-acme-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const csrPath = path.join(dir, "csr.pem");
  fs.writeFileSync(csrPath, out.csrPem);
  // openssl 3 prints "Certificate request self-signature verify OK" on stderr
  const { stdout, stderr } = await pexec("openssl", ["req", "-in", csrPath, "-verify", "-noout", "-text"]);
  const text = stdout + stderr;
  assert.match(text, /verify OK/i, "openssl must accept the CSR signature");
  assert.match(text, /Subject Alternative Name/, "extensionRequest must carry a SAN");
  assert.match(text, /DNS:test\.app\.enclave\.host/, "the SAN must name the requested host");
  assert.match(text, /ecdsa-with-SHA256/, "signature algorithm");
  assert.match(text, /CN\s*=\s*test\.app\.enclave\.host/, "cosmetic CN");
});

test("CSR: the SAN follows the requested name", async () => {
  const out = await selftest("csr", { ACME_SELFTEST_NAME: "abcd1234.app.enclave.host" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-acme-"));
  try {
    const csrPath = path.join(dir, "csr.pem");
    fs.writeFileSync(csrPath, out.csrPem);
    const { stdout, stderr } = await pexec("openssl", ["req", "-in", csrPath, "-verify", "-noout", "-text"]);
    assert.match(stdout + stderr, /DNS:abcd1234\.app\.enclave\.host/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- RFC 7638 thumbprint ----------------------------------------------

test("thumbprint: matches jose's independent RFC 7638 implementation", async () => {
  const v = await vectors();
  assert.equal(v.thumbprint, await calculateJwkThumbprint(VEC_JWK, "sha256"));
});

test("thumbprint: canonical - member order and extra members don't matter", async () => {
  const v = await vectors();
  assert.equal(v.thumbprintScrambled, v.thumbprint);
  assert.equal(v.ownThumbprintStable, true);
});

// ---------- base64url + JWS ---------------------------------------------------

test("base64url: lossless roundtrip, no padding or +/ characters", async () => {
  const v = await vectors();
  assert.equal(v.b64uRoundtrip, true);
  assert.equal(v.b64uNoPad, true);
});

test("JWS ES256: node verifies the ieee-p1363 signature over protected.payload", async () => {
  const v = await vectors();
  assert.equal(v.jwsVerifies, true);
});

// ---------- dns-01 TXT value ---------------------------------------------------

test("dns-01: TXT value is b64u(sha256(token '.' thumbprint)), recomputed here", async () => {
  const v = await vectors();
  const keyAuth = `token.${await calculateJwkThumbprint(VEC_JWK, "sha256")}`;
  assert.equal(v.dns01, createHash("sha256").update(keyAuth).digest("base64url"));
});

// ---------- CA slot parsing (multi-CA failover config) -------------------------
// ACME_SELFTEST=cas prints the parsed ACME_CAS list (secrets reduced to a
// presence bit) plus the ACME_ENABLED verdict — the config half of the CA
// failover added after the 2026-07-18 ZeroSSL/Sectigo blackout.

const ZEROSSL = "https://acme.zerossl.com/v2/DV90";
const GTS     = "https://dv.acme-v02.api.pki.goog/directory";
// every ACME env cleared, then the case's overrides
const casOf = (extraEnv) => selftest("cas", {
  ACME_DIRECTORY: "", ACME_DIRECTORY_2: "", ACME_DIRECTORY_3: "",
  ACME_EAB_KID_2: "", ACME_EAB_HMAC_2: "", ACME_EAB_KID_3: "", ACME_EAB_HMAC_3: "",
  ...extraEnv });

test("cas: primary alone - EAB pair rides the default ZeroSSL directory", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h" });
  assert.deepEqual(v.cas, [{ directory: ZEROSSL, host: "acme.zerossl.com", eab: true }]);
});

test("cas: fallback slot rides behind the primary, in order", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                          ACME_DIRECTORY_2: GTS, ACME_EAB_KID_2: "k2", ACME_EAB_HMAC_2: "h2" });
  assert.deepEqual(v.cas.map((c) => c.host), ["acme.zerossl.com", "dv.acme-v02.api.pki.goog"]);
  assert.deepEqual(v.cas.map((c) => c.eab), [true, true]);
});

test("cas: an EAB-less fallback (Let's Encrypt style) is a valid slot", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                          ACME_DIRECTORY_2: "https://acme-v02.api.letsencrypt.org/directory" });
  assert.deepEqual(v.cas.map((c) => c.eab), [true, false]);
});

test("cas: half an EAB pair skips the slot, not the feature", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                          ACME_DIRECTORY_2: GTS, ACME_EAB_KID_2: "k2" });   // HMAC_2 missing
  assert.deepEqual(v.cas.map((c) => c.host), ["acme.zerossl.com"]);
});

test("cas: a fallback stands alone when the primary has no EAB pair", async () => {
  const v = await casOf({ ACME_DIRECTORY_2: GTS, ACME_EAB_KID_2: "k2", ACME_EAB_HMAC_2: "h2" });
  assert.deepEqual(v.cas.map((c) => c.host), ["dv.acme-v02.api.pki.goog"]);
});

test("cas: the bare default directory is not an opt-in; enabled needs a slot + domain + dns api", async () => {
  assert.deepEqual((await casOf({})).cas, []);
  assert.equal((await casOf({})).enabled, false);
  const partial = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h" });   // no APP_CERT_DOMAIN/DNS_API
  assert.equal(partial.enabled, false);
  const full = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                             APP_CERT_DOMAIN: "app.enclave.host", DNS_API: "http://10.0.0.1:8153" });
  assert.equal(full.enabled, true);
});

// ---------- EAB inner JWS ------------------------------------------------------

test("EAB: HS256 inner JWS - header shape, JWK payload, recomputed signature", async () => {
  const v = await vectors();
  // protected header: HS256 + the CA-issued kid + the newAccount URL
  assert.deepEqual(JSON.parse(Buffer.from(v.eab.protected, "base64url")),
                   { alg: "HS256", kid: "kid1", url: "https://ca/newAccount" });
  // payload: the ACME account's public JWK, verbatim
  assert.deepEqual(JSON.parse(Buffer.from(v.eab.payload, "base64url")), VEC_JWK);
  // signature: HMAC-SHA256 over protected.payload with the b64url-DECODED key
  // (the selftest feeds b64u("secret") as the credential, so the raw key is "secret")
  const expect = createHmac("sha256", Buffer.from("secret"))
    .update(`${v.eab.protected}.${v.eab.payload}`).digest("base64url");
  assert.equal(v.eab.signature, expect);
});
