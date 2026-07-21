// Relay account auth: self-hosted passkeys (WebAuthn, primary) + Sign-In with
// Ethereum (secondary), minting ES256 account-session JWTs.
//
// TRUST DOMAINS - this is deliberately a SECOND session system, not a
// replacement. Enclave sessions (supervisor.js, ES256 minted IN the CVM) keep
// gating deployment-private reads; the operator cannot mint those. THESE
// sessions gate billing/orders/checkout - operator-side functions by nature
// (the Stripe keys, treasury and review queue live with the operator
// regardless), so relay-side minting gives up nothing. The two can never be
// confused: account subs are "acct_<hex>" and the relay's own tokenAddress()
// only honors 0x-address subs, while enclaves pin their own kid/issuer.
//
// HARD INVARIANT (custody/legal): this file stores WebAuthn PUBLIC keys,
// credential ids, counters and transports - never a private key, share, or
// anything that could move funds. There is nothing here worth stealing.
//
// Endpoints (all /v1/account/*, mounted before the enclave gateway so they
// answer with zero live enclaves; /v1/auth/* stays enclave-proxied):
//   GET  /v1/account/jwks                        session-verification JWK set
//   POST /v1/account/passkey/register/options    {} (Bearer optional: add-credential)
//   POST /v1/account/passkey/register/verify     {challengeId, credential, label?}
//   POST /v1/account/passkey/login/options       {}
//   POST /v1/account/passkey/login/verify        {challengeId, credential}
//   GET  /v1/account/siwe/nonce?address=0x..     full SIWE message to sign
//   POST /v1/account/siwe/verify                 {message, signature}
//   POST /v1/account/link/siwe                   {message, signature} (Bearer)
//   GET  /v1/account/me                          profile (never key bytes)
//   DELETE /v1/account/passkey/:credId           (Bearer; 409 on last method)
//
// Config (env): AUTH_DATA_DIR (or systemd $STATE_DIRECTORY; unset = disabled),
// SESSION_KEY_FILE, SESSION_TTL (7d), PASSKEY_RP_ID (enclave.host),
// PASSKEY_ORIGINS (default: the CORS allowlist), SIWE_DOMAIN, SIWE_URI,
// CHAIN_ID (8453).

import fs from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { JsonStore, dataDir, dataFile, makeRateLimiter, rid, rpcPool } from "./store.js";
import { vaultEnabled, vaultInfo } from "./vaultsvc.js";

const SESSION_TTL = parseInt(process.env.SESSION_TTL || "604800", 10);
const RP_ID = (process.env.PASSKEY_RP_ID || "enclave.host").trim();
const ORIGINS = (process.env.PASSKEY_ORIGINS || process.env.CORS_ORIGINS || "https://enclave.host,https://www.enclave.host")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SIWE_DOMAIN = process.env.SIWE_DOMAIN || "enclave.host";
const SIWE_URI = process.env.SIWE_URI || "https://enclave.host";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453", 10);

const CHALLENGE_TTL_MS = 5 * 60_000, NONCE_TTL_MS = 10 * 60_000, STORE_MAX = 10_000;
const DEVICE_TTL_MS = 3 * 60_000;

// 8 chars from an unambiguous alphabet (no 0/O/1/I/L): typable for the future
// CLI device flow, dense enough (31^8 ≈ 8e11) that online guessing dies at the rate limit
const DEVICE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function deviceCode() {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += DEVICE_ALPHABET[b[i] % DEVICE_ALPHABET.length];
  return s;
}

let enabled = false;
let accounts = null;          // JsonStore: { accounts, byCredential, byWallet }
let PRIV = null, PUB = null, JWK = null, KID = "";
let jose = null, webauthn = null;

// single-use stores, TTL + FIFO cap (supervisor.js nonces pattern)
const challenges = new Map(); // id -> { challenge, kind, accountId|null, userHandle|null, exp }
const siweNonces = new Map(); // nonce -> { address, exp }
const deviceReqs = new Map(); // code -> { secret, ua, ip, createdAt, exp, state, accountId }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  for (const [k, v] of siweNonces) if (v.exp < now) siweNonces.delete(k);
  for (const [k, v] of deviceReqs) if (v.exp < now) deviceReqs.delete(k);
}, 60_000).unref?.();
const bound = (map) => { while (map.size > STORE_MAX) { const k = map.keys().next().value; if (k === undefined) break; map.delete(k); } };

const rlMint = makeRateLimiter({ capacity: 20, refillPerSec: 0.5 });
const rlVerify = makeRateLimiter({ capacity: 10, refillPerSec: 0.2 });

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const jwkThumbprint = (j) =>
  b64u(createHash("sha256").update(`{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`).digest());

export async function initAccounts() {
  const dir = dataDir();
  if (!dir) { console.log("[account] no data dir (AUTH_DATA_DIR/StateDirectory) - accounts disabled"); return { enabled: false }; }
  try { jose = await import("jose"); webauthn = await import("@simplewebauthn/server"); }
  catch (e) { console.error(`[account] deps missing (${e.message}) - run npm install in relay/; accounts disabled`); return { enabled: false }; }

  const keyFile = process.env.SESSION_KEY_FILE || dataFile(dir, "session-key.pkcs8.pem");
  let priv = null;
  try { priv = createPrivateKey(fs.readFileSync(keyFile, "utf8")); } catch {}
  if (!priv) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    priv = privateKey;
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log("[account] minted ES256 account-session key");
  }
  PRIV = priv;
  PUB = createPublicKey(priv);
  const j = PUB.export({ format: "jwk" });
  KID = jwkThumbprint(j);
  JWK = { kty: j.kty, crv: j.crv, x: j.x, y: j.y, kid: KID, alg: "ES256", use: "sig" };

  accounts = new JsonStore(dataFile(dir, "accounts.json"), { accounts: {}, byCredential: {}, byWallet: {} }, { durable: true });
  enabled = true;
  console.log(`[account] enabled - rpID ${RP_ID}, origins ${ORIGINS.join(",")}, ${Object.keys(accounts.data.accounts).length} accounts`);
  return { enabled: true };
}

// --- sessions -------------------------------------------------------------------
async function mintAccountSession(accountId, amr) {
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);
  const token = await new jose.SignJWT({ amr })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(KID).setSubject(accountId).setIssuedAt()
    .setExpirationTime((expiresAt.getTime() / 1000) | 0)
    .sign(PRIV);
  return { token, tokenType: "Bearer", accountId, method: amr, expiresAt: expiresAt.toISOString() };
}

// Authorization header -> { accountId, amr } or null. ES256 pinned, issuer
// pinned to our kid (alg-confusion defense, supervisor.js verifySessionToken).
export async function verifyAccountSession(authHeader) {
  if (!enabled) return null;
  const m = /^Bearer\s+(.+)$/.exec(authHeader || ""); if (!m) return null;
  const token = m[1];
  let hdr;
  try { hdr = JSON.parse(Buffer.from(token.split(".")[0] || "", "base64url").toString("utf8")); } catch { return null; }
  if (!hdr || hdr.alg !== "ES256" || hdr.kid !== KID) return null;
  try {
    const { payload } = await jose.jwtVerify(token, PUB, { algorithms: ["ES256"], issuer: KID });
    const acct = accounts.data.accounts[payload.sub];
    if (!acct) return null;
    return { accountId: payload.sub, amr: payload.amr || "unknown" };
  } catch { return null; }
}

export const accountsEnabled = () => enabled;
export const getAccount = (id) => (enabled ? accounts.data.accounts[id] : null) || null;

// --- account records ------------------------------------------------------------
function newAccount(userHandle) {
  const id = rid("acct_");
  const rec = { id, createdAt: new Date().toISOString(), userHandle, wallets: [], passkeys: [] };
  accounts.data.accounts[id] = rec;
  accounts.saveSoon();
  return rec;
}
// stored per passkey: PUBLIC key + credId + counter + transports. Nothing else.
function addPasskey(acct, info, transports, label) {
  const cred = info.credential;
  let xy = null;
  try { xy = coseToXY(Buffer.from(cred.publicKey)); } catch { /* non-P256 (e.g. Ed25519 key): no vault for this credential */ }
  acct.passkeys.push({
    credId: cred.id,
    publicKey: Buffer.from(cred.publicKey).toString("base64url"),
    ...(xy ? { pubX: xy.x, pubY: xy.y } : {}),   // P-256 coordinates: what the on-chain credit vault verifies against
    counter: cred.counter || 0,
    transports: transports || cred.transports || [],
    aaguid: info.aaguid || "",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    label: String(label || "").slice(0, 64),
  });
  accounts.data.byCredential[cred.id] = acct.id;
  accounts.saveSoon();
}

// COSE_Key (EC2 / P-256 / ES256) -> {x, y} 0x-hex. A deliberately minimal CBOR
// reader for the ONE shape @simplewebauthn stores: map { 1:2, 3:-7, -1:1,
// -2:bstr32, -3:bstr32 }. Anything else throws and the passkey simply carries
// no vault coordinates.
export function coseToXY(u8) {
  let i = 0;
  const head = () => { const b = u8[i++]; return [b >> 5, b & 0x1f]; };
  const uintVal = (info) => {
    if (info < 24) return info;
    if (info === 24) return u8[i++];
    if (info === 25) { const v = (u8[i] << 8) | u8[i + 1]; i += 2; return v; }
    throw new Error("cbor: length form");
  };
  const readItem = () => {
    const [maj, info] = head();
    if (maj === 0) return uintVal(info);                                        // uint
    if (maj === 1) return -1 - uintVal(info);                                   // negint
    if (maj === 2) { const n = uintVal(info); const v = u8.subarray(i, i + n); i += n; return v; }  // bytes
    if (maj === 3) { const n = uintVal(info); i += n; return null; }            // text: skip
    throw new Error("cbor: unsupported major " + maj);
  };
  const [maj, info] = head();
  if (maj !== 5) throw new Error("not a COSE map");
  const n = uintVal(info);
  const out = {};
  for (let k = 0; k < n; k++) { const key = readItem(); out[key] = readItem(); }
  const x = out[-2], y = out[-3];
  if (!(out[1] === 2 && out[3] === -7 && x && x.length === 32 && y && y.length === 32))
    throw new Error("not a P-256 COSE key");
  return { x: "0x" + Buffer.from(x).toString("hex"), y: "0x" + Buffer.from(y).toString("hex") };
}

// the account's vault key: the FIRST P-256 passkey. The vault's CREATE2 salt
// binds to it; vault ops must be signed by it (the site pins allowCredentials).
export function vaultKeyOf(accountId) {
  const acct = enabled ? accounts.data.accounts[accountId] : null;
  if (!acct) return null;
  const k = acct.passkeys.find((c) => c.pubX && c.pubY);
  return k ? { credId: k.credId, x: k.pubX, y: k.pubY } : null;
}

// --- http helpers ---------------------------------------------------------------
async function bodyJson(req, ctx, max = 65536) {
  const raw = await ctx.readBody(req, max);
  try { return JSON.parse(raw.toString() || "{}"); } catch { return null; }
}
const err = (ctx, res, req, code, error, message) => ctx.json(res, code, { error, message }, req);

// --- SIWE (viem/siwe; the message mirrors the supervisor's shape so the
//     site's buildSiwe fallback resolves to the same values) ---------------------
function siweNonceAnswer(address) {
  const nonce = rid("");
  const issuedAt = new Date(), expirationTime = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  siweNonces.set(nonce, { address, exp: expirationTime.getTime() });
  bound(siweNonces);
  const statement = "Sign in to Enclave. This signature is free and will not move funds.";
  const message =
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\n` +
    `URI: ${SIWE_URI}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\n` +
    `Issued At: ${issuedAt.toISOString()}\nExpiration Time: ${expirationTime.toISOString()}`;
  return { address, message, nonce, statement, domain: SIWE_DOMAIN, uri: SIWE_URI, version: "1",
           chainId: CHAIN_ID, issuedAt: issuedAt.toISOString(), expirationTime: expirationTime.toISOString() };
}

// verify {message, signature} -> checksummed address, or a thrown {code, msg}.
// parse + field pinning first (cheap, no RPC), then verifySiweMessage on the
// pool client - EIP-1271 capable, so smart-contract wallets can sign in.
async function siweVerify(message, signature) {
  const { getAddress } = await import("viem");
  const { parseSiweMessage } = await import("viem/siwe");
  const oops = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };
  if (typeof message !== "string" || typeof signature !== "string") oops("invalid_request", "message and signature are required.");
  let parsed;
  try { parsed = parseSiweMessage(message); } catch { oops("invalid_message", "Malformed SIWE message."); }
  if (!parsed?.address || !parsed.nonce) oops("invalid_message", "Malformed SIWE message.");
  if (parsed.domain && parsed.domain !== SIWE_DOMAIN) oops("bad_domain", "SIWE message domain does not match this service.");
  if (parsed.uri && parsed.uri !== SIWE_URI) oops("bad_uri", "SIWE message URI does not match this service.");
  if (parsed.chainId && Number(parsed.chainId) !== CHAIN_ID) oops("bad_chain", "SIWE message chain does not match this service.");
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= Date.now()) oops("expired", "SIWE message has expired.");
  const claimed = getAddress(parsed.address);
  const rec = siweNonces.get(parsed.nonce);
  siweNonces.delete(parsed.nonce);                       // single use, even on failure
  if (!rec || rec.exp < Date.now()) oops("bad_nonce", "Unknown or expired nonce.");
  if (getAddress(rec.address) !== claimed) oops("address_mismatch", "Address does not match nonce.");
  // EOA sigs verify OFFLINE (recover + compare) so a throttled RPC can never
  // block sign-in; the client-action fallback adds EIP-1271/6492 support for
  // smart-contract wallets, which genuinely needs the chain.
  let ok = false;
  try {
    const { recoverMessageAddress } = await import("viem");
    ok = (await recoverMessageAddress({ message, signature })).toLowerCase() === claimed.toLowerCase();
  } catch {}
  if (!ok) {
    try { ok = await (await rpcPool()).verifySiweMessage({ message, signature }); } catch {}
  }
  if (!ok) oops("bad_signature", "Signature verification failed.");
  return claimed;
}

// --- dispatch -------------------------------------------------------------------
export async function handleAccount(req, res, u, ctx) {
  if (!enabled) return err(ctx, res, req, 503, "accounts_disabled", "Accounts are not configured on this relay.");
  const p = u.pathname, ip = ctx.clientIp(req);

  if (p === "/v1/account/jwks" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...ctx.cors(req) });
    return res.end(JSON.stringify({ keys: [JWK] }));
  }

  // -- passkey registration ------------------------------------------------------
  if (p === "/v1/account/passkey/register/options" && req.method === "POST") {
    if (!rlMint(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const sess = await verifyAccountSession(req.headers.authorization);   // optional: add-credential
    const acct = sess && accounts.data.accounts[sess.accountId];
    const userHandle = acct ? acct.userHandle : b64u(randomBytes(16));
    const options = await webauthn.generateRegistrationOptions({
      rpName: "Enclave",
      rpID: RP_ID,
      userID: Buffer.from(userHandle, "base64url"),
      userName: "enclave user",                    // username-less: never shown as an identifier
      attestationType: "none",
      // ES256 ONLY (the library's default prefers Ed25519): the credit vault
      // verifies P-256 on-chain, so every credential must be vault-capable.
      // ES256 is WebAuthn's mandatory-to-implement algorithm - nothing real
      // supports EdDSA but not it.
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      excludeCredentials: (acct ? acct.passkeys : []).map((c) => ({ id: c.credId, transports: c.transports })),
    });
    const challengeId = rid("chal_");
    challenges.set(challengeId, { challenge: options.challenge, kind: "reg",
      accountId: acct ? acct.id : null, userHandle, exp: Date.now() + CHALLENGE_TTL_MS });
    bound(challenges);
    return ctx.json(res, 200, { challengeId, options }, req);
  }

  if (p === "/v1/account/passkey/register/verify" && req.method === "POST") {
    if (!rlVerify(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const b = await bodyJson(req, ctx); if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");
    const chal = challenges.get(String(b.challengeId || ""));
    challenges.delete(String(b.challengeId || ""));     // single use, even on failure
    if (!chal || chal.kind !== "reg" || chal.exp < Date.now())
      return err(ctx, res, req, 401, "bad_challenge", "Unknown or expired challenge; request new options.");
    let v;
    try {
      v = await webauthn.verifyRegistrationResponse({
        response: b.credential,
        expectedChallenge: chal.challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: false,
      });
    } catch (e) { return err(ctx, res, req, 400, "verify_failed", e.message); }
    if (!v.verified || !v.registrationInfo) return err(ctx, res, req, 401, "verify_failed", "Registration could not be verified.");
    if (accounts.data.byCredential[v.registrationInfo.credential.id])
      return err(ctx, res, req, 409, "credential_exists", "This passkey is already registered.");
    const acct = chal.accountId ? accounts.data.accounts[chal.accountId] : newAccount(chal.userHandle);
    if (!acct) return err(ctx, res, req, 401, "bad_challenge", "Account for this challenge no longer exists.");
    addPasskey(acct, v.registrationInfo, b.credential?.response?.transports, b.label);
    return ctx.json(res, 200, await mintAccountSession(acct.id, "passkey"), req);
  }

  // -- passkey login (username-less discoverable credential) ---------------------
  if (p === "/v1/account/passkey/login/options" && req.method === "POST") {
    if (!rlMint(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const options = await webauthn.generateAuthenticationOptions({
      rpID: RP_ID, allowCredentials: [], userVerification: "preferred",
    });
    const challengeId = rid("chal_");
    challenges.set(challengeId, { challenge: options.challenge, kind: "authn", exp: Date.now() + CHALLENGE_TTL_MS });
    bound(challenges);
    return ctx.json(res, 200, { challengeId, options }, req);
  }

  if (p === "/v1/account/passkey/login/verify" && req.method === "POST") {
    if (!rlVerify(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const b = await bodyJson(req, ctx); if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");
    const chal = challenges.get(String(b.challengeId || ""));
    challenges.delete(String(b.challengeId || ""));
    if (!chal || chal.kind !== "authn" || chal.exp < Date.now())
      return err(ctx, res, req, 401, "bad_challenge", "Unknown or expired challenge; request new options.");
    const credId = String(b.credential?.id || "");
    const acctId = accounts.data.byCredential[credId];
    const acct = acctId && accounts.data.accounts[acctId];
    const stored = acct && acct.passkeys.find((c) => c.credId === credId);
    if (!stored) return err(ctx, res, req, 401, "unknown_credential", "This passkey is not registered here.");
    let v;
    try {
      v = await webauthn.verifyAuthenticationResponse({
        response: b.credential,
        expectedChallenge: chal.challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: { id: stored.credId, publicKey: Buffer.from(stored.publicKey, "base64url"),
                      counter: stored.counter, transports: stored.transports },
      });
    } catch (e) { return err(ctx, res, req, 400, "verify_failed", e.message); }
    if (!v.verified) return err(ctx, res, req, 401, "verify_failed", "Authentication could not be verified.");
    stored.counter = v.authenticationInfo?.newCounter ?? stored.counter;
    stored.lastUsedAt = new Date().toISOString();
    accounts.saveSoon();
    return ctx.json(res, 200, await mintAccountSession(acct.id, "passkey"), req);
  }

  // -- SIWE ----------------------------------------------------------------------
  if (p === "/v1/account/siwe/nonce" && req.method === "GET") {
    if (!rlMint(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const { getAddress } = await import("viem");
    let address;
    try { address = getAddress(String(u.searchParams.get("address") || "")); }
    catch { return err(ctx, res, req, 422, "invalid_address", "Provide a valid ?address."); }
    return ctx.json(res, 200, siweNonceAnswer(address), req);
  }

  if (p === "/v1/account/siwe/verify" && req.method === "POST") {
    if (!rlVerify(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const b = await bodyJson(req, ctx); if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");
    let address;
    try { address = await siweVerify(b.message, b.signature); }
    catch (e) { return err(ctx, res, req, e.code === "invalid_request" || e.code === "invalid_message" ? 422 : 401, e.code || "bad_signature", e.message); }
    const key = address.toLowerCase();
    let acct = accounts.data.accounts[accounts.data.byWallet[key]];
    if (!acct) {                                          // find-or-create by wallet
      acct = newAccount(b64u(randomBytes(16)));
      acct.wallets.push(key);
      accounts.data.byWallet[key] = acct.id;
      accounts.saveSoon();
    }
    return ctx.json(res, 200, { ...(await mintAccountSession(acct.id, "siwe")), address }, req);
  }

  if (p === "/v1/account/link/siwe" && req.method === "POST") {
    const sess = await verifyAccountSession(req.headers.authorization);
    if (!sess) return err(ctx, res, req, 401, "unauthorized", "Sign in first.");
    if (!rlVerify(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const b = await bodyJson(req, ctx); if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");
    let address;
    try { address = await siweVerify(b.message, b.signature); }
    catch (e) { return err(ctx, res, req, 401, e.code || "bad_signature", e.message); }
    const key = address.toLowerCase();
    const owner = accounts.data.byWallet[key];
    if (owner && owner !== sess.accountId)
      return err(ctx, res, req, 409, "wallet_linked_elsewhere", "This wallet is already linked to another account.");
    const acct = accounts.data.accounts[sess.accountId];
    if (!acct.wallets.includes(key)) acct.wallets.push(key);
    accounts.data.byWallet[key] = acct.id;
    accounts.saveSoon();
    return ctx.json(res, 200, { ok: true, wallets: acct.wallets }, req);
  }

  // -- device flow: sign this browser in with a phone ----------------------------
  // A desktop with no usable passkey path (Linux Firefox, no Bluetooth) shows a
  // QR; the phone opens /link?code=…, authenticates however it likes, and
  // approves. The QR carries only the CODE - claiming the session additionally
  // needs the SECRET, which never leaves the initiating browser. There is no
  // proximity proof (unlike the browser-native hybrid flow), so the approve
  // screen shows requester context and warning copy; codes are short-lived and
  // single-use, and a leaked QR at worst lets a stranger sign the desktop into
  // the STRANGER's account - it can never hand the desktop's session away.
  if (p === "/v1/account/device/start" && req.method === "POST") {
    if (!rlMint(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    let code; do { code = deviceCode(); } while (deviceReqs.has(code));
    deviceReqs.set(code, { secret: rid(""), ua: String(req.headers["user-agent"] || "").slice(0, 200),
      ip, createdAt: Date.now(), exp: Date.now() + DEVICE_TTL_MS, state: "pending", accountId: null });
    bound(deviceReqs);
    const r = deviceReqs.get(code);
    return ctx.json(res, 200, { code, secret: r.secret, expiresAt: new Date(r.exp).toISOString(), interval: 3 }, req);
  }

  if (p === "/v1/account/device/info" && req.method === "GET") {
    if (!rlMint(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const r = deviceReqs.get(String(u.searchParams.get("code") || "").toUpperCase());
    if (!r || r.exp < Date.now()) return err(ctx, res, req, 404, "unknown_code", "This code is expired or unknown. Start again on your other screen.");
    return ctx.json(res, 200, { ua: r.ua, ip: r.ip, createdAt: new Date(r.createdAt).toISOString(), state: r.state }, req);
  }

  if (p === "/v1/account/device/approve" && req.method === "POST") {
    const sess = await verifyAccountSession(req.headers.authorization);
    if (!sess) return err(ctx, res, req, 401, "unauthorized", "Sign in first.");
    if (!rlVerify(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const b = await bodyJson(req, ctx); if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");
    const r = deviceReqs.get(String(b.code || "").toUpperCase());
    if (!r || r.exp < Date.now()) return err(ctx, res, req, 404, "unknown_code", "This code is expired or unknown. Start again on your other screen.");
    if (r.state !== "pending") return err(ctx, res, req, 409, "already_answered", "This request was already answered.");
    if (b.approve === true) { r.state = "approved"; r.accountId = sess.accountId; }
    else r.state = "denied";
    return ctx.json(res, 200, { ok: true, state: r.state }, req);
  }

  if (p === "/v1/account/device/claim" && req.method === "POST") {
    if (!rlMint(ip)) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const b = await bodyJson(req, ctx); if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");
    const code = String(b.code || "").toUpperCase();
    const r = deviceReqs.get(code);
    if (!r || r.exp < Date.now()) return err(ctx, res, req, 404, "unknown_code", "This code is expired or unknown.");
    const got = Buffer.from(String(b.secret || "")), want = Buffer.from(r.secret);
    if (got.length !== want.length || !timingSafeEqual(got, want))
      return err(ctx, res, req, 401, "bad_secret", "This claim does not match the request.");
    if (r.state === "pending") return ctx.json(res, 200, { status: "pending" }, req);
    if (r.state === "denied") { deviceReqs.delete(code); return ctx.json(res, 200, { status: "denied" }, req); }
    deviceReqs.delete(code);                              // single use
    return ctx.json(res, 200, { status: "ok", ...(await mintAccountSession(r.accountId, "phone")) }, req);
  }

  // -- profile / credential management ------------------------------------------
  if (p === "/v1/account/me" && req.method === "GET") {
    const sess = await verifyAccountSession(req.headers.authorization);
    if (!sess) return err(ctx, res, req, 401, "unauthorized", "Sign in first.");
    const a = accounts.data.accounts[sess.accountId];
    return ctx.json(res, 200, {
      accountId: a.id, createdAt: a.createdAt, amr: sess.amr, wallets: a.wallets,
      passkeys: a.passkeys.map((c) => ({ credId: c.credId, transports: c.transports,
        createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, label: c.label })),
    }, req);
  }

  const del = p.match(/^\/v1\/account\/passkey\/([A-Za-z0-9_-]+)$/);
  if (del && req.method === "DELETE") {
    const sess = await verifyAccountSession(req.headers.authorization);
    if (!sess) return err(ctx, res, req, 401, "unauthorized", "Sign in first.");
    const a = accounts.data.accounts[sess.accountId];
    const idx = a.passkeys.findIndex((c) => c.credId === del[1]);
    if (idx < 0) return err(ctx, res, req, 404, "not_found", "No such passkey on this account.");
    if (a.passkeys.length === 1 && !a.wallets.length)
      return err(ctx, res, req, 409, "last_method", "This is the account's only sign-in method; link a wallet or add another passkey first.");
    // the FIRST P-256 passkey is the credit-vault key (vaultKeyOf): the vault
    // address derives from it and every spend needs its signature, so deleting
    // it while the vault holds a balance would strand the money forever (no
    // key = no signature = no refund). Fail closed if the balance is unreadable.
    const vk = vaultKeyOf(sess.accountId);
    if (vk && vk.credId === del[1] && vaultEnabled()) {
      let balance6;
      try { balance6 = BigInt((await vaultInfo(vk)).balance6); }
      catch { return err(ctx, res, req, 503, "vault_unreachable", "Cannot verify this passkey's credit balance right now; try again shortly."); }
      if (balance6 > 0n) return err(ctx, res, req, 409, "vault_key_in_use",
        `This passkey controls $${(Number(balance6) / 1e6).toFixed(2)} of credit; spend or refund it before removing the passkey.`);
    }
    delete accounts.data.byCredential[del[1]];
    a.passkeys.splice(idx, 1);
    accounts.saveSoon();
    return ctx.json(res, 200, { ok: true }, req);
  }

  return err(ctx, res, req, 404, "not_found", "No such account endpoint.");
}
