// Relay account auth (relay/auth.js): drives the REAL relay as a child
// process. SIWE uses real viem signatures (the cli.test.mjs pattern); passkey
// ceremonies need a browser authenticator so here we pin the challenge
// lifecycle (single-use, expiry) and the store shapes - the Playwright suite
// exercises the full WebAuthn path with a CDP virtual authenticator.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import * as jose from "jose";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // well-known test key
const signer = privateKeyToAccount(PK);

async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}

async function startRelay(t, { dataDir }) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
    env: { ...process.env,
      ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
      AUTH_DATA_DIR: dataDir,
      OFAC_SDN_URLS: "http://127.0.0.1:1/x",            // no live fetches in tests
      BASE_RPC: "http://127.0.0.1:1/rpc", RPC_FALLBACKS: "0",
      SIWE_DOMAIN: "enclave.host", SIWE_URI: "https://enclave.host",
      FEATURED_VIEWS_FILE: path.join(dataDir, "feat.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + "/health"); if (r.ok) return { origin, child }; } catch {}
    await delay(100);
  }
  throw new Error("relay never answered /health");
}

const api = async (origin, method, p, { body, token } = {}) => {
  const r = await fetch(origin + p, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
               ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function siweLogin(origin, account) {
  const n = await api(origin, "GET", `/v1/account/siwe/nonce?address=${account.address}`);
  assert.equal(n.status, 200);
  const signature = await account.signMessage({ message: n.body.message });
  return api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n.body.message, signature } });
}

test("relay auth: SIWE roundtrip with a real signature; session verifies against the served JWKS", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auth-"));
  const { origin } = await startRelay(t, { dataDir: dir });

  const login = await siweLogin(origin, signer);
  assert.equal(login.status, 200);
  assert.match(login.body.accountId, /^acct_[0-9a-f]{24}$/);
  assert.equal(login.body.method, "siwe");
  assert.equal(login.body.address, signer.address);

  // the token is a real ES256 JWT that verifies against the public JWKS
  const jwks = await api(origin, "GET", "/v1/account/jwks");
  assert.equal(jwks.status, 200);
  const key = await jose.importJWK(jwks.body.keys[0], "ES256");
  const { payload, protectedHeader } = await jose.jwtVerify(login.body.token, key,
    { algorithms: ["ES256"], issuer: jwks.body.keys[0].kid });
  assert.equal(protectedHeader.kid, jwks.body.keys[0].kid);
  assert.equal(payload.sub, login.body.accountId);
  assert.equal(payload.amr, "siwe");
  assert.ok(!/^0x/.test(payload.sub), "account subs must never look like wallet addresses (trust-domain separation)");

  // profile works; wallet is linked lowercased
  const me = await api(origin, "GET", "/v1/account/me", { token: login.body.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.wallets, [signer.address.toLowerCase()]);
  assert.equal(me.body.passkeys.length, 0);

  // a second login from the same wallet lands on the SAME account
  const again = await siweLogin(origin, signer);
  assert.equal(again.body.accountId, login.body.accountId);
});

test("relay auth: nonce replay, tampered domain, and wrong signer are all 401", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auth-"));
  const { origin } = await startRelay(t, { dataDir: dir });

  // replay: a consumed nonce cannot log in twice
  const n1 = await api(origin, "GET", `/v1/account/siwe/nonce?address=${signer.address}`);
  const sig1 = await signer.signMessage({ message: n1.body.message });
  assert.equal((await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n1.body.message, signature: sig1 } })).status, 200);
  const replay = await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n1.body.message, signature: sig1 } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, "bad_nonce");

  // tampered domain: signature is valid for the STRING but the domain pin rejects
  const n2 = await api(origin, "GET", `/v1/account/siwe/nonce?address=${signer.address}`);
  const evil = n2.body.message.replace("enclave.host wants", "evil.example wants");
  const sig2 = await signer.signMessage({ message: evil });
  const bad = await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: evil, signature: sig2 } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "bad_domain");

  // wrong signer: someone else signing my nonce's message
  const other = privateKeyToAccount("0x" + "07".repeat(32));
  const n3 = await api(origin, "GET", `/v1/account/siwe/nonce?address=${signer.address}`);
  const sig3 = await other.signMessage({ message: n3.body.message });
  const forged = await api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n3.body.message, signature: sig3 } });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error, "bad_signature");
});

test("relay auth: passkey challenges are single-use; sessions and JWKS survive a restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auth-"));
  const first = await startRelay(t, { dataDir: dir });

  // registration options mint a challenge; a garbage credential consumes it...
  const opts = await api(first.origin, "POST", "/v1/account/passkey/register/options", { body: {} });
  assert.equal(opts.status, 200);
  assert.equal(opts.body.options.authenticatorSelection.residentKey, "required");   // username-less
  const garbage = { challengeId: opts.body.challengeId, credential: { id: "xx", response: {} } };
  const attempt1 = await api(first.origin, "POST", "/v1/account/passkey/register/verify", { body: garbage });
  assert.ok([400, 401].includes(attempt1.status));
  // ...and the SAME challengeId is dead on the second attempt, whatever the payload
  const attempt2 = await api(first.origin, "POST", "/v1/account/passkey/register/verify", { body: garbage });
  assert.equal(attempt2.status, 401);
  assert.equal(attempt2.body.error, "bad_challenge");

  // login with an unknown credential id names the failure
  const lopts = await api(first.origin, "POST", "/v1/account/passkey/login/options", { body: {} });
  assert.deepEqual(lopts.body.options.allowCredentials, []);                        // discoverable flow
  const unknown = await api(first.origin, "POST", "/v1/account/passkey/login/verify",
    { body: { challengeId: lopts.body.challengeId, credential: { id: "nope" } } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, "unknown_credential");

  // sign in, remember the token + kid, restart the relay on the same data dir
  const login = await siweLogin(first.origin, signer);
  const kid1 = (await api(first.origin, "GET", "/v1/account/jwks")).body.keys[0].kid;
  first.child.kill("SIGKILL");
  await delay(200);
  const second = await startRelay(t, { dataDir: dir });
  const kid2 = (await api(second.origin, "GET", "/v1/account/jwks")).body.keys[0].kid;
  assert.equal(kid2, kid1, "the ES256 key must persist across restarts (sessions stay valid)");
  const me = await api(second.origin, "GET", "/v1/account/me", { token: login.body.token });
  assert.equal(me.status, 200, "a pre-restart session still verifies");
  assert.deepEqual(me.body.wallets, [signer.address.toLowerCase()]);
});

test("relay auth: a wallet linked to one account cannot be linked to another", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auth-"));
  const { origin } = await startRelay(t, { dataDir: dir });

  const a = await siweLogin(origin, signer);                                  // wallet now belongs to account A
  const other = privateKeyToAccount("0x" + "07".repeat(32));
  const b = await siweLogin(origin, other);                                   // account B
  assert.notEqual(a.body.accountId, b.body.accountId);

  // B tries to link A's wallet: fresh nonce, real signature, still refused
  const n = await api(origin, "GET", `/v1/account/siwe/nonce?address=${signer.address}`);
  const sig = await signer.signMessage({ message: n.body.message });
  const link = await api(origin, "POST", "/v1/account/link/siwe",
    { body: { message: n.body.message, signature: sig }, token: b.body.token });
  assert.equal(link.status, 409);
  assert.equal(link.body.error, "wallet_linked_elsewhere");
});
