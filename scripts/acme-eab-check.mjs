#!/usr/bin/env node
// Burn-test an ACME External Account Binding credential from a workstation,
// using the SAME JOSE construction as supervisor.js (helpers mirrored from
// there - keep them in sync):
//
//   node scripts/acme-eab-check.mjs --directory <acme-url> --kid <keyId> --hmac <b64MacKey>
//
// Optional: --contact <email>, --no-contact (some CAs reject contactless
// registrations - the flag lets you prove whether a FAILED registration
// consumes the pair).
//
// WARNING: SUCCESS REGISTERS AN ACCOUNT, and on CAs with single-use EAB that
// CONSUMES the pair. Never test the pair you mean to give the enclave - mint
// a throwaway. The registered account is inert: no certs are ordered, and
// abandoning it costs nothing.
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? (process.argv[i + 1] || "") : ""; };
const DIRECTORY = (arg("directory") || "https://acme.zerossl.com/v2/DV90").replace(/\/+$/, "");

// ---- mirrored from supervisor.js (pure half) --------------------------------
const b64u     = (b) => Buffer.from(b).toString("base64url");
const b64uJson = (o) => b64u(JSON.stringify(o));
function jwsSignEs256(protectedHeader, payload, privateKey) {
  const prot = b64uJson(protectedHeader);
  const body = payload === null ? "" : b64uJson(payload);
  const sig  = cryptoSign("sha256", Buffer.from(`${prot}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { protected: prot, payload: body, signature: b64u(sig) };
}
function eabJws(kid, hmacB64u, accountJwk, newAccountUrl) {
  const prot    = b64uJson({ alg: "HS256", kid, url: newAccountUrl });
  const payload = b64uJson(accountJwk);
  const sig     = createHmac("sha256", Buffer.from(hmacB64u, "base64url")).update(`${prot}.${payload}`).digest();
  return { protected: prot, payload, signature: b64u(sig) };
}
// -----------------------------------------------------------------------------

async function main() {
  const kid = arg("kid").trim(), hmac = arg("hmac").trim();
  if (!kid || !hmac) { console.error("usage: --directory <acme-url> --kid <keyId> --hmac <b64MacKey> [--contact <email> | --no-contact]"); process.exit(2); }
  const dirR = await fetch(DIRECTORY);
  const dir  = await dirR.json().catch(() => null);
  if (!dirR.ok || !dir?.newAccount) {
    console.error(`directory ${DIRECTORY}: HTTP ${dirR.status}, ${dir ? "unusable JSON" : "not JSON (outage page?)"}`);
    process.exit(1);
  }
  console.log(`directory ok: ${DIRECTORY} (externalAccountRequired=${!!dir.meta?.externalAccountRequired})`);

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" });
  const jwk = { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
  const nonce = (await fetch(dir.newNonce, { method: "HEAD" })).headers.get("replay-nonce");
  if (!nonce) { console.error("newNonce returned no replay-nonce"); process.exit(1); }
  // GTS rejects contactless accounts; --contact overrides, no CA verifies it.
  // --no-contact deliberately triggers that rejection - it lets you prove a
  // FAILED registration does (or doesn't) consume the pair.
  const contactRaw = arg("contact") || "hostmaster@enclave.host";
  const contact    = contactRaw.includes(":") ? contactRaw : `mailto:${contactRaw}`;
  const noContact  = process.argv.includes("--no-contact");
  const r = await fetch(dir.newAccount, { method: "POST", headers: { "content-type": "application/jose+json" },
    body: JSON.stringify(jwsSignEs256({ alg: "ES256", nonce, url: dir.newAccount, jwk },
      { termsOfServiceAgreed: true, ...(noContact ? {} : { contact: [contact] }),
        externalAccountBinding: eabJws(kid, hmac, jwk, dir.newAccount) }, privateKey)) });
  const body = await r.json().catch(() => ({}));
  if (r.status === 201) {
    console.log(`REGISTERED: ${r.headers.get("location")}`);
    console.log("on CAs with single-use EAB this pair is now CONSUMED - do not hand it to the enclave");
  } else {
    console.error(`FAILED HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
