// Enclave supervisor - the WHOLE service, running INSIDE the Tinfoil enclave behind
// the shim (the single ingress). It is the measured/attested image: the same
// published code that checks a user's signature, gates on escrow, mints the
// session token, launches the per-use container, and proxies the data path.
//
// There is no external tier. Browser -> shim -> here, for BOTH control and data:
//   control:  /v1/*        (SIWE login, deployments, account, attestation)
//   data:     /x/:id/*     (verify session token + ownership, proxy to the
//                           spawned container; fly.io used to do nothing here -
//                           now nothing external touches a prompt at all)
//
// One token type: the session JWT the browser gets at login is reused as the
// capability on the data path. It is ES256-signed by a key MINTED IN-ENCLAVE at
// boot (see initSessionKey) — the operator, who provisions the fleet SECRET,
// cannot forge one because the private half never leaves this CVM. SECRET now
// only backs the manager control-token and the DNS-push HMAC — it never signs
// or verifies a session token.
//
// >>> The ONLY thing left to implement for your CVM is spawn/stop/measure below.

import express from "express";
import cors from "cors";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { createHash, createHmac, randomBytes, generateKeyPairSync, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify, timingSafeEqual, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { WebSocketServer, createWebSocketStream } from "ws";
import { verifyMessage, createPublicClient, createWalletClient, http as viemHttp, getAddress, keccak256, toHex, stringToBytes, parseEventLogs, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { SignJWT, jwtVerify } from "jose";
import { Verifier, assembleAttestationBundle } from "@tinfoilsh/verifier";
// dedicated-IP egress: the outbound half of the per-deployment address (see egress.js)
import { createEgress } from "./egress.js";
// contract addresses: LIVE BINDINGS owned by addressbook.js — seeded from the
// baked env, overridden from the on-chain EnclaveAddressBook when
// ADDRESS_BOOK_ADDRESS is set, and re-polled so contract redeploys reach a
// RUNNING enclave without a new release.
import { initAddressBook, REGISTRY_ADDRESS, DEPLOYMENTS_ADDRESS, APP_CATALOG_ADDRESS,
         FORWARDER_ADDRESS } from "./addressbook.js";

// Process-wide crash guards. This is Express 4: a rejected async route (or any
// stray background rejection) would otherwise take the whole process down —
// killing EVERY tenant app hosted on this CVM, not just the one request. Log in
// the house style and KEEP RUNNING; per-request failures are already answered by
// the wrap() adapter + error middleware (see the app below). We deliberately do
// NOT exit: a single bad request or a transient library throw must never evict
// the fleet of apps this supervisor is fronting.
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal-guard] unhandledRejection (kept running): ${reason && (reason.stack || reason.message || reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[fatal-guard] uncaughtException (kept running): ${err && (err.stack || err.message || err)}`);
});

// Resolve the book BEFORE anything below derives state from the addresses
// (top-level await; a no-op without ADDRESS_BOOK_ADDRESS, baked env on failure).
await initAddressBook();

// ----------------------------------------------------------------------------
// config
// ----------------------------------------------------------------------------
const PORT           = parseInt(process.env.PORT || "8080", 10);
const SECRET         = new TextEncoder().encode(need("SECRET")); // signs + verifies the session/capability token
const PUBLIC_URL     = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // own shim URL; else derived per-request
const SIWE_DOMAIN    = process.env.SIWE_DOMAIN || "enclave.host";
const SIWE_URI       = process.env.SIWE_URI || "https://enclave.host";
const CHAIN_ID       = parseInt(process.env.CHAIN_ID || "8453", 10);
const CORS_ORIGINS   = (process.env.CORS_ORIGINS || "https://enclave.host").split(",").map(s => s.trim()).filter(Boolean);

// ---- session signing key (in-enclave, asymmetric) --------------------------
// The session JWT proves "you hold wallet X" for private deployments, logs, and
// owner-only endpoints. It USED to be HS256 over the fleet-wide SECRET — but that
// makes the MINTING key equal to the VERIFYING key equal to a value the operator
// provisions, so the operator could mint a token for ANY wallet and skip the
// signature check that login enforces. Now the token is ES256, signed by an
// EC P-256 private key MINTED IN-ENCLAVE at boot (like the TLS-bridge key): the
// operator never sees the private half, so they cannot forge a session. The
// public half is published (/v1/session-jwks, and inside /v1/attestation) so
// anyone can verify a token — and confirm the operator did not mint it — holding
// no secret. Persisted to its OWN tmpfs (never host disk) so a container restart
// within a CVM boot keeps sessions valid; a full relaunch mints a fresh key, at
// which point clients re-attest + re-login anyway (the shim TLS pin also rotates).
const SESSION_KEY_DIR = process.env.SESSION_KEY_DIR || "/mnt/ramdisk/enclave-session";
let SESSION_PRIV = null, SESSION_PUB = null, SESSION_JWK = null, SESSION_KID = "";

function initSessionKey() {
  const keyPath = join(SESSION_KEY_DIR, "session-ec-p256.pkcs8.pem");
  let privObj = null;
  try { privObj = createPrivateKey(readFileSync(keyPath, "utf8")); } catch {}   // reuse across a container restart
  if (!privObj) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    privObj = privateKey;
    try {
      mkdirSync(SESSION_KEY_DIR, { recursive: true });
      writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    } catch (e) { console.error("[session] tmpfs persist failed — key is in-memory only this boot:", e.message); }
    console.log("[session] minted in-enclave ES256 session-signing key");
  }
  SESSION_PRIV = privObj;
  SESSION_PUB  = createPublicKey(privObj);
  const j = SESSION_PUB.export({ format: "jwk" });                 // { kty:'EC', crv:'P-256', x, y }
  SESSION_KID = jwkThumbprint(j);                                  // RFC 7638; stable per key, unique per enclave
  SESSION_JWK = { kty: j.kty, crv: j.crv, x: j.x, y: j.y, kid: SESSION_KID, alg: "ES256", use: "sig" };
}

// Mint the session token: ES256 over the in-enclave key. `iss`/`kid` = our key
// thumbprint, so a verifier can tell OUR tokens from another enclave's.
async function mintSession(subject, expiresAt) {
  return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: SESSION_KID })
    .setIssuer(SESSION_KID).setSubject(subject)
    .setExpirationTime(expiresAt.getTime() / 1000 | 0).sign(SESSION_PRIV);
}

// Verify a session token -> checksummed address, or null. ES256 ONLY, verified
// against our in-enclave PUBLIC key, with `algorithms` pinned so no other alg
// (e.g. an HS256 token an attacker tries to have verified against the EC key as
// an HMAC secret — the classic alg-confusion) is ever accepted. A token whose
// kid is a DIFFERENT enclave's fails closed here → the client re-runs SIWE
// against whichever enclave serves it (pin-to-issuer). On the current
// single-enclave fleet that never triggers. (Transparent fleet roaming via
// attestation-anchored peer JWKS is the documented follow-on — see docs/session-auth.md.)
async function verifySessionToken(token) {
  if (!token || typeof token !== "string" || !SESSION_PUB) return null;
  let hdr;
  try { hdr = JSON.parse(Buffer.from(token.split(".")[0] || "", "base64url").toString("utf8")); } catch { return null; }
  if (!hdr || hdr.alg !== "ES256" || hdr.kid !== SESSION_KID) return null;
  try { const { payload } = await jwtVerify(token, SESSION_PUB, { algorithms: ["ES256"], issuer: SESSION_KID }); return getAddress(payload.sub); }
  catch { return null; }
}
// This enclave's on-chain identity is bound to its OWN attested shim-cert SAN
// (see registerFromShimCert), never to the request Host/x-forwarded-host header —
// a spoofable value — so no caller can make the enclave advertise a bogus origin.
// --- pay-per-deploy (no custody): users pay the EnclavePay forwarder; the supervisor
//     WATCHES it for Paid events and converts each payment to runtime. No held
//     balance, no escrow contract, no key in the enclave that can move funds.
//     (FORWARDER_ADDRESS is a live binding from ./addressbook.js)
const USDC_ADDRESS       = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
// --- app approval: EnclaveAppCatalog (read-only) is the deploy gate for ALL apps
//     (the image ships no deployable apps of its own). Only the catalog's owner
//     (the EOA that deployed it) can approve/reject a version, by signing a
//     setApproval transaction; an ipfs://<cid> deploy is refused until its
//     version is Approved. Empty = nothing can deploy at all (fail closed).
//     (APP_CATALOG_ADDRESS is a live binding from ./addressbook.js)
const PAYMENT_WINDOW_SEC = parseInt(process.env.PAYMENT_WINDOW_SEC || "600", 10); // unpaid awaiting_payment TTL
// Cap concurrent UNPAID (awaiting_payment) reservations per owner. Each one holds
// hardware for the whole PAYMENT_WINDOW_SEC before any money lands, so without a
// bound one wallet could reserve the node's capacity for free. Paid/running
// deployments are never counted. 0 disables the cap (previous behavior).
const MAX_UNPAID_PER_OWNER = parseInt(process.env.MAX_UNPAID_PER_OWNER || "3", 10);
const GRACE_SEC          = parseInt(process.env.GRACE_SEC || "90", 10);           // post-expiry grace before teardown
const PAY_POLL_SEC       = parseInt(process.env.PAY_POLL_SEC || "12", 10);        // Base log poll interval
// --- fair billing: funded runtime is a BALANCE, not a wall-clock deadline -----
// remainingMs drains only on ticks where the platform is actually serving:
// supervisor up, backend manager healthy, payment watcher fresh, app instance
// alive. Any outage FREEZES every clock; it resumes on the first healthy tick.
// State is persisted so a supervisor restart freezes (never forfeits) the clock.
const BILL_TICK_SEC      = parseInt(process.env.BILL_TICK_SEC || "15", 10);       // billing/reaper cadence
const WATCHER_STALE_SEC  = Math.max(60, 5 * PAY_POLL_SEC);                        // watcher silence that freezes billing
const STATE_FILE         = process.env.STATE_FILE || "/var/lib/enclave/state.json";   // mount a volume here to survive restarts
// manual-billing / pilot: boot deployments WITHOUT waiting for an on-chain payment.
//   AUTO_PROVISION=1            -> every deploy provisions immediately (closed pilot).
//   ADMIN_TOKEN set            -> operator can provision one deployment on demand via
//                                 POST /v1/admin/deployments/:id/provision (x-admin-token).
//   AUTO_PROVISION_HOURS > 0   -> optional safety expiry; 0 = runs until deleted.
const AUTO_PROVISION       = /^(1|true|on)$/i.test(process.env.AUTO_PROVISION || "");
const AUTO_PROVISION_HOURS = parseFloat(process.env.AUTO_PROVISION_HOURS || "0");
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || "";
const BASE_RPC       = process.env.BASE_RPC || "https://mainnet.base.org";
const SESSION_TTL    = parseInt(process.env.SESSION_TTL || "604800", 10); // 7d: SIWE is lazy now (only logs/attestation/private data need it) - make the one signature rare
const DEFAULT_IMAGE  = process.env.DEFAULT_IMAGE || "debian:bookworm-slim"; // any stock image
// --- worker launch: tenants run as the manager's wasmtime/CUDA processes ------
const MPS_PIPE_DIR   = process.env.CUDA_MPS_PIPE_DIRECTORY || "/tmp/nvidia-mps";
const ENABLE_MPS     = !/^(0|false|off)$/i.test(process.env.ENABLE_MPS || "1"); // MPS enforces BOTH the SM cap and the VRAM cap (validated under CC)
const SPAWN_TIMEOUT_MS = parseInt(process.env.SPAWN_TIMEOUT_MS || "300000", 10); // includes image pull / wasm fetch (prefetched claims hit the cache, this is headroom)
const WORKER_MEM      = process.env.WORKER_MEM || "16g";                // host-RAM cap per worker (not GPU)
const WORKER_PIDS     = process.env.WORKER_PIDS || "512";
// ---- worker MANAGER (Layer 2/3) --------------------------------------------
// The GPU container runs a manager that forks one MPS-capped CHILD PROCESS per
// tenant. The supervisor routes deploys/submissions HERE instead of creating
// containers itself (Tinfoil forbids runtime container creation). Reachable over
// the enclave-local network; default loopback.
const WORKER_MGR_URL  = (process.env.WORKER_MGR_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
// Opt-in bearer for the GPU worker manager's control plane (worker/worker.py
// WORKER_TOKEN). Unset = no header (worker runs its loopback-only, tokenless
// default); set the SAME value in both envs to require auth on /tenants,/run,etc.
const WORKER_TOKEN    = process.env.WORKER_TOKEN || "";
// provisioning backend: "worker" = GPU PTX submission (default), "vm" = tenant-app
// hosting via the app manager on VMMGR_URL (the wasm-manager runs each app as a
// `wasmtime serve` process). The "vm"/VMMGR_URL names are legacy, kept for config compat.
const PROVISION_BACKEND = (process.env.PROVISION_BACKEND || "worker").toLowerCase();
const VMMGR_URL = (process.env.VMMGR_URL || "http://127.0.0.1:8091").replace(/\/+$/, "");
function mgrReq(method, path, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(WORKER_MGR_URL + path);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: timeoutMs,
        headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}),
                   ...(WORKER_TOKEN ? { "Authorization": `Bearer ${WORKER_TOKEN}` } : {}) } },
      (res) => { let buf = ""; res.on("data", (c) => (buf += c));
                 res.on("end", () => { let j; try { j = JSON.parse(buf || "{}"); } catch { j = { raw: buf }; }
                                       resolve({ status: res.statusCode || 0, body: j }); }); });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("manager timeout")));
    if (data) r.write(data); r.end();
  });
}
async function mgrHealth(timeoutMs = 3000) {
  const r = await mgrReq("GET", "/health", null, timeoutMs);
  if (r.status !== 200) throw new Error(`manager /health ${r.status}`);
  // the worker holds the card this container can't see: adopt its probed VRAM
  if (r.body && r.body.gpuVramSource === "nvidia-smi") adoptCardVram(r.body.gpuVramGb, "worker");
  return r.body;
}

// --- app manager client ("vm" backend on VMMGR_URL; the wasm-manager) --------
// The manager's control API is loopback-reachable by TENANTS too (guests hold
// outbound HTTP), so it enforces a shared control token when configured: both
// containers get the same SECRET and the manager rejects control calls without
// it. VMMGR_TOKEN overrides if the two ever need to differ.
const VMMGR_TOKEN = process.env.VMMGR_TOKEN || process.env.SECRET || "";
function vmReq(method, path, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(VMMGR_URL + path);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: timeoutMs,
        headers: { "Content-Type": "application/json", ...(VMMGR_TOKEN ? { "X-Vmmgr-Token": VMMGR_TOKEN } : {}),
                   ...(data ? { "Content-Length": data.length } : {}) } },
      (res) => { let buf = ""; res.on("data", (c) => (buf += c));
                 res.on("end", () => { let j; try { j = JSON.parse(buf || "{}"); } catch { j = { raw: buf }; }
                                       resolve({ status: res.statusCode || 0, body: j }); }); });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("vmmanager timeout")));
    if (data) r.write(data); r.end();
  });
}
async function vmHealth(timeoutMs = 3000) {
  const r = await vmReq("GET", "/health", null, timeoutMs);
  if (r.status !== 200) throw new Error(`vmmanager /health ${r.status}`);
  // the wasm-manager holds the card this container can't see: adopt its probed VRAM
  if (r.body && r.body.gpuVramSource === "nvidia-smi") adoptCardVram(r.body.gpuVramGb, "manager");
  return r.body;
}

// ---- on-chain discovery: self-register in EnclaveRegistry (no trusted gateway) --
// On boot the enclave publishes itself (endpoint + attestation repo) to the
// registry contract on Base, then heartbeats. Callers read the registry from
// any RPC and connect DIRECTLY, verifying attestation themselves. Entirely
// opt-in: if REGISTRY_ENABLED isn't set, the enclave just doesn't advertise.
const REGISTRY_ENABLED  = /^(1|true|on)$/i.test(process.env.REGISTRY_ENABLED || "");
// (REGISTRY_ADDRESS is a live binding from ./addressbook.js)
const REGISTRY_PK       = process.env.REGISTRY_PRIVATE_KEY || "";        // operator key (enclave secret); needs a little Base ETH for gas
const ENCLAVE_REPO      = process.env.ENCLAVE_REPO || "";                // e.g. "EnclaveHost/enclave" - what callers attest against; MUST match GitHub's canonical casing (Sigstore compares it verbatim)
const ENCLAVE_MEASUREMENT = process.env.ENCLAVE_MEASUREMENT || ("0x" + "0".repeat(64)); // optional cross-check
const HEARTBEAT_SEC     = parseInt(process.env.REGISTRY_HEARTBEAT_SEC || "900", 10);
// The endpoint we advertise is NOT configured — it is derived from the request
// (originOf: the exact hostname the caller reached us at, which is the attested
// one and the only thing a verifier can use). Static config is validated once;
// the endpoint arrives per-request. PUBLIC_URL, if set, pins it (eager register).
const REGISTRY_READY    = REGISTRY_ENABLED && !!(REGISTRY_ADDRESS && REGISTRY_PK && ENCLAVE_REPO);
if (REGISTRY_ENABLED && !REGISTRY_READY)
  console.warn("[registry] REGISTRY_ENABLED but REGISTRY_ADDRESS/REGISTRY_PRIVATE_KEY/ENCLAVE_REPO incomplete — not advertising");
const REGISTRY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }],
    outputs: [{ name: "id", type: "bytes32" }] },
  { type: "function", name: "heartbeat", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
];

// Register THIS enclave under `endpoint` (the hostname a caller reached us at),
// then heartbeat. Fires at most once (guarded); a transient failure resets the
// guard so a later request retries. Never fatal — a failed advertisement must
// not take down the enclave.
let _registered = false;
let _enclaveId = null;            // our EnclaveRegistry id (keccak256 of the advertised endpoint); claim gating needs it
let _advertisedEndpoint = null;   // the endpoint we registered under; adopted deployments build their URL from it
let _certSan = null;              // our own attested shim-cert SAN hostname — the ONLY name we self-register / advertise
async function registerOnChain(endpoint) {
  endpoint = (endpoint || "").replace(/\/+$/, "");
  if (!REGISTRY_READY || _registered || !endpoint) return;
  _registered = true;                                       // claim before await so a request burst registers once
  try {
    // register/heartbeat go through the shared operator-tx queue (sendOperatorTx,
    // defined with the claim loop): the SAME EOA signs registry and ledger txs,
    // and public RPCs cap EIP-7702-delegated accounts at one in-flight tx — so
    // every tx from this key is serialized through confirmation, never raced.
    const id = keccak256(stringToBytes(endpoint));
    const hash = await sendOperatorTx(REGISTRY_ADDRESS, REGISTRY_ABI, "register",
      [endpoint, ENCLAVE_REPO, ENCLAVE_MEASUREMENT]);
    _enclaveId = id; _advertisedEndpoint = endpoint;        // unlocks the claim loop (portable deployments)
    console.log(`[registry] registered ${endpoint} repo=${ENCLAVE_REPO} id=${id} tx=${hash}`);
    // heartbeat loop - refresh liveness so readers don't treat us as down
    setInterval(async () => {
      try {
        const h = await sendOperatorTx(REGISTRY_ADDRESS, REGISTRY_ABI, "heartbeat", [id]);
        console.log(`[registry] heartbeat tx=${h}`);
      } catch (e) { console.warn(`[registry] heartbeat failed: ${e.shortMessage || e.message}`); }
    }, Math.max(60, HEARTBEAT_SEC) * 1000).unref();
  } catch (e) {
    _registered = false;                                    // let a later request retry
    console.warn(`[registry] self-registration failed: ${e.shortMessage || e.message}`);
  }
}

// Boot-time hostname discovery: the shim terminates TLS inside this CVM, and
// its certificate names this enclave's public ingress (<name>.containers.
// tinfoil.dev) in the SANs — the same cert whose key the attestation quote
// binds, so it is stronger provenance for our own endpoint than the Host
// header of whoever happens to call first. Reading it over loopback lets a
// fresh enclave advertise without config and without waiting for external
// traffic — which may never come: discovery needs the registry entry, and the
// entry needed traffic (the lazy middleware alone deadlocks on this).
function shimCertHostname(port = 443, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      try {
        const sans = (s.getPeerX509Certificate()?.subjectAltName || "")
          .split(",").map((e) => e.trim()).filter((e) => e.startsWith("DNS:")).map((e) => e.slice(4));
        // the public ingress name; *.hpke/*.hatt.tinfoil.sh SANs are Tinfoil-internal
        resolve(sans.find((n) => /\.containers\.tinfoil\.dev$/i.test(n)) || null);
      } catch (e) { reject(e); } finally { s.destroy(); }
    });
    s.setTimeout(timeoutMs, () => s.destroy(new Error("shim cert read timeout")));
    s.on("error", reject);
  });
}
// Self-register ONLY our own attested shim-cert SAN — never the request Host.
// Caches the SAN once discovered so originOf() and the lazy trigger reuse it.
async function registerFromShimCert() {
  if (!REGISTRY_READY || _registered) return;
  const name = _certSan || (_certSan = await shimCertHostname());
  if (name) await registerOnChain("https://" + name);
}
// Register eagerly from the shim cert, retrying with backoff: early in boot the
// shim may present a placeholder cert with no public SAN (ACME still running),
// and a register tx can fail transiently. The lazy per-request path (below) also
// kicks this, and the loop ends the moment either wins (_registered).
async function advertiseFromShimCert() {
  for (let delaySec = 5; REGISTRY_READY && !_registered; delaySec = Math.min(delaySec * 2, 300)) {
    try {
      await registerFromShimCert();
      if (!_registered && !_certSan) console.log("[registry] shim cert has no public SAN yet — retrying");
    } catch (e) { console.warn(`[registry] shim cert read failed (${e.message}) — retrying`); }
    if (!_registered) await new Promise((r) => setTimeout(r, delaySec * 1000).unref());
  }
}
function need(n){ const v = process.env[n]; if(!v){ console.error("FATAL: missing env", n); process.exit(1);} return v; }

// ============================================================================
// in-enclave ACME (RFC 8555) - PURE HALF: crypto/DER/JOSE helpers, no network,
// no state. Browsers reaching <label>.APP_CERT_DOMAIN should terminate TLS
// INSIDE this CVM, not at the relay's Caddy - which means the enclave itself
// must hold a CA-signed cert for each app subdomain. So the supervisor speaks
// ACME directly: ZeroSSL by default (its External Account Binding means one
// EAB credential pair works forever, with no per-boot account approval), the
// dns-01 challenge (the enclave serves no port 80, and the TXT record is
// pushed through the platform DNS daemon), and a hand-built PKCS#10 CSR
// (Node can mint keys but not CSRs; the ~90 lines of DER below are the whole
// gap, same spirit as the hand-rolled ABI/DER encodings elsewhere).
//
// CVMs have no disk, so certs live in memory and re-issue on every boot -
// that is deliberate (ZeroSSL has no rate ceilings that bite at our scale,
// and a key that never touches storage is a key nobody can exfiltrate).
//
// The runtime half (account, orders, issuance queue, SNI contexts) lives next
// to the TLS bridge below. These helpers sit up here, before ANY boot side
// effect, so ACME_SELFTEST can exercise them and exit: this monolith exports
// nothing, so `ACME_SELFTEST=csr node supervisor.js` IS the test seam
// (test/acme.test.mjs validates the outputs with openssl and jose).
// ----------------------------------------------------------------------------
// Feature is OFF unless ALL of the required envs are set (everything below
// no-ops gracefully when disabled):
const ACME_DIRECTORY  = (process.env.ACME_DIRECTORY || "https://acme.zerossl.com/v2/DV90").replace(/\/+$/, "");
const ACME_EAB_KID    = (process.env.ACME_EAB_KID  || "").trim();   // ZeroSSL EAB key id
const ACME_EAB_HMAC   = (process.env.ACME_EAB_HMAC || "").trim();   // ZeroSSL EAB HMAC key (base64url)
const APP_CERT_DOMAIN = (process.env.APP_CERT_DOMAIN || "").trim().replace(/^\*?\./, "").replace(/\.$/, "").toLowerCase(); // e.g. "app.enclave.host"
const DNS_API         = (process.env.DNS_API || "").trim().replace(/\/+$/, "");  // platform DNS daemon's TXT push API
const ACME_ENABLED    = !!(ACME_EAB_KID && ACME_EAB_HMAC && APP_CERT_DOMAIN && DNS_API);

// base64url without padding - the encoding EVERYTHING in JOSE/ACME speaks.
const b64u     = (b) => Buffer.from(b).toString("base64url");
const b64uJson = (o) => b64u(JSON.stringify(o));

// RFC 7638 JWK thumbprint: sha256 over the canonical JSON of the REQUIRED
// members only, keys in lexicographic order - for an EC key that is exactly
// {"crv","kty","x","y"}, no whitespace, nothing else. Building the string by
// hand (not JSON.stringify of the object) is the point: member order in the
// source object must not matter. (Cross-checked against jose in the tests.)
function jwkThumbprint(jwk) {
  return b64u(createHash("sha256").update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest());
}

// dns-01 proof: keyAuthorization = token "." thumbprint; the TXT value the CA
// looks for is base64url(sha256(keyAuthorization)) (RFC 8555 §8.4).
const dns01TxtValue = (token, thumbprint) => b64u(createHash("sha256").update(`${token}.${thumbprint}`).digest());

// One flat-format JWS, ES256 (all ACME envelope signatures). The signature is
// raw R||S (ieee-p1363), NOT the DER that ECDSA usually emits - JOSE's one
// deviation. payload === null -> "" (POST-as-GET, RFC 8555 §6.3).
function jwsSignEs256(protectedHeader, payload, privateKey) {
  const prot = b64uJson(protectedHeader);
  const body = payload === null ? "" : b64uJson(payload);
  const sig  = cryptoSign("sha256", Buffer.from(`${prot}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { protected: prot, payload: body, signature: b64u(sig) };
}

// External Account Binding (RFC 8555 §7.3.4): an INNER JWS proving we hold the
// CA-issued EAB credential. HS256 with the base64url-DECODED HMAC key; the
// payload is our ACME account's public JWK; url = the newAccount URL. It rides
// inside the newAccount payload, not the envelope.
function eabJws(kid, hmacB64u, accountJwk, newAccountUrl) {
  const prot    = b64uJson({ alg: "HS256", kid, url: newAccountUrl });
  const payload = b64uJson(accountJwk);
  const sig     = createHmac("sha256", Buffer.from(hmacB64u, "base64url")).update(`${prot}.${payload}`).digest();
  return { protected: prot, payload, signature: b64u(sig) };
}

// ---- minimal DER writer + PKCS#10 CSR builder ------------------------------
// Just enough ASN.1 to emit one CSR: TLV with long-form lengths, OIDs, and the
// handful of universal types a CertificationRequest touches. Everything is a
// Buffer in, Buffer out; structures compose by concatenation.
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = []; for (let x = n; x > 0; x >>>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const derTlv   = (tag, ...body) => { const b = Buffer.concat(body); return Buffer.concat([Buffer.from([tag]), derLen(b.length), b]); };
const derSeq   = (...p) => derTlv(0x30, ...p);
const derSet   = (...p) => derTlv(0x31, ...p);
const derInt0  = ()     => derTlv(0x02, Buffer.from([0]));            // INTEGER 0 (the only integer a CSR needs: version)
const derOctet = (b)    => derTlv(0x04, b);
const derBits  = (b)    => derTlv(0x03, Buffer.from([0]), b);          // BIT STRING, 0 unused bits
const derUtf8  = (s)    => derTlv(0x0c, Buffer.from(s, "utf8"));
const derCtx   = (n, constructed, ...body) => derTlv((constructed ? 0xa0 : 0x80) | n, ...body);
function derOid(oid) {
  const a = oid.split(".").map(Number), body = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const enc = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) enc.unshift((x & 0x7f) | 0x80);
    body.push(...enc);
  }
  return derTlv(0x06, Buffer.from(body));
}
const pemWrap = (label, der) =>
  `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;

// Build a CSR for ONE dns name: fresh P-256 pair, subject CN=name (cosmetic -
// CAs read the SAN), and an extensionRequest attribute carrying subjectAltName
// with that single dNSName. Signed ecdsa-with-SHA256; crypto.sign with
// dsaEncoding "der" already emits the DER ECDSA-Sig-Value the BIT STRING wants.
function buildCsr(name) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });        // already a full DER SubjectPublicKeyInfo
  const san  = derSeq(derCtx(2, false, Buffer.from(name, "ascii")));     // GeneralNames: [2] dNSName (context-primitive IA5 bytes)
  const ext  = derSeq(derOid("2.5.29.17"), derOctet(san));               // Extension: id-ce-subjectAltName, extnValue OCTET STRING
  const attr = derSeq(derOid("1.2.840.113549.1.9.14"), derSet(derSeq(ext))); // pkcs-9-at-extensionRequest { SET { Extensions } }
  const cri  = derSeq(                                                   // CertificationRequestInfo
    derInt0(),                                                           //   version 0
    derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(name)))),            //   subject: CN=name
    spki,                                                                //   subjectPKInfo
    derCtx(0, true, attr));                                              //   attributes [0] IMPLICIT SET OF Attribute
  const sig  = cryptoSign("sha256", cri, { key: privateKey, dsaEncoding: "der" });
  const csr  = derSeq(cri, derSeq(derOid("1.2.840.10045.4.3.2")), derBits(sig)); // + ecdsa-with-SHA256 (params absent per RFC 5758)
  return { csrDer: csr, csrPem: pemWrap("CERTIFICATE REQUEST", csr),
           keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

// ---- self-test seam ---------------------------------------------------------
// ACME_SELFTEST=csr|vectors prints the helpers' outputs as one JSON line and
// exits BEFORE any boot side effect (nothing above this point opens a socket
// or touches state). Driven by test/acme.test.mjs; also handy in a CVM shell.
// Never active in production - the var appears in no env file.
if (process.env.ACME_SELFTEST) {
  if (process.env.ACME_SELFTEST === "csr") {
    const name = process.env.ACME_SELFTEST_NAME || "test.app.enclave.host";
    const { csrPem, keyPem } = buildCsr(name);
    console.log(JSON.stringify({ name, csrPem, keyPem }));
  } else {
    // RFC 7515 Appendix A.3's P-256 key: the fixed vector the tests compare
    // against an independent RFC 7638 implementation (jose).
    const vec = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ownJwk = publicKey.export({ format: "jwk" });
    const jws = jwsSignEs256({ alg: "ES256", nonce: "nonce", url: "https://ca/x" }, { hello: 1 }, privateKey);
    console.log(JSON.stringify({
      thumbprint: jwkThumbprint(vec),
      thumbprintScrambled: jwkThumbprint({ y: vec.y, x: vec.x, kty: vec.kty, crv: vec.crv, extra: "ignored" }),
      ownThumbprintStable: jwkThumbprint(ownJwk) === jwkThumbprint({ ...ownJwk }),
      b64uRoundtrip: Buffer.from(b64u(Buffer.from([0, 251, 255, 62, 63])), "base64url").equals(Buffer.from([0, 251, 255, 62, 63])),
      b64uNoPad: !/[=+/]/.test(b64u(randomBytes(33))),
      jwsVerifies: cryptoVerify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`),
                                { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url")),
      dns01: dns01TxtValue("token", jwkThumbprint(vec)),
      eab: eabJws("kid1", b64u(Buffer.from("secret")), vec, "https://ca/newAccount"),
    }));
  }
  process.exit(0);
}

// ---- reachability watchdog — pure half --------------------------------------
// The 2026-07-11 kryptos failure: a CVM whose public DNS record vanished (the
// whole front went with it) but whose OUTBOUND still worked kept claiming and
// renewing on-chain work for six hours — tenants paid for apps nobody could
// reach. Detection keys on ONE precise signal: the advertised hostname
// disappearing from public DNS, affirmed by EVERY configured DoH resolver,
// REACH_DNS_STRIKES checks in a row. DNS-over-HTTPS because it needs no
// hairpin route (a self-request through our own front might) and no trust in
// the CVM's local resolver; a resolver outage reads as SERVFAIL/timeout ->
// "error" -> the strike count HOLDS, so third-party trouble never trips it.
// Any positive answer resets everything. The impure half (DoH fetch, the
// trip/abandon actions) lives with the claim loop; these helpers sit up here,
// before any boot side effect, for the REACH_SELFTEST seam below.

// The hostname worth watching in an advertised endpoint, or null when DNS has
// nothing to lose: IP literals, localhost, mDNS names, single labels (dev
// setups) resolve outside public DNS or not at all.
function reachHostname(endpoint) {
  let host; try { host = new URL(endpoint).hostname; } catch { return null; }
  host = host.replace(/^\[|\]$/g, "").toLowerCase();          // URL keeps IPv6 brackets
  if (net.isIP(host) || !host.includes(".") || host.endsWith(".local")) return null;
  return host;
}

// One DoH JSON body -> "resolves" | "gone" | "error". "gone" only when the
// resolver AFFIRMED the absence: NXDOMAIN (Status 3), or NOERROR with an empty
// answer section. Any record of any type (a CNAME counts: the zone still knows
// the name) is proof of life. Anything else — SERVFAIL, REFUSED, junk — is
// "error" and must never advance the trip counter.
function dohVerdict(body) {
  if (!body || typeof body.Status !== "number") return "error";
  if (body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length) return "resolves";
  if (body.Status === 0 || body.Status === 3) return "gone";
  return "error";
}

// Fold one round of per-resolver verdicts into the next watchdog state. Pure —
// the caller owns fetching and the trip side effects. ANY resolver seeing the
// name = healthy (full reset, clears a trip); EVERY resolver affirming "gone"
// = one strike, tripping at `strikes`; a mixed or errored round holds still.
function reachStep(state, verdicts, strikes) {
  if (!verdicts.length || verdicts.some((v) => v === "resolves")) return { strikes: 0, tripped: false };
  if (verdicts.every((v) => v === "gone")) {
    const n = state.strikes + 1;
    return { strikes: n, tripped: state.tripped || n >= strikes };
  }
  return { strikes: state.strikes, tripped: state.tripped };
}

// REACH_SELFTEST='{"hosts":[...],"bodies":[...],"steps":[{state,verdicts,strikes}]}'
// prints each helper mapped over its inputs as one JSON line and exits — same
// contract as ACME_SELFTEST above (test/reach.test.mjs drives it).
if (process.env.REACH_SELFTEST) {
  const cases = JSON.parse(process.env.REACH_SELFTEST);
  console.log(JSON.stringify({
    hosts: (cases.hosts || []).map(reachHostname),
    verdicts: (cases.bodies || []).map(dohVerdict),
    steps: (cases.steps || []).map((c) => reachStep(c.state, c.verdicts, c.strikes)),
  }));
  process.exit(0);
}

// ---- claim-sweep ordering: own leases outrank new work ----------------------
// Split a ledger pass into leases THIS enclave already holds but is not
// locally serving (a previous life: an update reboot wipes local state while
// leases live on) vs everything else. Resumes must run FIRST, and while any
// own lease is still unresumed the sweep takes NO new work: the lease holder
// already paid for the slice, and a new claim admitted first can consume the
// very capacity the resume needs ("no free capacity") — observed live
// 2026-07-17: a fresh 49% GPU claim displaced an orphaned 49% tenant, which
// then sat dark on a live, still-billing lease. The hold is bounded by the
// lease itself (<= leaseSec): an unresumable lease lapses and re-queues.
function sweepPartition(ledger, enclaveId, nowMs, isLocallyServing) {
  const own = [], rest = [];
  for (const d of ledger) {
    const ours = Number(d.leaseUntil) * 1000 > nowMs && d.runner === enclaveId
      && !isLocallyServing(d.id);
    (ours ? own : rest).push(d);
  }
  return { own, rest };
}

// SWEEP_SELFTEST='{"enclaveId":"0x…","nowMs":…,"ledger":[…],"serving":["id",…]}'
// prints the partition's id lists as one JSON line and exits — same contract
// as the seams above (test/claim-sweep.test.mjs drives it).
if (process.env.SWEEP_SELFTEST) {
  const c = JSON.parse(process.env.SWEEP_SELFTEST);
  const serving = new Set(c.serving || []);
  const { own, rest } = sweepPartition(c.ledger || [], c.enclaveId, c.nowMs, (id) => serving.has(id));
  console.log(JSON.stringify({ own: own.map((d) => d.id), rest: rest.map((d) => d.id) }));
  process.exit(0);
}

// ---- resource model: EXACT RESOURCES -> TWO CALCULATED SHARES ---------------
// Apps specify EXACT resources on four axes: vramGb + gpuTflops of one GPU card
// (both 0 = CPU-only app) and memMb + cpuGflops of the node. CPU compute is
// measured in GFLOPS, not TFLOPS: a whole 16-vCPU node peaks around ONE
// TFLOPS (vs 989 for the card), so TFLOPS-grained CPU asks round to "all of
// it or nothing" - GFLOPS is the honest grain. From those the
// platform CALCULATES two normalized shares — the allocation/routing/billing
// unit — by dividing the app's spec by the server's spec, taking the LARGER of
// the memory- and compute-derived share per pool (both axes are occupied
// together, so the bigger one is what's really consumed), rounded UP to the
// whole-percent grain so a share is never worth less than what was asked for:
//   gpuShare (0..1) — max(vramGb / CARD_VRAM_GB, gpuTflops / CARD_TFLOPS).
//                     The MPS compute % and the VRAM cap both follow it.
//   cpuShare (0..1) — max(memMb / node RAM, cpuGflops / NODE_GFLOPS); the
//                     node's vCPUs come along; the wasm guest is capped at memMb.
// Invariant: a GPU app's CPU slice rides on the same node as its card, so
// gpuShare >= cpuShare whenever gpuShare > 0. The leftovers are a feature: a
// tenant taking a whole card + 10% of the node's RAM leaves 90% of the CPU/RAM,
// which GPU enclaves rent to CPU-only apps (CPU-only enclaves get first claim;
// see the claim loop). CC disables MIG, so a card is ONE trust domain sliced in
// SOFTWARE: isolation comes from the process boundary, not the slice size.
const CPU_RATE        = 0.000834;                                       // USDC/sec, the WHOLE node's vCPU+RAM ($3.00/hr)
const FULL_RATE       = 0.0016667;                                      // USDC/sec, a WHOLE card ($6.00/hr)
const GPU_COUNT       = parseInt(process.env.GPU_COUNT || "1", 10);     // cards in this enclave; 0 = CPU-only enclave
// GPU work (gpuShare > 0) runs ONLY on GPU-enabled enclaves. CPU-only work runs
// on CPU-only enclaves first, and on GPU enclaves out of leftover cpu pool.
const IS_GPU          = GPU_COUNT > 0;
const NODE_VCPUS      = parseInt(process.env.NODE_VCPUS || "16", 10);   // node size, for CPU pricing/readouts
const NODE_RAM_GB     = parseInt(process.env.NODE_RAM_GB || "64", 10);
const NODE_GFLOPS     = parseFloat(process.env.NODE_GFLOPS || "")       // CPU compute per node in GFLOPS (16 vCPU ≈ 1000)
                     || parseFloat(process.env.NODE_TFLOPS || "1") * 1000; // legacy env name (was TFLOPS-denominated)
let CARD_VRAM_GB      = parseFloat(process.env.GPU_VRAM_GB || "141");   // usable VRAM per card (fallback until the card itself is probed - see adoptCardVram)
let CARD_VRAM_SRC     = process.env.GPU_VRAM_GB ? "env" : "default";
const CARD_TFLOPS     = parseFloat(process.env.GPU_TFLOPS || "989");    // GPU compute per card (H200 FP16 dense)
const CTX_OVERHEAD_GB = parseFloat(process.env.CTX_OVERHEAD_GB || "0.5"); // per-worker context cost, reserved on top of the cap
const SM_TOTAL        = parseInt(process.env.SM_TOTAL || "132", 10);   // SMs per card (H200=132); for reporting granted SMs
const MIN_COMPUTE_PCT = parseInt(process.env.MIN_COMPUTE_PCT || "1", 10); // floor; CUDA_MPS_ACTIVE_THREAD_PERCENTAGE is an integer 1..100
const GRANULARITY_GB  = parseFloat(process.env.VRAM_GRANULARITY_GB || "1"); // request rounding; 1 GB ≈ arbitrary

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;
// compute is dialed by an INTEGER percent (the MPS cap grain) - quantize any
// requested share to whole percent, floored at MIN_COMPUTE_PCT. This is the true
// allocatable unit; there is no finer control and no 1/7 floor.
const quantizePct = (share) => Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.round(share * 100)));
// app specs -> MINIMUM shares: divide the app's exact spec by THIS server's
// spec, take the LARGER of the memory- and compute-derived share per pool,
// round UP to the percent grain — the minimum share is never worth less than
// the resources the app declared it needs.
const pctCeil = (x) => Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.ceil(x * 100 - 1e-9)));
const gpuShareOf = (vramGb, gpuTflops = 0) => (vramGb > 0 || gpuTflops > 0)
  ? pctCeil(Math.max(vramGb / CARD_VRAM_GB, gpuTflops / CARD_TFLOPS)) / 100 : 0;
const cpuShareOf = (memMb, cpuGflops = 0) =>
  pctCeil(Math.max(memMb / (NODE_RAM_GB * 1024), cpuGflops / NODE_GFLOPS)) / 100;
// An app's catalog specs -> the minimum shares a deployment must buy here.
// Zero-guarded: axes the app didn't declare add no minimum. A GPU app's CPU
// minimum also lifts its GPU minimum, or the gpuShare >= cpuShare invariant
// could never be satisfied at the floor.
function minSharesOf(min) {
  const cpu = (min.memMb || min.cpuGflops) ? cpuShareOf(min.memMb || 0, min.cpuGflops || 0) : 0;
  const gpu0 = (min.vramMb || min.gpuGflops) ? gpuShareOf((min.vramMb || 0) / 1024, (min.gpuGflops || 0) / 1000) : 0;
  return { gpuShare: gpu0 > 0 ? Math.max(gpu0, cpu) : 0, cpuShare: cpu };
}

// per-card free pools (vram + compute). With CC on there is exactly one whole
// device per card - no MIG instances to enumerate.
const gpuCards = Array.from({ length: GPU_COUNT }, (_, i) => ({ id: i, uuid: null, vramFree: CARD_VRAM_GB, computeFree: 1 }));

// The card outranks config: GPU_VRAM_GB is only the boot fallback. The real
// memory.total arrives from whichever probe can reach the card - our own
// nvidia-smi discovery where this process can see the GPU, or the manager's
// boot probe via /health on Tinfoil (the supervisor container has neither).
// Rebase the free pools by the delta so reservations made before adoption
// (loadState restores, early claims) stay accounted.
function adoptCardVram(gb, source) {
  if (!IS_GPU || !(gb > 0)) return;
  if (Math.abs(gb - CARD_VRAM_GB) < 0.05) { CARD_VRAM_SRC = source; return; }
  const delta = gb - CARD_VRAM_GB;
  for (const c of gpuCards) {
    c.vramFree += delta;
    if (c.vramFree < 0) {
      console.warn(`[gpu] card ${c.id}: live reservations exceed probed ${gb} GB by ${(-c.vramFree).toFixed(1)} GB - clamping (frees as tenants release)`);
      c.vramFree = 0;
    }
  }
  console.log(`[gpu] card VRAM ${CARD_VRAM_GB} GB (${CARD_VRAM_SRC}) -> ${gb} GB (${source})`);
  CARD_VRAM_GB = gb; CARD_VRAM_SRC = source;
}

// The node's vCPU+RAM pool — EVERY enclave has one. On a CPU-only enclave it is
// the only pool; on a GPU enclave every GPU deployment's cpuShare draws from it
// too, and whatever is left over is rentable by CPU-only apps. The wasm-manager
// admits by the same share, so the two allocators agree. A CPU-only handle
// lives in rec._gpu as { cpu: true, share } so every reserve/release/persist
// call site is shared with the GPU path.
const cpuPool = { shareFree: 1 };
function allocCpu(share) {
  if (cpuPool.shareFree < share - 1e-9) return null;
  cpuPool.shareFree -= share;
  return { cpu: true, share };
}
const maxFreeCpu = () => Math.max(0, Math.min(1, cpuPool.shareFree));
// CPU requests use the same whole-percent grain as GPU compute; priced at the
// share of the whole-node rate.
const normalizeCpuReq = (share) => { const pct = quantizePct(share); return { cpu: true, gpuShare: 0, cpuShare: pct / 100, share: pct / 100, pct }; };

// price = both shares, additively: the GPU slice at the whole-card rate plus
// the CPU slice at the whole-node rate (mirrors EnclaveDeployments' rate formula).
const rateFor = (gpuShare, cpuShare) => FULL_RATE * gpuShare + CPU_RATE * cpuShare;
// normalize a GPU request: quantize both shares to the integer-percent grain
// (the MPS cap grain — the true allocatable unit), clamp cpuShare to the
// invariant cpuShare <= gpuShare, and derive the VRAM cap from the GPU share
// (rounded UP to granularity — the tenant gets the round-up for free).
function normalizeGpuReq(gpuShare, cpuShare) {
  const gpct = quantizePct(gpuShare);
  const cpct = Math.min(quantizePct(cpuShare), gpct);
  const v = Math.ceil((gpct / 100) * CARD_VRAM_GB / GRANULARITY_GB) * GRANULARITY_GB;
  return { gpuShare: gpct / 100, cpuShare: cpct / 100, vramGb: v,
           computeShare: gpct / 100, computePct: gpct };
}
// reserve an arbitrary slice on a single card (best-fit on VRAM) PLUS the
// deployment's cpuShare from the node pool — both or neither. VRAM overhead is
// reserved on top of the cap so the sum of live workers never exceeds physical.
function allocGpu(vramGb, computeShare, cpuShare) {
  const needV = vramGb + CTX_OVERHEAD_GB;
  if (cpuPool.shareFree < cpuShare - 1e-9) return null;
  const fit = gpuCards
    .filter(c => c.vramFree >= needV - 1e-9 && c.computeFree >= computeShare - 1e-9)
    .sort((a, b) => (a.vramFree - needV) - (b.vramFree - needV));
  const card = fit[0];
  if (!card) return null;
  card.vramFree -= needV; card.computeFree -= computeShare;
  cpuPool.shareFree -= cpuShare;
  return { cardId: card.id, vramGb, computeShare, cpuShare, _needV: needV };
}
function releaseGpu(h) {
  if (!h) return;
  if (h.cpu) { cpuPool.shareFree = Math.min(1, cpuPool.shareFree + h.share); return; }
  cpuPool.shareFree = Math.min(1, cpuPool.shareFree + (h.cpuShare || 0));
  const card = gpuCards[h.cardId]; if (!card) return;
  card.vramFree = Math.min(CARD_VRAM_GB, card.vramFree + h._needV);
  card.computeFree = Math.min(1, card.computeFree + h.computeShare);
}
// largest slice a single card can still take (VRAM net of overhead; compute share)
const maxFreeVram    = () => Math.max(0, ...gpuCards.map(c => c.vramFree - CTX_OVERHEAD_GB));
const maxFreeCompute = () => Math.max(0, ...gpuCards.map(c => c.computeFree));
// largest GPU share a single card can still take (vram + compute must fit together)
const maxFreeGpuShare = () => !IS_GPU ? 0 : Math.max(0, ...gpuCards.map(c =>
  Math.min(c.computeFree, (c.vramFree - CTX_OVERHEAD_GB) / CARD_VRAM_GB)));

const _applyGpu = (text) => {
  let got = 0; const totals = [];
  for (const line of text.trim().split("\n")) {
    const [idx, uuid, memMiB] = line.split(",").map(s => s.trim());
    const i = parseInt(idx, 10);
    if (gpuCards[i] && /^GPU-/.test(uuid || "")) {
      gpuCards[i].uuid = uuid; got++;
      const totalGb = parseFloat(memMiB) / 1024;
      if (totalGb > 0) { totals.push(totalGb); console.log(`[gpu] card ${i} ${uuid} (${totalGb.toFixed(0)}GB)`); }
    }
  }
  if (totals.length) adoptCardVram(round1(Math.min(...totals)), "nvidia-smi");
  return got;
};
const GPU_QUERY = ["nvidia-smi", "--query-gpu=index,uuid,memory.total", "--format=csv,noheader,nounits"];

// Discover card UUIDs (so GPU shares can be pinned) via local nvidia-smi when
// this process can see the card. The supervisor container has no nvidia-smi and
// the card lives in the worker/wasm-manager container, so on the CVM this is a
// best-effort no-op — card VRAM/UUIDs arrive from the manager's /health probe.
async function discoverGpus() {
  if (/^(1|true|on)$/i.test(process.env.MOCK_SPAWN || "")) return 0;
  try { const { stdout } = await pexec("nvidia-smi", GPU_QUERY.slice(1), { timeout: 8000 });
        return _applyGpu(stdout); } catch { return 0; }
}

// Lazily ensure UUIDs are known before a GPU spawn - covers a boot where the
// card wasn't visible to nvidia-smi yet (discovery re-runs on first spawn).
let _gpuDiscovering = null;
async function ensureGpuUuids() {
  if (gpuCards.every(c => c.uuid)) return true;
  if (!_gpuDiscovering) _gpuDiscovering = discoverGpus()
    .finally(() => { _gpuDiscovering = null; });
  await _gpuDiscovering;
  return gpuCards.some(c => c.uuid);
}

async function initGpu() {
  // Best-effort at boot; if nvidia-smi can't see the card here, card VRAM/UUIDs
  // arrive from the manager's /health probe and ensureGpuUuids() retries on the
  // first spawn. Never blocks boot.
  const got = await discoverGpus();
  if (got < GPU_COUNT) console.warn(`[gpu] boot discovery ${got}/${GPU_COUNT} - will retry on first spawn`);
}

async function initMps() {
  // Start the MPS control daemon ONCE at boot. Workers join it as clients (sharing
  // MPS_PIPE_DIR) and the driver enforces, per client, BOTH the SM cap
  // (CUDA_MPS_ACTIVE_THREAD_PERCENTAGE) and the VRAM cap (CUDA_MPS_PINNED_DEVICE_MEM_LIMIT)
  // - confirmed enforced under CC via %smid. Without MPS, compute-share is unenforced
  // and we fall back to admission control + watchdog (workers still run).
  if (!ENABLE_MPS) { console.warn("[mps] disabled by env - compute-share will NOT be enforced"); return; }
  try {
    execFileSync("mkdir", ["-p", MPS_PIPE_DIR]);
    // already running? control daemon answers on the pipe dir.
    try { execFileSync("nvidia-cuda-mps-control", ["get_server_list"],
            { env: { ...process.env, CUDA_MPS_PIPE_DIRECTORY: MPS_PIPE_DIR }, stdio: "ignore" });
          console.log("[mps] daemon already running"); return; } catch {}
    execFileSync("nvidia-cuda-mps-control", ["-d"],
      { env: { ...process.env, CUDA_MPS_PIPE_DIRECTORY: MPS_PIPE_DIR } });
    console.log(`[mps] control daemon started (pipe ${MPS_PIPE_DIR})`);
  } catch (e) {
    console.warn("[mps] could not start daemon - compute caps unenforced:", e.message);
  }
}

// Public RPCs rate-limit per IP and the claim loop's bursts run into it
// (observed live 2026-07-05: "over rate limit" from mainnet.base.org killed
// whole claim passes). Longer exponential retry absorbs a burst cap; the
// per-tick call budget is kept low by deriving post-tx state from receipts.
const chainClient = createPublicClient({ chain: base, transport: viemHttp(BASE_RPC, { retryCount: 5, retryDelay: 500 }) });

// ----------------------------------------------------------------------------
// state (in-process; this service is the single enclave instance)
// ----------------------------------------------------------------------------
const nonces     = new Map(); // nonce -> { address, exp }
const NONCE_MAX  = parseInt(process.env.NONCE_MAX || "10000", 10);   // hard cap (LRU/FIFO evict) alongside the TTL sweep, so a flood of /v1/auth/nonce can't grow this map unbounded between sweeps
const deployments = new Map(); // id -> record (incl. local container handle)
setInterval(() => { const t = Date.now(); for (const [n,v] of nonces) if (v.exp < t) nonces.delete(n); }, 60_000).unref?.();
const rid = (p) => p + Math.random().toString(36).slice(2, 10);
// Constant-time string compare for secret/token checks (guards length first, as
// timingSafeEqual throws on unequal-length buffers).
function safeEqStr(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8"), bb = Buffer.from(String(b ?? ""), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---- state persistence (fair billing across restarts) -----------------------
// Everything billing-critical (deployments, payment cursor, dedup set) is written
// to STATE_FILE so a supervisor restart FREEZES clocks instead of forfeiting them:
// on boot the downtime gap is measured via savedAt and never charged, unpaid
// reservation windows shift by the gap, and the payment watcher resumes scanning
// from the block it last finished - payments made during the outage are credited.
// Without a writable STATE_FILE this degrades to freezing within one process only.
let _stateDirty = false, _statePersistable = true;
function serializeState() {
  const recs = [...deployments.values()].map(r => {
    const o = { ...r };
    for (const k of ["_payTimer", "_respawning", "_renewing"]) delete o[k];   // live handles only
    return o;
  });
  return JSON.stringify({
    savedAt: Date.now(),
    payFromBlock: _payFromBlock == null ? null : _payFromBlock.toString(),
    seenLogs: [..._seenLogs].map(([k, b]) => [k, b.toString()]),
    deployments: recs,
  });
}
function saveStateNow() {
  if (!_statePersistable) return;
  try {
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, serializeState());
    renameSync(tmp, STATE_FILE);                 // atomic: a crash never leaves a torn file
    _stateDirty = false;
  } catch (e) { console.warn(`[state] save failed: ${e.message}`); }
}
function saveStateSoon() { _stateDirty = true; }
function initStatePersistence() {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); }
  catch (e) {
    _statePersistable = false;
    console.warn(`[state] ${STATE_FILE} unavailable (${e.message}) - clocks freeze only within this process`);
    return;
  }
  const t = setInterval(() => { if (_stateDirty) saveStateNow(); }, 2000);
  if (t.unref) t.unref();
  // flush on shutdown so savedAt marks the true start of the outage. On-chain
  // leases are released first (bounded wait): a clean shutdown refunds the
  // unused lease tail and reopens the queue immediately; instant no-op when
  // this enclave holds no claims.
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
    saveStateNow();
    releaseClaimsOnShutdown().finally(() => process.exit(0));
  });
}
function loadState() {
  if (!_statePersistable || !existsSync(STATE_FILE)) return;
  let s; try { s = JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch (e) { console.warn(`[state] unreadable (${e.message}) - starting fresh`); return; }
  const gapMs = Math.max(0, Date.now() - (s.savedAt || Date.now()));
  if (s.payFromBlock != null) _payFromBlock = BigInt(s.payFromBlock);   // watcher resumes where it stopped
  for (const [k, b] of s.seenLogs || []) _seenLogs.set(k, BigInt(b));
  let running = 0, waiting = 0;
  for (const r of s.deployments || []) {
    r._payTimer = null; r._respawning = false;
    // legacy terminal status: "stopping" was set AFTER teardown completed and
    // nothing ever finalized it, so restored records sat "stopping" forever
    if (r.status === "stopping") r.status = "terminated";
    deployments.set(r.id, r);
    if (r.payRef) payRefIndex.set(r.payRef.toLowerCase(), r.id);
    if (r._gpu) {                       // re-reserve the slices this deployment still holds
      if (r._gpu.cpu) cpuPool.shareFree = Math.max(0, cpuPool.shareFree - r._gpu.share);
      else {
        cpuPool.shareFree = Math.max(0, cpuPool.shareFree - (r._gpu.cpuShare || 0));
        const card = gpuCards[r._gpu.cardId];
        if (card) { card.vramFree -= r._gpu._needV; card.computeFree -= r._gpu.computeShare; }
      }
    }
    if (r.status === "running") {
      // FREEZE the outage: the gap between savedAt and now is never charged. The
      // first healthy tick verifies the instance (respawning it if the backend
      // lost it) and resumes the clock.
      r._lastTickAt = Date.now();
      r.paused = true; r.pauseReason = "restart_recovery";
      r._respawnAt = 0; r._respawnBackoffMs = 0;
      running++;
    } else if (r.status === "awaiting_payment") {
      r.payDeadline = (r.payDeadline || Date.now()) + gapMs;   // reservation window frozen too
      armPayTimer(r);
      waiting++;
    }
  }
  if (deployments.size) console.log(`[state] restored ${deployments.size} deployment(s) `
    + `(${running} running, ${waiting} awaiting payment) after ${Math.round(gapMs / 1000)}s down; clocks were frozen`);
}

// ============================================================================
// >>> IMPLEMENT THESE for your CVM launch mechanism (e.g. the app manager on
//     VMMGR_URL). Contract: one ingress port, no sibling reach.
//     Tinfoil exposes no guest RTMR-extend, so a launched image's digest cannot
//     be folded into the hardware measurements; /attestation reports exactly
//     that (per-app `coverage` in getMeasurements) instead of implying it.
// ============================================================================
// ============================================================================
// WORKER LAUNCH - one container per tenant. The process boundary is the ONLY
// thing giving memory isolation + fault containment + VRAM scrub-on-exit at once
// (all empirically confirmed). Compute + VRAM are capped by MPS, also confirmed
// enforced under CC. Never co-locate two tenants in one process.
//   Image digests are NOT RTMR-extended (no guest extend interface) - the
//   attestation endpoint reports that coverage gap explicitly, never fakes it.
// ============================================================================
// resolve the pinned image ref: prefer name@sha256:digest when a digest is given
function pinnedRef(image) {
  const ref = (image?.reference || DEFAULT_IMAGE).trim();
  const dig = (image?.digest || "").trim();
  if (ref.includes("@")) return ref;                              // already digest-pinned
  if (/^sha256:[0-9a-f]{64}$/i.test(dig)) return `${ref.replace(/:[^/:]+$/, "")}@${dig}`;
  return ref;                                                     // tag-only (pin verification is the attestation step)
}
function toBytes(s) {
  const m = /^(\d+)\s*([gmk]?)b?$/i.exec(String(s).trim());
  if (!m) return 0;
  const n = +m[1], u = m[2].toLowerCase();
  return u === "g" ? n*1073741824 : u === "m" ? n*1048576 : u === "k" ? n*1024 : n;
}
async function spawnContainer({ deploymentId, gpuShare, cpuShare, image, appPort, ports, config }) {
  // Two backends. "vm": hand the app reference to the app manager on VMMGR_URL
  // (the wasm-manager runs it as a `wasmtime serve` process; cpuShare is its
  // admission unit and sets the guest memory cap — cpuShare × node RAM;
  // gpuShare buys the wasi-nn GPU interface: the manager launches the tenant
  // with `-S nn` and MPS-caps its process at gpuShare SM% / gpuShare × VRAM.
  // The compute the shares grant is passed too - GPU in TFLOPS, CPU in
  // GFLOPS - so the manager can enforce catalog compute minimums).
  // "worker": fork an MPS-capped CUDA child PROCESS (GPU PTX submission);
  // gpuShare sets the MPS cap.
  if (/^(1|true|on)$/i.test(process.env.MOCK_SPAWN || "")) {
    console.log(`[mock] ${PROVISION_BACKEND} tenant ${deploymentId}`);
    return { internalPort: 0 };
  }

  if (PROVISION_BACKEND === "vm") {
    const ref = image && image.reference;
    if (!ref) throw new Error("VM backend requires an image reference.");
    const c = (cpuShare != null) ? cpuShare : 0.05, g = gpuShare || 0;
    const r = await vmReq("POST", "/vms",
      { image: ref, cpuShare: c, gpuShare: g,
        gpuTflops: round1(g * CARD_TFLOPS), cpuGflops: Math.round(c * NODE_GFLOPS),
        // cpuTflops: legacy field for managers pinned before the GFLOPS switch
        cpuTflops: round3(c * NODE_GFLOPS / 1000),
        appPort: appPort || 8080, name: deploymentId, ports: ports || [],
        // the approved version's config JSON, verbatim from the catalog record
        // (already validated by the publish path; the manager re-parses and
        // passes it to the tenant as ENCLAVE_CONFIG; empty = app defaults)
        config: config || "",
        // dedicated-IP egress: a per-deployment SOCKS URL the manager forwards
        // verbatim as the guest's ENCLAVE_EGRESS (empty when egress is off). The
        // token in it is minted from the enclave SECRET, so the manager never
        // needs the secret and the value never touches a log line.
        egress: egress ? egress.envFor(deploymentId) : "" }, SPAWN_TIMEOUT_MS);
    if (r.status !== 201)
      throw new Error(`vmmanager: ${r.body.error || r.body.message || r.status}`);
    console.log(`[spawn-vm] ${deploymentId} image=${ref} cpuShare=${c} gpuShare=${g} `
              + `vm=${r.body.id} hostPort=${r.body.hostPort} status=${r.body.status}`);
    // The VM boots asynchronously; the data path 502s until its server is up.
    // status carries the manager's state.
    return { internalPort: r.body.hostPort || 0, vmId: r.body.id, hostPort: r.body.hostPort,
             portMap: r.body.portMap || {}, status: r.body.status };   // logical "tcp:5432" -> actual loopback bind
  }

  // worker backend (GPU)
  if (!(gpuShare > 0)) throw new Error("The worker backend serves GPU deployments only (gpuShare > 0 required).");
  const g = Math.min(1, Math.max(MIN_COMPUTE_PCT / 100, gpuShare));
  const r = await mgrReq("POST", "/tenants", { id: deploymentId, gpuShare: g }, SPAWN_TIMEOUT_MS);
  if (r.status !== 201 || r.body.status !== "running")
    throw new Error(`worker manager: ${r.body.error || r.body.status || r.status} `
                  + `(sm_granted=${r.body.sm_granted ?? "?"})`);
  console.log(`[spawn] tenant=${deploymentId} gpuShare=${g.toFixed(3)} `
            + `sm_granted=${r.body.sm_granted} device=${r.body.device}`);
  return { internalPort: 0, smGranted: r.body.sm_granted };
}

async function stopContainer(rec) {
  if (PROVISION_BACKEND === "vm") {
    if (rec._vmId)
      await vmReq("DELETE", `/vms/${encodeURIComponent(rec._vmId)}`)
        .catch((e) => console.warn(`[stop-vm] ${rec.id}: ${e.message}`));
    return;
  }
  // Tear down the tenant's MPS-capped child. The manager terminates the process,
  // which returns its context/VRAM to the driver and releases the share. NOTE:
  // freed VRAM is not zeroed here - residual-data scrubbing is Layer 4.
  await mgrReq("DELETE", `/tenants/${encodeURIComponent(rec.id)}`)
    .catch((e) => console.warn(`[stop] ${rec.id}: ${e.message}`));
}
// What app ran, as an attestation-visible identity. For ipfs://<cid> the CID IS a
// content hash the (attested) wasm-manager verified the bytes against before running,
// so reporting it here is honest: "the enclave ran exactly this CID."
function appMeasurement(rec) {
  const ref = (rec.image && rec.image.reference) || null;
  const m = /^ipfs:\/\/([^/?#]+)/.exec(ref || "");
  return m ? { kind: "ipfs", reference: ref, cid: m[1], verifiedAgainstCid: true,
               coverage: "Bytes were verified against this CID inside the enclave by the attested "
                       + "wasm-manager before launch. The CID itself is NOT in a hardware register." }
           : { kind: "catalog", reference: ref,
               coverage: "Baked into the attested enclave image, so it is covered by the enclave "
                       + "measurement registers below." };
}
// ---- REAL ATTESTATION -------------------------------------------------------
// The Tinfoil shim generates the enclave TLS key, obtains a CPU attestation
// report (AMD SEV-SNP on today's fleet; Intel TDX flows through the same path)
// whose report_data[0:32] = sha256(TLS pubkey, SPKI DER), and serves the signed
// Remote Attestation Document at /.well-known/tinfoil-attestation. We RELAY that
// document verbatim and PARSE the quote so the registers are inspectable - but
// we never assert trust on the client's behalf: the party being verified cannot
// vouch for itself. What we DO publish is verification.selfCheck - this enclave
// running the same five checks a client would (via @tinfoilsh/verifier) and
// reporting the outcome as a clearly-labeled diagnostic, so a healthy deployment
// reads as a wall of passes instead of a bare "verified: false". Clients
// reproduce it with tinfoil-cli / @tinfoilsh/verifier against the Sigstore-
// signed measurements on ENCLAVE_REPO's releases, over their OWN connection.
const RAD_PATH        = "/.well-known/tinfoil-attestation";
const ATTESTATION_URL = process.env.ATTESTATION_URL || "";                 // explicit RAD URL override
const RAD_CACHE_MS    = parseInt(process.env.RAD_CACHE_MS || "300000", 10); // convenience-copy staleness bound
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");

// GET url, tolerate the shim's cert (the RAD is SELF-verifying: the quote binds
// the TLS key, so transport trust adds nothing), and capture the peer key so we
// can report the fingerprint exactly as Tinfoil's verifier computes it.
function fetchRad(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request(u,
      { method: "GET", timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        // grab the peer key NOW - the socket detaches from res once the body ends
        let liveTlsKeyFP = null;
        try { const x = res.socket.getPeerX509Certificate?.();
              if (x) liveTlsKeyFP = sha256Hex(x.publicKey.export({ type: "spki", format: "der" })); } catch {}
        let buf = ""; res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`${u.host}${u.pathname}: HTTP ${res.statusCode}`));
          let doc; try { doc = JSON.parse(buf); } catch { return reject(new Error(`${u.host}: not JSON`)); }
          if (typeof doc.format !== "string" || typeof doc.body !== "string")
            return reject(new Error(`${u.host}: not a Tinfoil attestation document`));
          resolve({ doc, liveTlsKeyFP, url });
        });
      });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`${u.host}: timeout`)));
    req.end();
  });
}
let _radCache = null;                 // { doc, liveTlsKeyFP, url, at }
let _radInflight = null;
async function fetchEnclaveRad(origin) {
  if (_radCache && Date.now() - _radCache.at < RAD_CACHE_MS) return _radCache;
  if (_radInflight) return _radInflight;
  // The shim terminates TLS inside this CVM, so loopback is the trusted source.
  // We deliberately DO NOT fall back to the public origin (origin + RAD_PATH): that
  // hairpin leaves the CVM and re-enters through the untrusted ingress with
  // rejectUnauthorized off, so a MITM on that path could answer it. Loopback (the
  // shim, in-CVM) is ALWAYS available here, so there is genuinely no case with "no
  // loopback option" — we fail closed rather than trust the hairpin. ATTESTATION_URL
  // remains the explicit override for a shim that binds elsewhere.
  void origin;
  const candidates = ATTESTATION_URL ? [ATTESTATION_URL]
    : ["https://127.0.0.1" + RAD_PATH, "http://127.0.0.1" + RAD_PATH];
  _radInflight = (async () => {
    let lastErr = null;
    for (const url of candidates) {
      try { const r = await fetchRad(url); _radCache = { ...r, at: Date.now() }; return _radCache; }
      catch (e) { lastErr = e; }
    }
    throw new Error(`attestation document unreachable (${lastErr?.message || "no candidates"})`);
  })();
  try { return await _radInflight; } finally { _radInflight = null; }
}

// Parse a raw Intel TDX quote (DCAP QuoteV4/V5, in case a CVM lands on TDX
// hardware). Offsets are the fixed TD-report layout; report_data is what binds
// the TLS key. Returns null on anything odd -
// the verbatim document is still returned, clients parse it themselves anyway.
function parseTdxQuote(q) {
  try {
    if (q.length < 48 + 584) return null;
    const version = q.readUInt16LE(0), teeType = q.readUInt32LE(4);
    if (teeType !== 0x81) return null;                                  // TDX
    let body;
    if (version === 4) body = q.subarray(48, 48 + 584);
    else if (version === 5) {
      const bodyType = q.readUInt16LE(48);
      if (bodyType !== 2 && bodyType !== 3) return null;                // TD 1.0 / 1.5
      body = q.subarray(54);
    } else return null;
    if (body.length < 584) return null;
    const hx = (o, n) => body.subarray(o, o + n).toString("hex");
    return { quoteVersion: version,
             mrSeam: hx(16, 48), mrTd: hx(136, 48),
             rtmr0: hx(328, 48), rtmr1: hx(376, 48), rtmr2: hx(424, 48), rtmr3: hx(472, 48),
             reportData: hx(520, 64) };
  } catch { return null; }
}
// AMD SEV-SNP report (today's fleet): fixed offsets too.
function parseSnpReport(r) {
  try {
    if (r.length < 0x90 + 48) return null;
    return { measurement: r.subarray(0x90, 0x90 + 48).toString("hex"),
             reportData:  r.subarray(0x50, 0x50 + 64).toString("hex") };
  } catch { return null; }
}
function parseRad(doc) {
  let raw = Buffer.from(doc.body, "base64");
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);         // predicate v2 bodies are gzipped
  const fmt = doc.format || "";
  if (fmt.includes("tdx-guest")) {
    const p = parseTdxQuote(raw);
    return { technology: "intel-tdx", quote: raw.toString("base64"),
             measurements: p && { mrTd: p.mrTd, rtmr0: p.rtmr0, rtmr1: p.rtmr1, rtmr2: p.rtmr2, rtmr3: p.rtmr3 },
             reportData: p?.reportData ?? null, quoteVersion: p?.quoteVersion };
  }
  if (fmt.includes("sev-snp-guest")) {
    const p = parseSnpReport(raw);
    return { technology: "amd-sev-snp", quote: raw.toString("base64"),
             measurements: p && { measurement: p.measurement }, reportData: p?.reportData ?? null };
  }
  return { technology: fmt, quote: raw.toString("base64"), measurements: null, reportData: null };
}

// The CPU-TEE technology as DETECTED from this enclave's own attestation
// document - never asserted from config or hardcoded (the fleet has moved
// silicon before, and a hardcoded value in every deployment record is exactly
// the kind of unverifiable claim this platform exists to avoid). null until
// the first RAD fetch lands; a miss kicks a background fetch so the next
// caller reads the real answer.
let _vmTech = null;
function vmTech() {
  if (_vmTech) return _vmTech;
  if (_radCache?.doc) {
    try { _vmTech = parseRad(_radCache.doc).technology || null; } catch {}
  } else fetchEnclaveRad().catch(() => {});
  return _vmTech;
}

// GPU evidence comes from the worker manager (the container that holds the card):
// NVML's conf-compute attestation report, signed by the GPU, over OUR nonce.
async function fetchGpuEvidence(nonceHex, timeoutMs = 30000) {
  const r = await mgrReq("GET", `/attestation?nonce=${nonceHex}`, null, timeoutMs);
  if (r.status !== 200 || r.body.available === false)
    throw new Error(r.body.error || `worker manager /attestation ${r.status}`);
  return r.body;
}

// ---- SELF-CHECK (diagnostic, not trust) --------------------------------------
// The enclave runs the exact five-step client verification against ITSELF
// (@tinfoilsh/verifier: SNP report -> AMD root, Sigstore release provenance,
// measurement comparison, cert binding) and reports the outcome. Labeled a
// self-check because self-vouching carries no trust - its value is (a) honest
// green-by-default optics and (b) catching config drift (wrong repo casing,
// stale release, broken egress) before a customer's verifier does. Fetches its
// own PUBLIC origin (hairpin) plus Tinfoil's GitHub/KDS proxies; if any of that
// is unreachable from inside, it degrades to "unavailable", never an error.
const SELF_CHECK_TTL_MS  = parseInt(process.env.SELF_CHECK_TTL_MS || "300000", 10); // re-check cadence after a pass (non-pass retries after 30s)
const SELF_CHECK_WAIT_MS = parseInt(process.env.SELF_CHECK_WAIT_MS || "8000", 10);  // max time one request waits on a fresh run
const SELF_CHECK_NOTE = "Run by the enclave itself as a diagnostic: it proves this deployment is configured "
                      + "to verify, not that you should trust it. Reproduce it on your side with `cli`, `npm`, "
                      + "or `browser` - trust ends at YOUR verifier, never at this field.";
// Flavor-aware verification. The stock Verifier compares an enclave against the
// repo's single "latest" GitHub release, which carries our GPU flavor — a CPU
// (or gpu8) enclave measures differently and would always fail
// compareMeasurements. So: fast-path latest, and ONLY on a mismatch probe the
// same version's sibling-flavor tags (vX.Y.Z-cpu / -gpu8), verifying against
// whichever release the enclave's own measurement matches. Security is
// unchanged — every candidate's provenance is still Sigstore-verified inside
// verifyBundle; we only widen WHICH signed release is the reference. The
// github-proxy the enclave reaches whitelists only /releases/latest,
// /releases/download/<tag>/tinfoil.hash and /attestations/<digest>, so we probe
// known tags rather than enumerate releases. Mirrored in site/js/core/verify.js.
const GITHUB_PROXY = "https://github-proxy.tinfoil.sh";
async function verifyMatchingRelease(host, repo) {
  const base = await assembleAttestationBundle(host, repo);   // enclave attestation + latest's digest/sigstore
  const attempt = async (digest, sigstoreBundle) => {
    const v = new Verifier({ configRepo: repo });
    try { await v.verifyBundle({ ...base, digest, sigstoreBundle }); } catch { /* step failure recorded on the doc */ }
    return v.getVerificationDocument();
  };
  const latest = await attempt(base.digest, base.sigstoreBundle);
  if (latest?.securityVerified) return latest;                // the common case: this node runs the latest (GPU) release
  let latestTag;
  try { latestTag = (await (await fetch(`${GITHUB_PROXY}/repos/${repo}/releases/latest`)).json())?.tag_name; } catch { /* offline */ }
  for (const suffix of (latestTag ? ["-cpu", "-gpu8"] : [])) {
    const tag = latestTag + suffix;
    let digest, sigstoreBundle;
    try {
      const hr = await fetch(`${GITHUB_PROXY}/${repo}/releases/download/${tag}/tinfoil.hash`);
      if (!hr.ok) continue;
      digest = (await hr.text()).trim();
      sigstoreBundle = (await (await fetch(`${GITHUB_PROXY}/repos/${repo}/attestations/sha256:${digest}`)).json())?.attestations?.[0]?.bundle;
    } catch { continue; }
    if (!digest || !sigstoreBundle) continue;
    const doc = await attempt(digest, sigstoreBundle);
    if (doc?.securityVerified) return doc;                    // matched this flavor's signed release
  }
  return latest;   // nothing matched: the latest-comparison doc carries the mismatch detail
}

let _selfCheck = null;                  // { data, at }
let _selfCheckRun = null;               // in-flight run (shared across concurrent requests)
async function runSelfCheck(origin) {
  if (!ENCLAVE_REPO) return { result: "unavailable", error: "ENCLAVE_REPO not configured" };
  if (!origin)       return { result: "unavailable", error: "public origin not known yet (no external request seen)" };
  let doc, failure = null;
  try { doc = await verifyMatchingRelease(new URL(origin).hostname, ENCLAVE_REPO); }
  catch (e) { failure = e; }
  if (!doc) return { result: "unavailable", error: failure?.message || "verifier produced no document" };
  const word = (s) => !s || s.status === "pending" ? "skipped" : s.status === "success" ? "pass" : "fail";
  const steps = {};
  for (const k of ["fetchDigest", "verifyEnclave", "verifyCode", "compareMeasurements", "verifyCertificate"]) {
    steps[k] = word(doc.steps?.[k]);
    if (doc.steps?.[k]?.error) steps[k] += `: ${doc.steps[k].error}`;
  }
  return { result: doc.securityVerified ? "pass" : "fail",
           ...(failure ? { error: failure.message } : {}),
           steps,
           release: doc.releaseDigest ? `sha256:${doc.releaseDigest}` : null,
           measurement: doc.enclaveFingerprint || null };
}
async function getSelfCheck(origin) {
  const ttl = _selfCheck?.data?.result === "pass" ? SELF_CHECK_TTL_MS : Math.min(SELF_CHECK_TTL_MS, 30_000);
  if (_selfCheck && Date.now() - _selfCheck.at < ttl) return _selfCheck.data;
  if (!_selfCheckRun)
    _selfCheckRun = runSelfCheck(origin)
      .catch((e) => ({ result: "unavailable", error: e.message }))
      .then((r) => { const data = { result: r.result, ...r, checkedAt: new Date().toISOString(), note: SELF_CHECK_NOTE };
                     _selfCheck = { data, at: Date.now() }; _selfCheckRun = null; return data; });
  // don't hold the attestation response hostage to a slow first run
  const done = await Promise.race([_selfCheckRun,
    new Promise((res) => setTimeout(res, SELF_CHECK_WAIT_MS).unref())]);
  return done || { result: "pending",
                   detail: "self-check still running - request this endpoint again in a few seconds",
                   note: SELF_CHECK_NOTE };
}

async function getMeasurements(rec, { origin = PUBLIC_URL, nonce } = {}) {
  let enclaveHost = null; try { enclaveHost = origin ? new URL(origin).host : null; } catch {}
  const out = {
    // No server-asserted "verified" boolean: the machine being verified cannot
    // vouch for itself, and a hardcoded `false` reads like an outage. Instead,
    // selfCheck reports this enclave running the same checks a client would
    // (labeled diagnostic), and the pointers beside it reproduce the result
    // client-side in seconds - where it actually carries trust.
    verification: {
      selfCheck: await getSelfCheck(origin),
      how: "Fetch " + RAD_PATH + " from this origin over your OWN TLS connection, verify the quote "
         + "against the Intel/AMD root of trust, compare the registers to the Sigstore-signed "
         + "measurements on the release page of `repo` (exact casing - Sigstore compares it verbatim), "
         + "and check that reportData[0:32] equals sha256 of the TLS public key (SPKI DER) your "
         + "connection presents. Tinfoil's verifier does all of this for you:",
      cli: enclaveHost && ENCLAVE_REPO
         ? `tinfoil attestation verify -e ${enclaveHost} -r ${ENCLAVE_REPO}` : null,  // github.com/tinfoilsh/tinfoil-cli
      npm: "@tinfoilsh/verifier",  // Node + browsers: await new Verifier({ serverURL, configRepo: repo }).verify()
      browser: "https://enclave.host/#attest",
      repo: ENCLAVE_REPO || null,
      attestationEndpoint: (origin || "") + RAD_PATH,
    },
    tlsKeyFingerprint: null,
    app: rec ? appMeasurement(rec) : null,
    vm: null,
    gpu: null,
  };
  try {
    const { doc, liveTlsKeyFP, url } = await fetchEnclaveRad(origin);
    const parsed = parseRad(doc);
    const attestedTlsFP = parsed.reportData ? parsed.reportData.slice(0, 64) : null;
    out.tlsKeyFingerprint = attestedTlsFP ? `sha256:${attestedTlsFP}` : null;
    out.enclave = {
      attestationDocument: doc,               // verbatim Tinfoil RAD - feed to Tinfoil's verifier (tinfoil-cli / @tinfoilsh/verifier)
      fetchedFrom: url, fetchedAt: new Date(_radCache.at).toISOString(),
      // fingerprint of the key the shim ACTUALLY presented when we fetched; equals
      // the quote-bound one unless the shim rotated its key mid-cache-window.
      observedTlsKeyFingerprint: liveTlsKeyFP,
    };
    out.vm = { technology: parsed.technology, quote: parsed.quote, quoteVersion: parsed.quoteVersion,
               measurements: parsed.measurements, reportData: parsed.reportData };
  } catch (e) {
    out.enclave = { available: false, error: e.message,
                    note: "Fetch " + RAD_PATH + " from this origin yourself - the shim serves it directly." };
  }
  // GPU evidence only when this deployment actually holds a card slice (a
  // CPU-only app placed on a GPU enclave holds none — no card fields for it).
  if (IS_GPU && rec?._gpu && !rec._gpu.cpu) {
    const n = nonce || randomBytes(32).toString("hex");
    try {
      const ev = await fetchGpuEvidence(n);
      out.gpu = { technology: "nvidia-cc", ccMode: ev.ccMode ?? null, nonce: ev.nonce || n,
                  driverVersion: ev.driverVersion ?? null,
                  // first card's material at the top level (single-card enclaves); all cards in gpus[]
                  report: ev.gpus?.[0]?.attestationReport_b64 ?? null,
                  certChain: ev.gpus?.[0]?.attestationCertChain_b64 ?? null,
                  gpus: ev.gpus || [],
                  gpuShare: rec.resources.gpuShare,
                  vramCapGb: round1((rec.resources.gpuShare || 0) * CARD_VRAM_GB),
                  computeShare: rec.resources.gpuShare,
                  verify: "Check the report + cert chain with NVIDIA NRAS or nvtrust's local_gpu_verifier; "
                        + "confirm it signs YOUR nonce. The whole card is one CC trust domain - the VRAM/compute "
                        + "split is enforced by the attested supervisor+MPS, not by the hardware report." };
    } catch (e) {
      out.gpu = { technology: "nvidia-cc", available: false, error: e.message };
    }
  }
  return out;
}
// ============================================================================

const app = express();
// Express 4 does not catch a REJECTED async route handler — it becomes an
// unhandledRejection (the process-level guard above logs it, but the request
// would hang and, pre-guard, the process died). Forward async rejections to the
// error middleware (registered after the routes) instead. We install it once, as
// a thin shim over the route-registration methods, so EVERY route handler
// (present and future) is covered and none can be forgotten. Only real handlers
// are wrapped (arity < 4); 4-arg error middleware is passed through untouched.
// app.use() is intentionally NOT shimmed — the streaming proxies mounted with it
// (/x/:id, the platform-model proxy) manage their own lifecycle.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const m of ["get", "post", "patch", "put", "delete"]) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) => orig(path, ...handlers.map((h) => (typeof h === "function" && h.length < 4 ? wrap(h) : h)));
}
app.use(cors({
  origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Authorization","Content-Type"],
  maxAge: 86400,
}));

const fail = (res, status, code, message) => res.status(status).json({ code, message });
// Prefer our attested SAN once known; fall back to the request Host only during
// early boot before the shim cert is read (client verifies attestation over its
// own TLS, so a reflected Host there is not trusted for identity).
const originOf = (req) => PUBLIC_URL || (_certSan ? `https://${_certSan}` : `https://${req.headers["x-forwarded-host"] || req.headers.host}`);

// Kick self-registration on any request in case the boot loop is mid-backoff. We
// register ONLY our attested shim-cert SAN (registerFromShimCert), never the
// request Host, so a spoofed Host can never make us advertise a bogus origin.
app.use((req, _res, next) => {
  if (REGISTRY_READY && !_registered) registerFromShimCert().catch(() => {});
  next();
});

async function addrFromAuth(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return m ? verifySessionToken(m[1]) : null;
}

// ---------------------------------------------------------------------------
// DATA PATH - registered BEFORE express.json() so the body streams untouched.
// Same token, same origin as control; supervisor checks ownership, then proxies.
// ---------------------------------------------------------------------------
// Firewall config validation. Mirrors the wasm-manager's rules so a bad spec fails
// fast at create (422) instead of at provision: entries are "http" (default serve
// mode) | "http:N" | "tcp:N" | "udp:N"; N in 1..19999 (logical labels; <1024 always remapped), excluding infra ports
// (8080 supervisor, 8091 manager) and the manager-assigned serve range (20000+).
const FW_MIN = 1, FW_MAX = 19999, FW_RESERVED = new Set([1080, 8080, 8090, 8091]);   // infra ports: 1080 egress SOCKS, 8080 supervisor, 8090 GPU worker, 8091 wasm-manager (logical labels; <1024 is always remapped to an unprivileged actual by the manager)
function parseFirewall(fw) {
  const raw = (fw && Array.isArray(fw.ports)) ? fw.ports : [];
  if (raw.length > 8) throw new Error("firewall.ports: at most 8 entries.");
  const out = [];
  for (const e of raw) {
    const s = String(e).trim().toLowerCase();
    if (!s || s === "http") continue;                       // default serve mode marker
    const m = /^(http|tcp|udp):(\d{1,5})$/.exec(s);
    if (!m) throw new Error(`firewall.ports: bad entry "${e}" (use http[:N] | tcp:N | udp:N).`);
    const p = +m[2];
    if (p < FW_MIN || p > FW_MAX || FW_RESERVED.has(p))
      throw new Error(`firewall.ports: port ${p} not allowed (${FW_MIN}-${FW_MAX}, excluding ${[...FW_RESERVED].join("/")}).`);
    if (!out.includes(m[1] + ":" + p)) out.push(m[1] + ":" + p);
  }
  if (out.filter((x) => x.startsWith("http:")).length > 1) throw new Error("firewall.ports: only one http:N entry.");
  return out;                                               // [] = classic wasi:http serve mode
}
const fwTcpPorts = (rec) => (rec.firewall || []).filter((x) => x.startsWith("tcp:")).map((x) => +x.slice(4));
const fwUdpPorts = (rec) => (rec.firewall || []).filter((x) => x.startsWith("udp:")).map((x) => +x.slice(4));

// ---------------------------------------------------------------------------
// Per-deployment addressing — each deployment gets its OWN IPv6 out of the
// relay box's routed /64, and the relays route by destination IP. This is the
// deployment's dedicated address: the udp-relay serves its udp:N ports there,
// and the tcp6-relay serves its tcp:N ports there (at the LOGICAL port, no SNI,
// no remapping — clients use the port the app declared). The address is
// DETERMINISTIC from the deployment id (sha256 → low 64 host bits), so the
// supervisor and every relay derive the identical value with no shared state.
// DEP_ADDR_PREFIX (or the legacy UDP_ADDR_PREFIX) is the relay box's routed /64
// (e.g. "2a01:4f9:c013:bdfd::/64"); unset = dedicated addressing off (the
// /x/:id/(tcp|udp) bridges still work for direct callers, but no address is
// advertised). See relay/README.md.
const DEP_ADDR_PREFIX = (process.env.DEP_ADDR_PREFIX || process.env.UDP_ADDR_PREFIX || "").trim();
function v6ToBig(s) {                                       // parse an IPv6 (incl. "::") to a 128-bit BigInt
  const [head, tail] = s.split("::");
  const hi = head ? head.split(":").filter(Boolean) : [];
  const lo = tail ? tail.split(":").filter(Boolean) : [];
  const mid = Array(8 - hi.length - lo.length).fill("0");
  const groups = s.includes("::") ? [...hi, ...mid, ...lo] : s.split(":");
  if (groups.length !== 8) throw new Error(`bad IPv6 "${s}"`);
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}
function bigToV6(n) {                                       // 128-bit BigInt → compressed IPv6 string
  const g = [];
  for (let i = 0; i < 8; i++) g[i] = Number((n >> BigInt((7 - i) * 16)) & 0xffffn);  // g[0] = most significant group
  let best = { i: -1, len: 0 }, cur = { i: -1, len: 0 };    // longest zero-run for "::"
  g.forEach((v, i) => {
    if (v === 0) { if (cur.i < 0) cur = { i, len: 0 }; cur.len++; if (cur.len > best.len) best = { ...cur }; }
    else cur = { i: -1, len: 0 };
  });
  const hex = g.map((v) => v.toString(16));
  if (best.len > 1) { hex.splice(best.i, best.len, ""); if (best.i === 0) hex.unshift(""); if (best.i + best.len === 8) hex.push(""); }
  return hex.join(":").replace(/:{3,}/, "::");
}
// Deterministic host part: sha256(id) low 64 bits, kept clear of the low range
// so it never lands on the box's own ::1 / infrastructure addresses.
function depAddrFor(id) {
  if (!DEP_ADDR_PREFIX) return null;
  const [prefix] = DEP_ADDR_PREFIX.split("/");
  const net128 = v6ToBig(prefix) & (~0n << 64n);            // zero the low 64 (host) bits
  let host = BigInt("0x" + createHash("sha256").update(id).digest("hex").slice(0, 16)) & ((1n << 64n) - 1n);
  if (host < 0x10000n) host += 0x10000n;                    // reserve the low range for infra
  return bigToV6(net128 | host);
}
// public deployments exposing udp ports, with their address + logical ports —
// the udp-relay reads this to know what to bind and where to route.
const udpMap = () => [...deployments.values()]
  .filter((r) => r.public && r.status === "running" && fwUdpPorts(r).length)
  .map((r) => ({ id: r.id, address: depAddrFor(r.id), ports: fwUdpPorts(r) }));
// public deployments with tcp OR udp ports, each with its dedicated address and
// per-protocol logical ports — the tcp6-relay (tcp) and udp-relay (udp) poll
// this to bind [address]:port and route into /x/:id/(tcp|udp)/:port.
const netMap = () => [...deployments.values()]
  .filter((r) => r.public && r.status === "running" && (fwTcpPorts(r).length || fwUdpPorts(r).length))
  .map((r) => ({ id: r.id, address: depAddrFor(r.id), tcp: fwTcpPorts(r), udp: fwUdpPorts(r) }));

// --- dedicated-IP EGRESS (the outbound half of depAddrFor) ------------------
// A deployment's OUTBOUND connections leave from its own IPv6, mirroring the
// inbound tcp6/udp relays. Guests opt in via ENCLAVE_EGRESS (a per-deployment SOCKS
// URL); the enclave front is here (egress.js), the source-binding dialer is
// relay/egress-relay.js. Enabled only when dedicated addressing is on AND a
// shared relay token is configured (EGRESS_RELAY_TOKEN — proves the control/
// data channels are the real relay, not a random client hitting the shim).
const EGRESS_RELAY_TOKEN = (process.env.EGRESS_RELAY_TOKEN || "").trim();
const EGRESS_SOCKS_PORT  = parseInt(process.env.EGRESS_SOCKS_PORT || "1080", 10);
const egress = (DEP_ADDR_PREFIX && EGRESS_RELAY_TOKEN)
  ? createEgress({
      secret: SECRET, socksPort: EGRESS_SOCKS_PORT, relayToken: EGRESS_RELAY_TOKEN,
      sourceAddrFor: depAddrFor,
      isKnown: (id) => { const r = deployments.get(id); return !!r && r.status === "running"; },
      log: (m) => console.log(m),
    })
  : null;

// On-chain ids are bytes32, and a full 64-hex id exceeds DNS's 63-char label
// limit - app subdomains carry a hex PREFIX of the id instead, resolved here
// (unique match only; the canonical label is the FIRST 8 CHARS = 32 bits,
// any longer prefix works too). Shared by the HTTP data path and the
// /x/:id/https upgrade path (browser TLS terminated in-enclave).
function depByIdOrPrefix(id) {
  let rec = deployments.get(id);
  if (!rec && /^0x[0-9a-f]{8,64}$/.test(id)) {
    const hits = [...deployments.keys()].filter(k => k.startsWith(id));
    if (hits.length === 1) rec = deployments.get(hits[0]);
  }
  return rec || null;
}

app.use("/x/:id", async (req, res) => {
  const rec = depByIdOrPrefix(req.params.id);
  if (!rec) return fail(res, 404, "not_found", "Unknown deployment.");
  // Ownership probe: the relay (and the TLS-issuance gate) asks HEAD /x/<id>
  // to learn which enclave serves an id. That is OUR knowledge, not the
  // app's - proxying it into the tenant made the answer depend on the app's
  // router treating HEAD / as a route (llm-chat 404'd it, so the relay
  // thought nobody owned the id and refused to mint the subdomain cert).
  // Answer bare-root HEADs here; HEAD on a real subpath still proxies.
  if (req.method === "HEAD" && (req.url === "/" || req.url === "")) {
    res.writeHead(204); return res.end();
  }
  // Public deployments serve anyone (websites/APIs). Private ones require the owner's
  // token (checked before status so a private deployment's state isn't leaked).
  if (!rec.public) {
    const addr = await addrFromAuth(req);
    if (!addr) return fail(res, 401, "unauthorized", "Missing or invalid token.");
    if (rec.owner !== addr) return fail(res, 403, "forbidden", "Not your deployment.");
  }
  if (rec.status !== "running") return fail(res, 409, "not_running", `Deployment is ${rec.status}.`);

  // vm backend: proxy to the app's loopback port on the app manager, on shared
  // localhost. worker backend: /x/:id/<sub> -> /tenants/:id/<sub>.
  const sub = req.url.replace(/^\/+/, "");
  let target;
  if (PROVISION_BACKEND === "vm") {
    if (!rec._vmHostPort) {
      return (rec.firewall && rec.firewall.length && !rec.firewall.some((x) => x.startsWith("http")))
        ? fail(res, 502, "no_http", "This app exposes raw TCP/UDP ports, not HTTP. Reach declared TCP ports via the WebSocket bridge at /x/:id/tcp/:port (e.g. websocat).")
        : fail(res, 502, "vm_not_ready", "The VM has no forwarded port yet.");
    }
    target = new URL(`http://127.0.0.1:${rec._vmHostPort}/${sub}`);
  } else {
    target = new URL(`${WORKER_MGR_URL}/tenants/${encodeURIComponent(rec.id)}/${sub}`);
  }
  const headers = { ...req.headers, host: target.host };
  delete headers.authorization; // the Enclave token stays at the supervisor; the worker never sees it
  const up = http.request(
    { host: target.hostname, port: target.port || 80, method: req.method,
      path: target.pathname + target.search, headers },
    (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); });
  up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end("upstream error: " + e.message); });
  req.pipe(up);
});

app.use(express.json({ limit: "256kb" }));

async function authed(req, res, next) {
  const addr = await addrFromAuth(req);
  if (!addr) return fail(res, 401, "unauthorized", "Missing or invalid session.");
  req.address = addr; next();
}

// ============================================================================
// system
// ============================================================================
app.get("/v1/health", (_req, res) => res.json({ status: "ok", deployments: deployments.size,
  // watcher freshness is billing-critical: while it's stale, funded clocks are frozen
  watcher: FORWARDER_ADDRESS ? { lastPollOkAt: _lastPollOkAt ? new Date(_lastPollOkAt).toISOString() : null,
                                 fresh: (Date.now() - _lastPollOkAt) < WATCHER_STALE_SEC * 1000 } : null,
  // reachability watchdog: "unreachable" = our advertised hostname is gone from
  // public DNS — claiming paused, held work released (see the claim loop)
  reach: (CLAIM_READY && REACH_DNS_STRIKES) ? { state: _reach.tripped ? "unreachable" : "ok",
    strikes: _reach.strikes, host: _reach.host,
    checkedAt: _reach.checkedAt ? new Date(_reach.checkedAt).toISOString() : null } : null }));
app.get("/v1/version", (_req, res) => res.json({ service: "enclave-supervisor/0.1.0", contract: "enclave-openapi/1.0.0", chainId: CHAIN_ID }));

app.get("/v1/pricing", async (_req, res) => {
  // One model on every flavor: apps specify EXACT resources, the two billing
  // shares are CALCULATED from them. A CPU-only enclave simply has no card to
  // sell (vramGb must be 0 here).
  // Deploy coordinates ride along: deployments are created and funded on the
  // EnclaveDeployments ledger (see POST /v1/deployments for the method shapes),
  // and the console needs the contract, the USDC EIP-712 domain, and an
  // ETH/USD quote for fundEth estimates - all public, all cache-friendly.
  const [ethUsd8, usdcDomain] = await Promise.all([
    ethUsdPrice8().catch(() => null), refreshUsdcDomain().catch(() => null)]);
  const base = {
    assets: ["ETH","USDC"], gpu: IS_GPU,
    deploymentsContract: DEPLOYMENTS_ADDRESS || null, chainId: CHAIN_ID,
    usdc: USDC_ADDRESS, usdcDomain,
    ethUsd: ethUsd8 ? (Number(ethUsd8) / 1e8).toFixed(2) : null,
    model: "Deployments buy TWO shares: gpuShare (0..1 of ONE GPU card — VRAM and compute move together; 0 = CPU-only app) and cpuShare (0..1 of the node's vCPU+RAM). Apps declare their exact specs in the catalog — VRAM GB + GPU TFLOPS of a card, RAM MB + CPU GFLOPS of the node; those specs divided by this server's spec (the LARGER of the memory and compute axes per pool, rounded up to the whole percent) are the MINIMUM shares a deployment may buy. A GPU app's gpuShare must be >= its cpuShare. Billed per second, additively.",
    node: { vcpus: NODE_VCPUS, ramGb: NODE_RAM_GB, gflops: NODE_GFLOPS,
            wholeNodePerSecondUsdc: CPU_RATE.toFixed(7), wholeNodePerHourUsdc: (CPU_RATE * 3600).toFixed(2) },
    computeGranularity: { unit: "percent", step: 1, minPercent: MIN_COMPUTE_PCT },
    formula: "ratePerSecondUsdc = gpuShare × wholeCardPerSecond + cpuShare × wholeNodePerSecond; minGpuShare = ceilPct(max(vramGb / cardVramGb, gpuTflops / cardTflops)); minCpuShare = ceilPct(max(memMb / nodeRam, cpuGflops / nodeGflops))",
    billingIncrementSeconds: 1,
  };
  const example = (g, c) => {
    const r = rateFor(g, c);
    return { gpuShare: g, cpuShare: c,
             ...(g > 0 ? { vramGb: round1(g * CARD_VRAM_GB), gpuTflops: round1(g * CARD_TFLOPS) } : {}),
             ramGb: round1(c * NODE_RAM_GB), vcpus: round1(c * NODE_VCPUS), cpuGflops: Math.round(c * NODE_GFLOPS),
             ratePerSecondUsdc: r.toFixed(7), ratePerHourUsdc: (r * 3600).toFixed(2) };
  };
  if (!IS_GPU) return res.json({
    ...base,
    note: "CPU-only enclave: gpuShare is not served here (set it to 0); GPU apps run on GPU enclaves.",
    examples: [0.05, 0.1, 0.25, 1].map(c => example(0, c)),
  });
  res.json({
    ...base,
    card: { vramGb: CARD_VRAM_GB, tflops: CARD_TFLOPS, count: GPU_COUNT, sms: SM_TOTAL,
            wholeCardPerSecondUsdc: FULL_RATE.toFixed(7), wholeCardPerHourUsdc: (FULL_RATE * 3600).toFixed(2) },
    vramGranularityGb: GRANULARITY_GB,
    examples: [[1, 0.1], [0.5, 0.1], [0.25, 0.05], [0.05, 0.05]].map(([g, c]) => example(g, c)),
  });
});

// Fast-path claim: a freshly funded on-chain deployment shouldn't wait out
// the sweep cadence (up to CLAIM_POLL_SEC + jitter + the CPU-first grace).
// Unauthenticated on purpose - a hint is just "look at this id now"; every
// fact is re-read from the chain and the claim tx is gated exactly like the
// sweep, so the worst a bogus hint costs is a few RPC reads.
const _hintBusy = new Set();
// Per-source-IP token bucket for the (deliberately unauthenticated) claim-hint:
// a hint for an id we don't already track triggers on-chain reads against the
// shared RPC, so we bound how fast one source can drive those. Cheap local-cache
// hits (already-serving/evaluating ids) never consume a token — only hints that
// would reach the chain do. A rate-limited hint is non-fatal: the deployment is
// already on-chain, so the normal claim sweep still picks it up within
// CLAIM_POLL_SEC. Keyed on x-forwarded-for (the shim's client IP) when present,
// else on the socket peer — behind a shim that doesn't forward the client IP this
// degrades to ONE shared bucket, which still bounds RPC amplification (just not
// per-IP). CLAIM_HINT_BURST=0 disables the limit; tune the pair for your traffic.
const CLAIM_HINT_BURST = parseInt(process.env.CLAIM_HINT_BURST || "20", 10);   // bucket size (allowed burst)
const CLAIM_HINT_RPS   = parseFloat(process.env.CLAIM_HINT_RPS || "2");        // sustained refill (tokens/sec)
const _hintBuckets = new Map();   // ip -> { tokens, at }
setInterval(() => { const cut = Date.now() - 600_000; for (const [ip, b] of _hintBuckets) if (b.at < cut) _hintBuckets.delete(ip); }, 300_000).unref?.();
function hintRateOk(req) {
  if (CLAIM_HINT_BURST <= 0) return true;
  const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim())
           || req.socket?.remoteAddress || "?";
  const now = Date.now();
  let b = _hintBuckets.get(ip);
  if (!b) { b = { tokens: CLAIM_HINT_BURST, at: now }; _hintBuckets.set(ip, b); }
  b.tokens = Math.min(CLAIM_HINT_BURST, b.tokens + ((now - b.at) / 1000) * CLAIM_HINT_RPS);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
app.post("/v1/claim-hint", async (req, res) => {
  const id = String((req.body && req.body.id) || "").toLowerCase().trim();
  if (!/^0x[0-9a-f]{64}$/.test(id))
    return fail(res, 422, "invalid_spec", "id must be the bytes32 deployment id (0x + 64 hex chars).");
  if (!CLAIM_READY || !_enclaveId)
    return fail(res, 503, "not_claiming", "This enclave is not claiming on-chain deployments right now.");
  const ex = deployments.get(id);
  if (ex && !CLAIM_TERMINAL.has(ex.status)) return res.json({ accepted: true, status: ex.status });
  if (_hintBusy.has(id)) return res.json({ accepted: true, status: "evaluating" });
  // Beyond here every path does on-chain reads — rate-limit the source first.
  if (!hintRateOk(req)) return fail(res, 429, "rate_limited", "Too many new-id claim hints from your source; retry shortly.");
  _hintBusy.add(id);
  try {
    const d = await readOnchainDeployment(id);
    if (!d || !Number(d.createdAt)) return fail(res, 404, "not_found", "No such deployment on the ledger.");
    // Preflight the CONTRACT's own gating synchronously (simulate the exact
    // claim tx) so structural failures - a stale registry pointer, an expired
    // entry, a lease race - surface HERE with the revert reason, instead of
    // "accepted: true" followed by a silent background failure. This is how
    // the 2026-07-05 wrong-registry-pointer bug should have been caught.
    // SKIP it when we already hold the live lease: no claim tx will be sent
    // (that's the resume path) and simulating one just reverts "leased",
    // wedging the only route back to a lease we own but lost the record of.
    const resuming = Number(d.leaseUntil) * 1000 > Date.now() && d.runner === _enclaveId;
    if (!resuming) {
      try {
        await chainClient.simulateContract({ address: getAddress(DEPLOYMENTS_ADDRESS), abi: CLAIM_TX_ABI,
          functionName: "claim", args: [id, _enclaveId], account: claimSigner().account });
      } catch (e) {
        return res.json({ accepted: false, reason: "claim would revert on-chain: " + (e.shortMessage || e.message) });
      }
    }
    const reason = await considerClaim(d, { hinted: true, background: true });
    if (reason) return res.json({ accepted: false, reason });
    res.json({ accepted: true, status: "claiming" });
  } catch (e) {
    fail(res, 502, "chain_unreachable", "Could not evaluate the hint: " + (e.shortMessage || e.message));
  } finally { _hintBusy.delete(id); }
});

app.get("/availability", async (_req, res) => {
  // Every enclave reports BOTH pools: gpuShareFree (the largest slice one card
  // can still take; 0 on a CPU-only enclave) and cpuShareFree (the node's
  // leftover vCPU+RAM share — on a GPU enclave that leftover is rentable by
  // CPU-only apps). The cpu pool prefers the vm backend's live accounting (the
  // wasm-manager admits by cpuShare); the gpu pool prefers the worker backend's
  // accounting when that backend holds the card, else our own card allocator.
  // Callers route on the pair: GPU work needs gpuShareFree, CPU-only work fits
  // wherever cpuShareFree is big enough. `maxShare` is a DEPRECATED alias of
  // the flavor's primary pool, kept one release for old routers.
  const shape = (cpuFree, gpuFree, source, note) => ({
    gpu: IS_GPU, type: IS_GPU ? "gpu" : "cpu",
    gpuShareFree: round3(gpuFree), cpuShareFree: round3(cpuFree),
    usedGpuShare: IS_GPU ? round3(1 - gpuFree) : 0, usedCpuShare: round3(1 - cpuFree),
    maxShare: round3(IS_GPU ? gpuFree : cpuFree),
    vcpusFree: round1(cpuFree * NODE_VCPUS), ramGbFree: round1(cpuFree * NODE_RAM_GB),
    cpuGflopsFree: Math.round(cpuFree * NODE_GFLOPS),
    nodeVcpus: NODE_VCPUS, nodeRamGb: NODE_RAM_GB, nodeGflops: NODE_GFLOPS,
    smFree: IS_GPU ? Math.round(gpuFree * SM_TOTAL) : 0, smTotal: IS_GPU ? SM_TOTAL : 0,
    vramFreeGb: IS_GPU ? round1(gpuFree * CARD_VRAM_GB) : 0,
    gpuTflopsFree: IS_GPU ? round1(gpuFree * CARD_TFLOPS) : 0,
    cardVramGb: IS_GPU ? CARD_VRAM_GB : 0, cardTflops: IS_GPU ? CARD_TFLOPS : 0, cards: GPU_COUNT,
    ...(IS_GPU ? { cardVramSource: CARD_VRAM_SRC } : {}),   // "nvidia-smi"/"manager"/"worker" = probed hardware; "env"/"default" = config fallback
    source, ...(note ? { note } : {}), updatedAt: new Date().toISOString(),
  });
  try {
    const h = PROVISION_BACKEND === "vm" ? await vmHealth() : await mgrHealth();
    const c = h.capacity || {};
    const cpuFree = PROVISION_BACKEND === "vm" ? (c.cpuShareFree ?? c.maxShare ?? maxFreeCpu()) : maxFreeCpu();
    const gpuFree = !IS_GPU ? 0
      : PROVISION_BACKEND === "vm" ? maxFreeGpuShare() : (c.gpuShareFree ?? c.maxShare ?? maxFreeGpuShare());
    // wasi-nn readiness rides along (vm backend): `nn` says whether GPU
    // deployments can launch; `nnProbe` carries the boot probe's diagnosis,
    // making a broken GPU path visible from outside without operator access.
    const nn = PROVISION_BACKEND === "vm" && h.nn !== undefined ? { nn: h.nn, nnProbe: h.nnProbe } : {};
    // attached model volumes this enclave carries (Modelwrap): the console and
    // clients read this to know which volumes a deployment here can mount.
    const vols = PROVISION_BACKEND === "vm" && Array.isArray(h.volumes) ? { volumes: h.volumes } : {};
    return res.json({ ...shape(cpuFree, gpuFree, PROVISION_BACKEND === "vm" ? "vmmanager" : "worker"), ...nn, ...vols });
  } catch (e) {
    return res.json(shape(maxFreeCpu(), maxFreeGpuShare(), "fallback",
      `${PROVISION_BACKEND === "vm" ? "wasm" : "worker"} manager unreachable`));
  }
});

// External proof that MPS caps are live: each running tenant's granted SM count
// (sanitized - no tenant ids). A 25% tenant should report ~33 of 132 SMs.
app.get("/v1/gpu", async (_req, res) => {
  if (!IS_GPU) return fail(res, 404, "no_gpu", "This is a CPU-only enclave: no GPU is attached.");
  try {
    const h = await mgrHealth(5000);
    res.json({
      ok: true, role: h.role, mpsActive: !!h.mps_pipe, capacity: h.capacity, smTotal: SM_TOTAL,
      tenants: (h.tenants || []).map((t) => ({ pct: t.pct, status: t.status, smGranted: t.sm_granted })),
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: `worker manager unreachable: ${e.message}` });
  }
});

// ============================================================================
// auth (SIWE)
// ============================================================================
app.get("/v1/auth/nonce", (req, res) => {
  let address; try { address = getAddress(String(req.query.address || "")); }
  catch { return fail(res, 422, "invalid_address", "Provide a valid ?address."); }
  const nonce = rid("");
  const issuedAt = new Date(), expirationTime = new Date(issuedAt.getTime() + 10 * 60_000);
  nonces.set(nonce, { address, exp: expirationTime.getTime() });
  // Bound the map: the TTL sweep runs every 60s, but a burst of nonce requests
  // between sweeps could grow it without limit. Map keeps insertion order, so the
  // oldest entries evict first (FIFO ≈ LRU; they'd expire soonest anyway).
  while (nonces.size > NONCE_MAX) { const k = nonces.keys().next().value; if (k === undefined) break; nonces.delete(k); }
  const statement = "Sign in to Enclave. This signature is free and will not move funds.";
  const message =
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\n` +
    `URI: ${SIWE_URI}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\n` +
    `Issued At: ${issuedAt.toISOString()}\nExpiration Time: ${expirationTime.toISOString()}`;
  res.json({ address, message, nonce, statement, domain: SIWE_DOMAIN, uri: SIWE_URI, version: "1",
             chainId: CHAIN_ID, issuedAt: issuedAt.toISOString(), expirationTime: expirationTime.toISOString() });
});

app.post("/v1/auth/login", async (req, res) => {
  const { message, signature } = req.body || {};
  if (!message || !signature) return fail(res, 422, "invalid_request", "message and signature are required.");
  const nm = message.match(/\nNonce: (\S+)\n/), am = message.match(/^(0x[0-9a-fA-F]{40})$/m);
  if (!nm || !am) return fail(res, 422, "invalid_message", "Malformed SIWE message.");
  // Bind the signed message to THIS enclave's SIWE parameters. /v1/auth/nonce
  // issues the exact message (domain/uri/chainId/expiration all ours) and the
  // client signs it verbatim (site/js/core/wallet.js: it uses the server's
  // `message` as-is; its buildSiwe fallback also resolves to these same values on
  // enclave.host). So a signature over a message that names a DIFFERENT domain/uri/
  // chain — or is already past its Expiration Time — is not a login here. We assert
  // ONLY fields the message actually carries (absent field => not asserted), so a
  // legitimate login is never locked out on a format we didn't emit.
  const dmatch = message.match(/^(.+?) wants you to sign in with your Ethereum account:/);
  const umatch = message.match(/^URI: (\S+)$/m);
  const cmatch = message.match(/^Chain ID: (\d+)$/m);
  const ematch = message.match(/^Expiration Time: (\S+)$/m);
  if (dmatch && dmatch[1] !== SIWE_DOMAIN) return fail(res, 401, "bad_domain", "SIWE message domain does not match this enclave.");
  if (umatch && umatch[1] !== SIWE_URI)    return fail(res, 401, "bad_uri", "SIWE message URI does not match this enclave.");
  if (cmatch && Number(cmatch[1]) !== CHAIN_ID) return fail(res, 401, "bad_chain", "SIWE message chain does not match this enclave.");
  if (ematch) { const t = Date.parse(ematch[1]); if (Number.isFinite(t) && t <= Date.now()) return fail(res, 401, "expired", "SIWE message has expired."); }
  const nonce = nm[1], claimed = getAddress(am[1]), rec = nonces.get(nonce);
  if (!rec || rec.exp < Date.now()) { nonces.delete(nonce); return fail(res, 401, "bad_nonce", "Unknown or expired nonce."); }
  if (getAddress(rec.address) !== claimed) return fail(res, 401, "address_mismatch", "Address does not match nonce.");
  let ok = false; try { ok = await verifyMessage({ address: claimed, message, signature }); } catch {}
  if (!ok) return fail(res, 401, "bad_signature", "Signature verification failed.");
  nonces.delete(nonce);
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);
  const token = await mintSession(claimed, expiresAt);
  res.json({ token, tokenType: "Bearer", address: claimed, expiresAt: expiresAt.toISOString() });
});

// ============================================================================
// payments (pay-per-deploy) - the supervisor WATCHES the EnclavePay forwarder on
// Base for Paid events and converts each payment into runtime. No held balance.
// (outbound Base RPC required - confirm the CVM egress allows BASE_RPC.)
// ============================================================================
const PAY_EVENT = { type: "event", name: "Paid", inputs: [
  { name: "deploymentId", type: "bytes32", indexed: true },
  { name: "payer",        type: "address", indexed: true },
  { name: "amount",       type: "uint256", indexed: false } ] };
const PAY_ETH_EVENT = { type: "event", name: "PaidEth", inputs: [
  { name: "deploymentId", type: "bytes32", indexed: true },
  { name: "payer",        type: "address", indexed: true },
  { name: "amountWei",    type: "uint256", indexed: false } ] };

const payRefIndex = new Map();   // payRef (hex, lowercase) -> deployment id

// USDC (6dp) funded at `rate` USDC/sec buys this many seconds of runtime.
const usdcToSeconds = (amountRaw, rate) => (Number(amountRaw) / 1e6) / (rate || 1);

// --- ETH payments: priced via the Chainlink ETH/USD feed on Base -------------
// Feed address verified on-chain (description() == "ETH / USD", decimals() == 8).
// On another chain (e.g. Base Sepolia) set ETH_USD_FEED to that chain's feed.
const ETH_USD_FEED = process.env.ETH_USD_FEED || "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const ETH_FEED_MAX_AGE_SEC = parseInt(process.env.ETH_FEED_MAX_AGE_SEC || "21600", 10); // 6h (feed heartbeat ~20min)
const FEED_ABI = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }];

// wei (1e18) * price (8dp) -> USDC-equivalent (6dp):  / 1e20
const weiToUsd6 = (wei, price8) => (wei * price8) / 10n ** 20n;

let _ethUsd = { price8: null, at: 0 };            // cached oracle read (for instructions + conversion)
async function ethUsdPrice8() {
  if (_ethUsd.price8 && (Date.now() - _ethUsd.at) < 60_000) return _ethUsd.price8;
  const [, answer, , updatedAt] = await chainClient.readContract({
    address: getAddress(ETH_USD_FEED), abi: FEED_ABI, functionName: "latestRoundData" });
  const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
  if (answer <= 0n) throw new Error(`ETH/USD feed returned ${answer}`);
  if (ageSec > ETH_FEED_MAX_AGE_SEC) throw new Error(`ETH/USD feed stale (${ageSec}s old)`);
  _ethUsd = { price8: answer, at: Date.now() };
  return answer;
}

// ETH payments retry if the oracle read fails: a payment must never be lost to a
// flaky RPC. Queue drains at the top of every poll tick.
const _pendingEth = [];
async function onPaidEth(payRefHex, payer, wei) {
  try {
    const price8 = await ethUsdPrice8();
    const usd6 = weiToUsd6(wei, price8);
    console.log(`[pay] eth ${wei} wei @ $${(Number(price8) / 1e8).toFixed(2)} -> ${(Number(usd6) / 1e6).toFixed(2)} USDC-equiv (${payRefHex})`);
    await onPaid(payRefHex, payer, usd6);
  } catch (e) {
    _pendingEth.push({ payRefHex, payer, wei });
    console.warn(`[pay] eth payment queued for retry (${e.shortMessage || e.message})`);
  }
}

// --- USDC EIP-712 domain: payers sign an EIP-3009 ReceiveWithAuthorization ---
// against the TOKEN's own domain, so instructions must carry its exact fields.
// name()/version() differ per deployment (mainnet USDC: "USD Coin"; Base Sepolia
// testnet USDC: "USDC"), so read them from the token once and cache forever.
const ERC20_META_ABI = [
  { type: "function", name: "name",    stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
let _usdcDomain = null;
async function refreshUsdcDomain() {
  if (_usdcDomain) return _usdcDomain;
  const addr = getAddress(USDC_ADDRESS);
  const [name, version] = await Promise.all([
    chainClient.readContract({ address: addr, abi: ERC20_META_ABI, functionName: "name" }),
    chainClient.readContract({ address: addr, abi: ERC20_META_ABI, functionName: "version" }).catch(() => "2"), // FiatTokenV2+ is "2"
  ]);
  _usdcDomain = { name, version, chainId: CHAIN_ID, verifyingContract: addr };
  console.log(`[pay] USDC EIP-712 domain: name="${name}" version="${version}"`);
  return _usdcDomain;
}

function paymentInstructions(rec) {
  return {
    chainId: CHAIN_ID, asset: "USDC", assets: ["USDC", "ETH"], usdc: USDC_ADDRESS,
    forwarder: FORWARDER_ADDRESS || null,
    deploymentRef: rec.payRef,                       // bytes32 to pass to payWithAuthorization() / payEth()
    ratePerSecondUsdc: (rec.rate || 0).toFixed(7),
    method: "payWithAuthorization(bytes32 deploymentId, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
    payEthMethod: "payEth(bytes32 deploymentId) payable",
    usdcDomain: _usdcDomain,                         // EIP-712 domain to sign ReceiveWithAuthorization against; null until the first token read
    ethUsd: _ethUsd.price8 ? (Number(_ethUsd.price8) / 1e8).toFixed(2) : null,   // cached Chainlink read; null until first refresh
    note: "USDC (EIP-3009, no approve): sign a USDC ReceiveWithAuthorization (EIP-712, to = forwarder, "
        + "nonce = first 16 bytes of deploymentRef + 16 random bytes), then anyone submits payWithAuthorization; "
        + "amount(6dp)/rate = seconds. "
        + "ETH: payEth(deploymentRef) with msg.value; credited as USDC-equivalent at the live Chainlink ETH/USD rate.",
  };
}

app.get("/v1/account", authed, (req, res) => {
  const mine = [...deployments.values()].filter(d => d.owner === req.address);
  res.json({
    address: req.address, chainId: CHAIN_ID,
    payment: { forwarder: FORWARDER_ADDRESS || null, usdc: USDC_ADDRESS, asset: "USDC", assets: ["USDC", "ETH"] },
    deployments: {
      running: mine.filter(d => d.status === "running").length,
      awaitingPayment: mine.filter(d => d.status === "awaiting_payment").length,
      total: mine.length,
      totalTimeRemainingSec: mine.reduce((s, d) => s + (timeRemainingSec(d) || 0), 0),
    },
  });
});

// ============================================================================
// deployments
// ============================================================================
// remainingMs === null means unlimited (auto-provision pilot); otherwise it only
// drains on healthy billing ticks, so it IS the truth even mid-outage.
// On-chain deployments: remainingMs mirrors only the CURRENT lease (minutes),
// while the rest of the funded runtime sits in the ledger balance - report
// lease tail + balance/rate or the console shows "12m left" on a 2-day fund.
const timeRemainingSec = (rec) => {
  if (rec.remainingMs == null) return null;
  const lease = Math.max(0, Math.round(rec.remainingMs / 1000));
  if (!rec._onchain || !(rec.rate > 0)) return lease;
  return lease + Math.max(0, Math.round((rec._balance6 || 0) / (rec.rate * 1e6)));
};
const spentOf = (rec) => (((rec.consumedMs || 0) / 1000) * (rec.rate || 0)).toFixed(2);
// EXPLICIT allowlist of record fields exposed to the owner (was a delete-denylist).
// Allowlist-shaped so a NEW internal field added to a record never leaks by
// default — it has to be added here on purpose. This is the exact set the
// denylist previously let through (creation + claim + provision + failure paths);
// the computed fields below (rate/spent/paid/time/expires, payment, onchain,
// network) are layered on top just as before.
const VIEW_FIELDS = ["id", "owner", "status", "public", "firewall", "image", "command",
  "app", "appWasm", "config", "resources", "network", "attestation", "region",
  "createdAt", "startedAt", "paused", "pauseReason", "payDeadline", "digest",
  "payRef", "paidUsdc", "portMap", "error"];
const view = (rec) => {
  const o = {};
  for (const k of VIEW_FIELDS) if (k in rec) o[k] = rec[k];
  // vmTechnology reflects what this enclave's OWN attestation document says
  // today, not what the record stored at create time (records persisted by
  // older builds carry a hardcoded guess; detection self-heals them).
  if (o.attestation) o.attestation = { ...o.attestation, vmTechnology: vmTech() ?? o.attestation.vmTechnology ?? null };
  o.ratePerSecondUsdc = (rec.rate || 0).toFixed(7);
  o.spentUsdc = spentOf(rec);
  o.paidUsdc = ((rec.paidUsdc || 0) / 1e6).toFixed(2);
  o.timeRemainingSec = timeRemainingSec(rec);
  // an ESTIMATE only: the balance drains solely while service is healthy, so a
  // frozen (paused) deployment has no meaningful wall-clock expiry.
  o.expiresAt = (rec.remainingMs != null && rec.status === "running" && !rec.paused)
    ? new Date(Date.now() + Math.max(0, timeRemainingSec(rec)) * 1000).toISOString() : null;
  o.payment = rec._onchain ? onchainPaymentInstructions(rec) : paymentInstructions(rec);
  // claimed-from-chain deployments surface their ledger identity + current lease
  if (rec._onchain) o.onchain = { contract: DEPLOYMENTS_ADDRESS, id: rec.id,
    leaseUntil: rec._leaseUntil ? new Date(rec._leaseUntil * 1000).toISOString() : null };
  // Dedicated per-deployment IPv6: declared tcp/udp ports are reachable at
  // [address]:<logical port> (tcp via the tcp6-relay, udp via the udp-relay).
  // Surface it so the dashboard/clients get a ready-to-use endpoint at the
  // real port the app declared, e.g. [addr]:5432, [addr]:443, [addr]:53.
  // With dedicated-IP egress on, the SAME address is also every deployment's
  // outbound identity - so it's surfaced even with no inbound ports declared
  // (network.egress marks the outbound half so clients can label it).
  const tcpPorts = fwTcpPorts(rec), udpPorts = fwUdpPorts(rec);
  const depAddr = depAddrFor(rec.id);
  if (depAddr && (tcpPorts.length || udpPorts.length || egress)) {
    o.network = { ...o.network, address: depAddr };
    if (egress) o.network.egress = true;
    if (tcpPorts.length) o.network.tcp = { address: depAddr, ports: tcpPorts };
    if (udpPorts.length) o.network.udp = { address: depAddr, ports: udpPorts };
  }
  return o;
};

// Arm (or re-arm after a restart) the unpaid-reservation timer from payDeadline.
// If the payment watcher is blind when the deadline hits, the reservation is
// frozen too: a payment may already sit in the unscanned window, so expiry
// defers until the watcher has caught back up to the chain tip.
function armPayTimer(rec) {
  if (rec._payTimer) clearTimeout(rec._payTimer);
  rec._payTimer = setTimeout(() => {
    if (rec.status !== "awaiting_payment") return;
    if (FORWARDER_ADDRESS && (Date.now() - _lastPollOkAt) > WATCHER_STALE_SEC * 1000) {
      rec.payDeadline = Date.now() + 60_000;
      armPayTimer(rec); saveStateSoon();
      return;
    }
    if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
    rec.status = "expired"; rec.error = "unpaid";
    console.log(`[pay] ${rec.id} reservation released (unpaid after payment window)`);
    saveStateSoon();
  }, Math.max(0, rec.payDeadline - Date.now()));
  if (rec._payTimer.unref) rec._payTimer.unref();
}

// ---- app approval (vm backend): catalog-gated deploys -----------------------
// A deployment references the CATALOG RECORD of the version it runs:
//   catalog://<appId>/<versionIndex>
// (Steven, 2026-07-09.) The wasm CID is a content address, NOT an app identity:
// two versions may share bytes and differ entirely in approved config, and the
// config alone changes behavior. So the record — never the deployer — is the
// authority for everything the owner's approval covered: the wasm CID (now
// just a fetch address), the config (ENCLAVE_CONFIG + volume mounts), the
// ports, and the resource minimums. Version rows are append-only and
// immutable, so the reference resolves to the same artifact forever; only the
// deployability flags (approval / yanked / app active) are live, and they are
// exactly what gets re-checked here on every claim, respawn and resume.
const CATALOG_ABI = [
  { type: "function", name: "getApp", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "appId", type: "bytes32" }, { name: "publisher", type: "address" },
      { name: "slug", type: "string" }, { name: "name", type: "string" },
      { name: "description", type: "string" }, { name: "versionCount", type: "uint32" },
      { name: "createdAt", type: "uint64" }, { name: "updatedAt", type: "uint64" },
      { name: "active", type: "bool" },
    ] }] },
  { type: "function", name: "getVersion", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "cid", type: "string" }, { name: "version", type: "string" },
      { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
      { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" },
      { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
      { name: "yanked", type: "bool" }, { name: "ports", type: "string" },
      { name: "approval", type: "uint8" },  // 0 pending | 1 approved | 2 rejected
      { name: "config", type: "string" },
    ] }] },
];
const CATALOG_REF_RE = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/;
const ZERO32 = "0x" + "0".repeat(64);
// Gate a vm-backend app reference on catalog approval. Returns
// { ref, wasmRef, config, ports, app: {appId,index,slug,version,publisher}, min }
// or { error }. An RPC failure REJECTS the deploy (fail closed): this is the
// enforcement point, so an outage must not waive it. The image ships NO
// deployable apps (nn-demo.wasm inside it is solely the boot probe's fixture,
// launched by the manager itself, never through this API), so approved catalog
// records are the only deploy surface — anything else is refused here, which
// also keeps bare paths under the manager's APPS_DIR (e.g. a cached
// ipfs-<cid>.wasm) from dodging the approval check.
const NO_MIN = { vramMb: 0, gpuGflops: 0, memMb: 0, cpuGflops: 0 };
async function gateAppReference(reference) {
  const deny = (status, code, msg) => ({ error: { status, code, msg } });
  const ref = String(reference || "").trim();
  const m = CATALOG_REF_RE.exec(ref);
  if (!m) {
    // ipfs:// and bare-CID references are RETIRED: a CID can belong to several
    // versions with different approved configs, so it cannot name what to run.
    return deny(422, "invalid_spec", "image.reference must be catalog://<appId>/<versionIndex> — the on-chain record of a catalog version. CID references are retired (a CID names bytes, not a version); redeploy from the console or CLI.");
  }
  if (!APP_CATALOG_ADDRESS)
    return deny(503, "approval_unavailable", "Catalog apps are disabled on this enclave: APP_CATALOG_ADDRESS is not configured, so approval cannot be verified.");
  const [appId, index] = [m[1], Number(m[2])];
  const [ar, vr] = await Promise.allSettled([
    chainClient.readContract({ address: getAddress(APP_CATALOG_ADDRESS),
      abi: CATALOG_ABI, functionName: "getApp", args: [appId] }),
    chainClient.readContract({ address: getAddress(APP_CATALOG_ADDRESS),
      abi: CATALOG_ABI, functionName: "getVersion", args: [appId, BigInt(index)] }),
  ]);
  if (ar.status === "rejected") {
    console.warn(`[approval] getApp(${appId}) failed: ${ar.reason?.shortMessage || ar.reason?.message}`);
    return deny(503, "catalog_unreachable", "Could not verify this app's approval against the on-chain catalog; try again shortly.");
  }
  const a = ar.value;
  if (!a || a.appId === ZERO32) return deny(403, "not_approved", "This appId is not in the app catalog.");
  if (index >= Number(a.versionCount)) return deny(403, "not_approved", `App '${a.slug}' has no version index ${index} (it has ${a.versionCount}).`);
  if (vr.status === "rejected") {   // index exists, so this is RPC trouble, not a bad ref
    console.warn(`[approval] getVersion(${appId}, ${index}) failed: ${vr.reason?.shortMessage || vr.reason?.message}`);
    return deny(503, "catalog_unreachable", "Could not verify this app's approval against the on-chain catalog; try again shortly.");
  }
  const v = vr.value;
  if (!a.active)                 return deny(403, "not_approved", "This app is delisted from the catalog.");
  if (v.yanked)                  return deny(403, "not_approved", `${a.slug}:${v.version} was yanked by its publisher.`);
  if (Number(v.approval) === 2)  return deny(403, "not_approved", `${a.slug}:${v.version} was rejected by the catalog owner.`);
  if (Number(v.approval) !== 1)  return deny(403, "not_approved", `${a.slug}:${v.version} is awaiting catalog-owner approval; it cannot be deployed yet.`);
  return { ref, wasmRef: "ipfs://" + v.cid, config: v.config || "", ports: v.ports || "",
           app: { appId, index, slug: a.slug, version: v.version, publisher: a.publisher },
           min: { vramMb: Number(v.vramMb) || 0, gpuGflops: Number(v.gpuGflops) || 0,
                  memMb: Number(v.memMb) || 0, cpuGflops: Number(v.cpuGflops) || 0 } };
}

app.post("/v1/deployments", authed, async (req, res) => {
  const b = req.body || {};
  // RETIRED on the wasm backend (Steven, 2026-07-05): this path held the spec
  // and the funded clock in enclave-local state, which died with the CVM on
  // every update. Deployments are created ON-CHAIN instead (EnclaveDeployments):
  // create() from the owner's wallet, fund with fundWithAuthorization (EIP-3009
  // USDC) or fundEth, and any enclave claims, serves, renews - and re-claims
  // after this one is updated or dies. The ledger IS the deployment; an
  // enclave is just its current runner.
  if (PROVISION_BACKEND === "vm") {
    return res.status(410).json({
      code: "deploy_on_chain",
      message: "Deployments are created on-chain, not through this endpoint: send create() to the "
             + "EnclaveDeployments contract from your wallet (you own the record), fund it via "
             + "fundWithAuthorization (EIP-3009 USDC, nonce prefixed with the id's first 16 bytes) or "
             + "fundEth, then POST /v1/claim-hint {id} to start it immediately. The deploy console at "
             + "the site does all of this for you. On-chain deployments survive enclave updates: the "
             + "ledger holds the spec and balance, and runners hold expiring leases.",
      onchain: {
        contract: DEPLOYMENTS_ADDRESS || null, chainId: CHAIN_ID, usdc: USDC_ADDRESS,
        createMethod: "create(string appRef, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, string ports, bool isPublic, "
                    + ((await depsAbi()).rev >= 2 ? "" : "string sshPubKey, ")
                    + "string configCid) returns (bytes32 id) — appRef is catalog://<appId>/<versionIndex> (runners refuse CID refs: a CID names bytes, not a version); leave configCid EMPTY and ports/appPort informational (the version's approved record decides all three)",
        fundMethod: "fundWithAuthorization(bytes32 id, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
        fundEthMethod: "fundEth(bytes32 id) payable",
        hint: "POST /v1/claim-hint {\"id\": \"0x…\"}",
      },
    });
  }
  // Per-owner cap on UNPAID reservations: an awaiting_payment deployment holds
  // hardware for the whole PAYMENT_WINDOW_SEC before any payment lands, so an
  // unbounded caller could reserve the node's capacity for free. Paid/running
  // deployments are never counted; MAX_UNPAID_PER_OWNER=0 disables the cap.
  if (MAX_UNPAID_PER_OWNER > 0) {
    const unpaid = [...deployments.values()].filter((d) => d.owner === req.address && d.status === "awaiting_payment").length;
    if (unpaid >= MAX_UNPAID_PER_OWNER)
      return fail(res, 429, "too_many_unpaid",
        `You have ${unpaid} reservation(s) awaiting payment (max ${MAX_UNPAID_PER_OWNER}). Pay for or cancel one before reserving more.`);
  }
  let image = (b.image && b.image.reference) ? b.image : { reference: DEFAULT_IMAGE };
  // Approval gate (vm backend runs catalog apps): only catalog://<appId>/<idx>
  // records the catalog owner APPROVED may deploy. Checked before any
  // reservation so a refused app never holds capacity or a payment window. The
  // gate also returns the version's exact declared resources — they become the
  // request defaults and the floor a request may not undercut.
  let appMin = { ...NO_MIN };
  if (PROVISION_BACKEND === "vm") {
    const g = await gateAppReference(image.reference);
    if (g.error) return fail(res, g.error.status, g.error.code, g.error.msg);
    image = { ...image, reference: g.ref };
    appMin = g.min;
  }
  const appPort = Number(b.port) || 8080;
  // Public endpoint: anyone can reach the app's data path (hosting a website/API).
  // Private (default): only the owner's SIWE token can. Management stays owner-only
  // either way. Confidentiality is unchanged — the TEE still hides the app from the
  // operator; "public" only governs who may send it requests.
  const isPublic = b.public === true || b.public === "true";
  // Firewall: the app's per-version ports config from the catalog ("http" | "http:N"
  // | "tcp:N" | "udp:N"). The wasm-manager grants wasi:sockets and enforces that the
  // app binds ONLY these (bind audit kills violators). Declared TCP ports are reached
  // through the one attested origin as a WebSocket bridge at /x/:id/tcp/:port.
  let firewall;
  try { firewall = parseFirewall(b.firewall); }
  catch (e) { return fail(res, 422, "invalid_spec", e.message); }

  // resource request: TWO SHARES, nothing else. resources.gpuShare (0..1 of one
  // GPU card: VRAM + compute together; 0 = CPU-only app) and resources.cpuShare
  // (0..1 of the node's vCPU+RAM). The app's exact specs in the catalog set the
  // MINIMUM shares (spec / this server's spec, the larger of the memory and
  // compute axes, rounded up to the percent grain) — a request below either
  // minimum is refused. A GPU app's gpuShare must be >= its cpuShare. Routing:
  // GPU work needs a GPU enclave; CPU-only work runs on either flavor — a GPU
  // enclave serves it from LEFTOVER cpu pool.
  const r0 = b.resources || {};
  if (r0.share != null || r0.computeShare != null || r0.vramGb != null || r0.memMb != null
      || r0.gpuTflops != null || r0.cpuTflops != null || r0.gpuGflops != null || r0.cpuGflops != null)
    return fail(res, 422, "invalid_spec", "Deployments buy SHARES: request resources.gpuShare (0..1 of one GPU card; 0 = CPU-only) and resources.cpuShare (0..1 of the node). Exact resources (vramGb/memMb/compute) are declared by the app in the catalog and only set the minimum shares.");
  const mins = minSharesOf(appMin);
  const gpuShare0 = r0.gpuShare != null ? Number(r0.gpuShare) : mins.gpuShare;
  if (!(gpuShare0 >= 0 && gpuShare0 <= 1))
    return fail(res, 422, "invalid_spec", "resources.gpuShare must be in [0, 1].");
  if (gpuShare0 > 0 && !IS_GPU)
    return fail(res, 422, "invalid_spec", "This is a CPU-only enclave: GPU shares are not served here. Set resources.gpuShare to 0 (CPU-only), or deploy to a GPU enclave.");
  const cpuShare0 = r0.cpuShare != null ? Number(r0.cpuShare)
    : Math.max(mins.cpuShare, gpuShare0 > 0 ? Math.min(0.05, gpuShare0) : 0.05);
  if (!(cpuShare0 > 0 && cpuShare0 <= 1))
    return fail(res, 422, "invalid_spec", "resources.cpuShare must be in (0, 1].");
  if (gpuShare0 < mins.gpuShare - 1e-9 || cpuShare0 < mins.cpuShare - 1e-9)
    return fail(res, 422, "invalid_spec", `Below this app's minimum shares: its declared specs need at least gpuShare ${round3(mins.gpuShare)} and cpuShare ${round3(mins.cpuShare)} on this hardware.`);
  if (gpuShare0 > 0 && gpuShare0 < cpuShare0 - 1e-9)
    return fail(res, 422, "invalid_spec", `gpuShare must be at least cpuShare: a GPU app's CPU slice rides on the same node as its card (got gpuShare ${round3(gpuShare0)} < cpuShare ${round3(cpuShare0)}).`);

  let slice, gpu, rate;
  if (!(gpuShare0 > 0)) {
    slice = normalizeCpuReq(cpuShare0);
    gpu = allocCpu(slice.cpuShare);
    if (!gpu) return fail(res, 409, "no_capacity",
      `Requested ${slice.pct}% of the node's CPU/RAM but only ${Math.round(maxFreeCpu() * 100)}% is free.`);
    rate = rateFor(0, slice.cpuShare);
  } else {
    // reserve an arbitrary GPU slice + its CPU slice; the worker isn't spawned until payment lands
    slice = normalizeGpuReq(gpuShare0, cpuShare0);
    if (slice.gpuShare > maxFreeGpuShare() + 1e-9)
      return fail(res, 422, "invalid_spec", `requested gpuShare ${round3(slice.gpuShare)} exceeds the largest free slice of a single card (${round3(maxFreeGpuShare())} = ${round1(maxFreeGpuShare() * CARD_VRAM_GB)} GB / ${round1(maxFreeGpuShare() * CARD_TFLOPS)} TFLOPS).`);
    gpu = allocGpu(slice.vramGb, slice.computeShare, slice.cpuShare);
    if (!gpu) return fail(res, 409, "no_capacity",
      `No capacity for gpuShare ${round3(slice.gpuShare)} + cpuShare ${round3(slice.cpuShare)} (free: ${round3(maxFreeGpuShare())} of a card, ${round3(maxFreeCpu())} of the node).`);
    rate = rateFor(slice.gpuShare, slice.cpuShare);
  }

  const id = rid("dep_");
  const payRef = keccak256(stringToBytes(id));          // the bytes32 to pass to EnclavePay.payWithAuthorization()
  const rec = {
    id, owner: req.address, status: "awaiting_payment", public: isPublic, firewall,
    image, command: b.command || [],
    // the two shares bought (the app's catalog specs only set the minimums)
    resources: gpu.cpu
      ? { gpuShare: 0, cpuShare: slice.cpuShare }
      : { gpuShare: slice.gpuShare, cpuShare: slice.cpuShare, cardId: gpu.cardId },
    network: { port: appPort, protocol: "https", endpoint: `${originOf(req)}/x/${id}` },
    attestation: { available: true, vmTechnology: vmTech(), gpuTechnology: IS_GPU ? "nvidia-cc" : null, href: `/v1/deployments/${id}/attestation` },
    region: "tinfoil", createdAt: new Date().toISOString(), startedAt: null,
    // fair-billing clock: a funded BALANCE (null = unlimited pilot) drained only
    // on healthy ticks - see startBillingTicker. paused surfaces a frozen clock.
    remainingMs: null, consumedMs: 0, paused: false, pauseReason: null, _lastTickAt: 0,
    payDeadline: Date.now() + PAYMENT_WINDOW_SEC * 1000,
    digest: image.digest || null, rate, payRef, paidUsdc: 0,
    _gpu: gpu, _gpuSpec: gpu.cpu ? null : { cardId: gpu.cardId, cardUuid: gpuCards[gpu.cardId]?.uuid || null, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare },
    _port: 0, _payTimer: null,
  };
  deployments.set(id, rec);
  payRefIndex.set(payRef.toLowerCase(), id);
  armPayTimer(rec);            // release the reservation if unpaid by payDeadline
  saveStateSoon();

  // AUTO_PROVISION: boot now without an on-chain payment (manual billing / pilot).
  if (AUTO_PROVISION) {
    if (!(await forceProvision(rec)))
      return fail(res, 502, "provision_failed", rec.error || "provisioning failed");
    console.log(`[auto-provision] ${id} booted without payment; `
              + `remaining=${rec.remainingMs != null ? Math.round(rec.remainingMs / 1000) + "s" : "unlimited"}`);
  }

  const out = view(rec);                                  // includes payment instructions
  res.status(201).json(out);
});

// Spawn the tenant's MPS-capped worker process (called once, on first payment).
async function provisionTenant(rec) {
  try {
    const sp = await spawnContainer({ deploymentId: rec.id,
      gpuShare: rec.resources.gpuShare || 0, cpuShare: rec.resources.cpuShare,
      image: { reference: rec.appWasm || (rec.image && rec.image.reference) },
      appPort: rec.network.port, ports: rec.firewall,
      config: rec.config || "" });
    rec._port = sp.internalPort;
    if (sp.vmId) { rec._vmId = sp.vmId; rec._vmHostPort = sp.hostPort; }
    if (sp.portMap) rec.portMap = sp.portMap;   // logical -> actual (public: clients see their mapping)
    if (!rec.startedAt) rec.startedAt = Date.now();
    rec.status = "running"; rec.paused = false; rec.pauseReason = null; rec._lastTickAt = Date.now();
    acmeReconcileSoon();   // public+http deployments earn a browser cert for <label>.APP_CERT_DOMAIN (no-op unless ACME is configured)
    return true;
  } catch (e) {
    rec.status = "failed"; rec.error = e.message;
    if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
    console.error(`[provision] ${rec.id} failed: ${e.message}`);
    return false;
  }
}

// Provision a deployment WITHOUT a payment (auto-provision / admin). Clears the
// unpaid-reservation timer and sets the optional safety expiry.
async function forceProvision(rec) {
  if (rec._payTimer) { clearTimeout(rec._payTimer); rec._payTimer = null; }
  const ok = await provisionTenant(rec);
  if (ok) rec.remainingMs = AUTO_PROVISION_HOURS > 0 ? AUTO_PROVISION_HOURS * 3600 * 1000 : null; // null = unlimited
  saveStateSoon();
  return ok;
}

// A Paid event landed: provision on first payment, extend expiry on top-ups.
async function onPaid(payRefHex, payer, amountRaw) {
  const id = payRefIndex.get(String(payRefHex).toLowerCase());
  if (!id) { console.warn(`[pay] payment for unknown ref ${payRefHex} (${amountRaw})`); return; }
  const rec = deployments.get(id); if (!rec) return;
  const seconds = usdcToSeconds(amountRaw, rec.rate);
  rec.paidUsdc = (rec.paidUsdc || 0) + Number(amountRaw);
  if (rec.status === "awaiting_payment") {
    if (rec._payTimer) { clearTimeout(rec._payTimer); rec._payTimer = null; }
    if (!(await provisionTenant(rec))) { saveStateSoon(); return; }  // failed provisioning surfaces in the record
    rec.remainingMs = seconds * 1000;
    console.log(`[pay] ${id} funded ${(Number(amountRaw)/1e6).toFixed(2)} USDC -> +${Math.round(seconds)}s, provisioned`);
  } else if (rec.status === "running") {
    // top-up adds to the balance; a grace overrun (negative balance) is forgiven.
    // remainingMs === null (unlimited pilot) stays unlimited.
    if (rec.remainingMs != null) rec.remainingMs = Math.max(0, rec.remainingMs) + seconds * 1000;
    console.log(`[pay] ${id} top-up ${(Number(amountRaw)/1e6).toFixed(2)} USDC -> +${Math.round(seconds)}s (${timeRemainingSec(rec) ?? "unlimited"}s left)`);
  } else {
    console.warn(`[pay] ${id} payment ${(Number(amountRaw)/1e6).toFixed(2)} USDC but status=${rec.status}; ignored (no refunds in pay-per-deploy)`);
  }
  saveStateSoon();
}

// Watch the forwarder for Paid events (poll getLogs; robust on public RPC).
// Robust log watch on a public RPC. Two failure modes the naive "scan to tip,
// advance past it" loop hits, and how we kill both:
//  (1) MISSED LOGS -> lost payments. mainnet.base.org is load-balanced; getBlockNumber()
//      and getLogs() can hit different nodes at different heights, so a log in the newest
//      blocks can be absent from the response — and advancing past it drops the payment
//      forever. Fix: only finalize up to tip - PAY_CONFIRMATIONS, and re-scan a trailing
//      overlap every poll so a momentarily-behind node gets a second look.
//  (2) DOUBLE-CREDIT. Re-scanning would re-run onPaid (a top-up) for the same event.
//      Fix: dedup on txHash:logIndex — each payment log is handled exactly once, which
//      also makes a mid-poll RPC failure safe to retry.
const PAY_CONFIRMATIONS = parseInt(process.env.PAY_CONFIRMATIONS || "3", 10);    // blocks of lag before trusting a log
const PAY_RESCAN_BLOCKS = parseInt(process.env.PAY_RESCAN_BLOCKS || "20", 10);   // trailing overlap re-scanned each poll (~40s on Base)
const PAY_CHUNK_BLOCKS  = BigInt(process.env.PAY_CHUNK_BLOCKS || "4000");        // max getLogs range per call (public-RPC safe)
const PAY_MAX_CATCHUP   = BigInt(process.env.PAY_MAX_CATCHUP_BLOCKS || "200000"); // ~4.6 days of Base blocks
const _seenLogs = new Map();   // "txHash:logIndex" -> blockNumber (pruned as the window advances)
let _payFromBlock = null;      // persisted: after downtime the watcher resumes HERE, not at the tip
let _lastPollOkAt = 0;         // freshness signal: billing + reservation expiry freeze while the watcher is blind
let _polling = false;
async function pollPayments() {
  if (!FORWARDER_ADDRESS || _polling) return;   // no overlap: catch-up after downtime can outlast one poll interval
  _polling = true;
  try {
    // instructions need the token's EIP-712 domain; retry here until the first read lands
    if (!_usdcDomain) refreshUsdcDomain().catch(() => {});
    // retry ETH payments that missed an oracle read (never lose a payment)
    if (_pendingEth.length) {
      const q = _pendingEth.splice(0);
      for (const p of q) await onPaidEth(p.payRefHex, p.payer, p.wei);
    }
    const tip = await chainClient.getBlockNumber();
    const safe = tip - BigInt(PAY_CONFIRMATIONS);                    // don't finalize logs newer than this
    if (safe < 0n) return;
    if (_payFromBlock == null) _payFromBlock = safe + 1n;            // first EVER run: start at the (confirmed) tip
    if (safe < _payFromBlock) { _lastPollOkAt = Date.now(); return; } // no new confirmed blocks yet
    if (safe - _payFromBlock > PAY_MAX_CATCHUP) {                    // bound a very long outage
      console.warn(`[pay] catch-up clamped: ${safe - _payFromBlock} blocks behind, scanning last ${PAY_MAX_CATCHUP}`);
      _payFromBlock = safe - PAY_MAX_CATCHUP;
    }
    // Walk the window in chunks: after an outage it can span hours of blocks, and
    // public RPCs reject or silently truncate huge ranges. _lastPollOkAt stays
    // stale until fully caught up, so clocks stay frozen while payments made
    // during the outage are still being credited.
    while (_payFromBlock <= safe) {
      const from = _payFromBlock > BigInt(PAY_RESCAN_BLOCKS) ? _payFromBlock - BigInt(PAY_RESCAN_BLOCKS) : 0n;
      const to = (safe - from) > PAY_CHUNK_BLOCKS ? from + PAY_CHUNK_BLOCKS : safe;
      for (const [k, b] of _seenLogs) if (b < from) _seenLogs.delete(k);   // prune dedup set below the window
      for (const [evt, isEth] of [[PAY_EVENT, false], [PAY_ETH_EVENT, true]]) {
        const logs = await chainClient.getLogs({ address: getAddress(FORWARDER_ADDRESS),
          event: evt, fromBlock: from, toBlock: to });
        for (const lg of logs) {
          const key = `${lg.transactionHash}:${lg.logIndex}`;
          if (_seenLogs.has(key)) continue;                          // exactly-once, even across re-scans / partial failures
          _seenLogs.set(key, lg.blockNumber);
          const a = lg.args || {};
          if (isEth) await onPaidEth(a.deploymentId, a.payer, a.amountWei);
          else       await onPaid(a.deploymentId, a.payer, a.amount);
        }
      }
      _payFromBlock = to + 1n;
      saveStateSoon();                                               // persist the cursor: a restart resumes, not skips
    }
    _lastPollOkAt = Date.now();
  } catch (e) { console.warn(`[pay] poll error: ${e.shortMessage || e.message}`); }
  finally { _polling = false; }
}
function startPaymentWatcher() {
  if (!FORWARDER_ADDRESS) { console.warn("[pay] FORWARDER_ADDRESS unset - payments disabled (deployments will sit awaiting_payment)"); return; }
  console.log(`[pay] watching ${FORWARDER_ADDRESS} for Paid + PaidEth events every ${PAY_POLL_SEC}s (ETH priced via ${ETH_USD_FEED})`);
  const t = setInterval(pollPayments, PAY_POLL_SEC * 1000); if (t.unref) t.unref();
  pollPayments();
  // prime the USDC EIP-712 domain so payment instructions can carry it (retries in pollPayments)
  refreshUsdcDomain().catch((e) => console.warn(`[pay] USDC domain read: ${e.shortMessage || e.message}`));
  // prime + keep the ETH/USD cache warm so payment instructions can quote ethUsd
  ethUsdPrice8().catch((e) => console.warn(`[pay] ETH/USD feed: ${e.shortMessage || e.message}`));
  const p = setInterval(() => ethUsdPrice8().catch(() => {}), 300_000); if (p.unref) p.unref();
}

// ---- fair-billing ticker (replaces the wall-clock reaper) -------------------
// Drains each running deployment's remainingMs by REAL elapsed time, but ONLY
// while the platform is serving: backend manager healthy, payment watcher fresh,
// app instance actually alive. Otherwise the deployment is marked paused and its
// clock FREEZES; it resumes on the first healthy tick. Supervisor downtime
// freezes too: ticks simply don't happen while we're down, and loadState()
// resets _lastTickAt on boot so the gap is never charged.
const isMock = () => /^(1|true|on)$/i.test(process.env.MOCK_SPAWN || "");
async function backendHealthy() {
  if (isMock()) return true;
  try { PROVISION_BACKEND === "vm" ? await vmHealth() : await mgrHealth(); return true; }
  catch { return false; }
}
// vm backend: is this deployment's app instance still alive in the manager?
// (the wasm-manager runs apps as subprocesses; a manager restart loses them)
async function instanceAlive(rec) {
  if (isMock() || PROVISION_BACKEND !== "vm") return true;  // worker backend: manager health is the best signal we have
  if (!rec._vmId) return false;
  const r = await vmReq("GET", `/vms/${encodeURIComponent(rec._vmId)}`, null, 5000).catch(() => null);
  if (!r) return false;                        // manager unreachable mid-tick: freeze, don't respawn
  // the manager reports crashed processes as status "failed" (with the exit
  // signal in .error) - an existing record is NOT the same as a live app
  return r.status === 200 && r.body && r.body.status === "running";
}
function pauseRec(rec, reason) {
  if (!rec.paused || rec.pauseReason !== reason) {
    console.warn(`[bill] ${rec.id} clock FROZEN (${reason})`);
    rec.paused = true; rec.pauseReason = reason; saveStateSoon();
  }
  rec._lastTickAt = Date.now();                // downtime is never charged
}
function resumeRec(rec) {
  if (rec.paused) {
    console.log(`[bill] ${rec.id} clock resumed (${timeRemainingSec(rec) ?? "unlimited"}s left)`);
    rec.paused = false; rec.pauseReason = null;
    rec._lastTickAt = Date.now();              // bill from the moment of resume, not the frozen span
    saveStateSoon();
  }
}
// Respawn a still-funded app whose instance vanished (e.g. the manager container
// restarted). Never marks the record failed - the user keeps their frozen
// balance; retries back off so a broken image can't hammer the manager.
async function respawnTenant(rec) {
  if (rec._respawning || Date.now() < (rec._respawnAt || 0)) return false;
  rec._respawning = true;
  try {
    const sp = await spawnContainer({ deploymentId: rec.id,
      gpuShare: rec.resources.gpuShare || 0, cpuShare: rec.resources.cpuShare,
      image: { reference: rec.appWasm || (rec.image && rec.image.reference) },
      appPort: rec.network.port, ports: rec.firewall,
      config: rec.config || "" });
    rec._port = sp.internalPort;
    if (sp.vmId) { rec._vmId = sp.vmId; rec._vmHostPort = sp.hostPort; }
    if (sp.portMap) rec.portMap = sp.portMap;
    rec._respawnAt = 0; rec._respawnBackoffMs = 0;
    console.log(`[bill] ${rec.id} instance respawned after outage`);
    return true;
  } catch (e) {
    rec._respawnBackoffMs = Math.min((rec._respawnBackoffMs || 15000) * 2, 300000);
    rec._respawnAt = Date.now() + rec._respawnBackoffMs;
    console.warn(`[bill] ${rec.id} respawn failed (${e.message}); retry in ${Math.round(rec._respawnBackoffMs / 1000)}s`);
    return false;
  } finally { rec._respawning = false; }
}
function startBillingTicker() {
  const t = setInterval(async () => {
    const now = Date.now();
    const healthy = await backendHealthy();
    const watcherOk = !FORWARDER_ADDRESS || (now - _lastPollOkAt) < WATCHER_STALE_SEC * 1000;
    for (const rec of deployments.values()) {
      if (rec.status !== "running") continue;
      // On-chain (claimed) deployments: the lease is prepaid wall-clock and the
      // chain doesn't stop while we're unhealthy, so freeze/pause semantics
      // don't apply. remainingMs mirrors the lease; the claim loop extends it
      // by renewing, and an unrenewable lease runs out right here through the
      // normal reaper (the deployment then goes back on the open queue).
      if (rec._onchain) {
        if (rec.paused) { rec.paused = false; rec.pauseReason = null; }   // restart recovery: pause is meaningless
        if (healthy && !(await instanceAlive(rec))) await respawnTenant(rec);
        const elapsed = Math.min(Math.max(0, now - (rec._lastTickAt || now)), 2 * BILL_TICK_SEC * 1000);
        rec._lastTickAt = now;
        rec.consumedMs = (rec.consumedMs || 0) + elapsed;
        rec.remainingMs = rec._leaseUntil * 1000 - now;
        saveStateSoon();
        if (rec.remainingMs < -GRACE_SEC * 1000) {
          console.log(`[reaper] ${rec.id} lease over (not renewed) -> teardown`);
          try { await stopContainer(rec); } catch {}
          if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
          rec.status = "expired";           // claim sweep may re-adopt it if funded again
        }
        continue;
      }
      if (!healthy)   { pauseRec(rec, "backend_down");  continue; }
      if (!watcherOk) { pauseRec(rec, "watcher_stale"); continue; }
      if (!(await instanceAlive(rec))) {
        pauseRec(rec, "instance_missing");
        if (await respawnTenant(rec)) resumeRec(rec);
        continue;
      }
      resumeRec(rec);
      if (rec.remainingMs == null) { rec._lastTickAt = now; continue; }   // unlimited (pilot)
      // clamp so an event-loop stall or clock jump can't overcharge one tick
      const elapsed = Math.min(Math.max(0, now - (rec._lastTickAt || now)), 2 * BILL_TICK_SEC * 1000);
      rec._lastTickAt = now;
      rec.remainingMs -= elapsed;
      rec.consumedMs = (rec.consumedMs || 0) + elapsed;
      saveStateSoon();
      if (rec.remainingMs < -GRACE_SEC * 1000) {
        console.log(`[reaper] ${rec.id} out of funded time -> teardown`);
        try { await stopContainer(rec); } catch {}
        if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
        rec.status = "expired";
      }
    }
    if (_stateDirty) saveStateNow();
  }, BILL_TICK_SEC * 1000);
  if (t.unref) t.unref();
}

app.get("/v1/deployments", authed, (req, res) =>
  res.json({ data: [...deployments.values()].filter(d => d.owner === req.address).map(view), cursor: null }));

app.get("/v1/deployments/:id", authed, (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  res.json(view(rec));
});

// Operator-only: provision an awaiting_payment deployment WITHOUT a payment.
// Gated by ADMIN_TOKEN (x-admin-token header); returns 404 if the token is unset
// or wrong, so the endpoint is invisible without it. Use for manually-billed deploys.
app.post("/v1/admin/deployments/:id/provision", async (req, res) => {
  if (!ADMIN_TOKEN || !safeEqStr(req.headers["x-admin-token"], ADMIN_TOKEN))
    return fail(res, 404, "not_found", "Not found.");
  const rec = deployments.get(req.params.id);
  if (!rec) return fail(res, 404, "not_found", "No such deployment.");
  if (rec.status !== "awaiting_payment")
    return fail(res, 409, "not_provisionable", `Deployment is ${rec.status}.`);
  if (!(await forceProvision(rec)))
    return fail(res, 502, "provision_failed", rec.error || "provisioning failed");
  console.log(`[admin] ${rec.id} provisioned by operator (no payment)`);
  res.json(view(rec));
});

app.delete("/v1/deployments/:id", authed, async (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  if (rec._payTimer) { clearTimeout(rec._payTimer); rec._payTimer = null; }
  // An unpaid reservation never ran: cancel = REMOVE it, so the deploy page
  // doesn't show a ghost (nothing ran, nothing paid — no history worth keeping).
  // A payment broadcast anyway after this lands uncredited at payout, exactly
  // like paying after the reservation window expires.
  if (rec.status === "awaiting_payment") {
    if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
    deployments.delete(rec.id);
    if (rec.payRef) payRefIndex.delete(rec.payRef.toLowerCase());
    saveStateSoon();
    return res.json({ id: rec.id, status: "canceled",
                      note: "Reservation released; nothing was charged." });
  }
  try { await stopContainer(rec); } catch {}
  if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
  // stopContainer was awaited: the instance is gone, so this is the final state
  rec.status = "terminated";
  saveStateSoon();
  if (rec._onchain) {
    // hand the lease back (refunds the unused tail to the on-chain balance).
    // While the deployment stays active+funded on-chain, ANY enclave — this one
    // included — may legitimately re-claim it; a permanent stop is the owner's
    // setActive(false) transaction, not a local delete.
    releaseLease(rec.id, "owner delete").catch(() => {});
    return res.json({ id: rec.id, status: "terminated",
               ranSeconds: Math.round((rec.consumedMs || 0) / 1000),
               note: "On-chain deployment: lease released (unused lease time refunded to its balance). It stays "
                   + "claimable by any enclave while active and funded — call setActive(false) on EnclaveDeployments "
                   + "to stop it for good." });
  }
  res.json({ id: rec.id, status: "terminated",
             paidUsdc: ((rec.paidUsdc || 0) / 1e6).toFixed(2),
             ranSeconds: Math.round((rec.consumedMs || 0) / 1000),
             note: "Pay-per-deploy: no balance is held, so unused funded time is forfeit on early stop." });
});


// Top-up instructions. An on-chain deployment funds the EnclaveDeployments
// ledger - the contract, not this box, meters its runtime, so EnclavePay
// instructions here would take the user's money without crediting balance6.
// Legacy pre-on-chain records still get the forwarder instructions.
app.post("/v1/deployments/:id/topup", authed, (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  if (!["running", "awaiting_payment"].includes(rec.status))
    return fail(res, 409, "not_toppable", `Deployment is ${rec.status}.`);
  if (rec._onchain) return res.json({
    id: rec.id, status: rec.status, timeRemainingSec: timeRemainingSec(rec),
    funding: {
      contract: DEPLOYMENTS_ADDRESS || null, chainId: CHAIN_ID, usdc: USDC_ADDRESS,
      ratePerSecondUsdc: (rec.rate || 0).toFixed(7),
      fundMethod: "fundWithAuthorization(bytes32 id, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
      fundEthMethod: "fundEth(bytes32 id) payable",
      usdcDomain: _usdcDomain,
      ethUsd: _ethUsd.price8 ? (Number(_ethUsd.price8) / 1e8).toFixed(2) : null,
      note: "On-chain deployment: fund the EnclaveDeployments contract, NOT the legacy forwarder (a forwarder "
          + "payment cannot credit an on-chain balance). USDC: sign a ReceiveWithAuthorization (EIP-712, to = the "
          + "contract, nonce = first 16 bytes of the id + 16 random bytes), then anyone submits fundWithAuthorization. "
          + "ETH: fundEth(id) with msg.value, credited at the contract's Chainlink ETH/USD read. Each payment adds "
          + "amount(6dp)/rate seconds to the on-chain balance.",
    } });
  res.json({ id: rec.id, status: rec.status, timeRemainingSec: timeRemainingSec(rec), payment: paymentInstructions(rec) });
});

// Optional ?nonce=<64 hex chars>: freshness challenge folded into the GPU report
// (the CPU quote needs none - it binds the long-lived TLS key, and freshness
// comes from fetching the RAD over your own connection).
function attestNonce(req, res) {
  const n = req.query.nonce;
  if (n == null) return randomBytes(32).toString("hex");
  if (!/^[0-9a-fA-F]{64}$/.test(n)) { fail(res, 422, "bad_nonce", "nonce must be 32 bytes of hex."); return null; }
  return n.toLowerCase();
}
app.get("/v1/deployments/:id/attestation", authed, async (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  const nonce = attestNonce(req, res); if (nonce == null) return;
  try { res.json({ deploymentId: rec.id, generatedAt: new Date().toISOString(),
                   ...(await getMeasurements(rec, { origin: originOf(req), nonce })),
                   guideUrl: "https://enclave.host/#attest" }); }
  catch (e) { fail(res, 502, "attestation_error", e.message); }
});

// Enclave-level attestation, PUBLIC: verify the enclave before logging in or
// sending a byte. GPU evidence is included from a short cache (refreshed with a
// self-chosen nonce) so an unauthenticated caller can't spam NVML report
// generation; pass a nonce on the per-deployment endpoint for a fresh challenge.
let _gpuEvCache = null;                       // { ev?, err?, at } - failures cached briefly too
app.get("/v1/attestation", async (req, res) => {
  const out = await getMeasurements(null, { origin: originOf(req) });
  // Bind the session-verification key to the attestation: a client that trusts
  // this document can trust this key, and thus verify that a session token was
  // ES256-signed in-enclave (not HMAC-minted by the operator). Full key at /v1/session-jwks.
  out.sessionKey = SESSION_JWK
    ? { kid: SESSION_KID, alg: "ES256", jwks: "/v1/session-jwks", keySource: "in-enclave",
        note: "Session JWTs are ES256-signed by this in-enclave key; the operator cannot mint one." }
    : null;
  if (!IS_GPU)                                 // CPU-only enclave: no card, no NVML evidence to fetch
    return res.json({ generatedAt: new Date().toISOString(), ...out, guideUrl: "https://enclave.host/#attest" });
  try {
    const ttl = _gpuEvCache?.err ? 10_000 : 60_000;
    if (!_gpuEvCache || Date.now() - _gpuEvCache.at > ttl) {
      try { _gpuEvCache = { ev: await fetchGpuEvidence(randomBytes(32).toString("hex"), 15000), at: Date.now() }; }
      catch (e) { _gpuEvCache = { err: e, at: Date.now() }; }
    }
    if (_gpuEvCache.err) throw _gpuEvCache.err;
    const ev = _gpuEvCache.ev;
    out.gpu = { technology: "nvidia-cc", ccMode: ev.ccMode ?? null, nonce: ev.nonce,
                driverVersion: ev.driverVersion ?? null, generatedAt: new Date(_gpuEvCache.at).toISOString(),
                report: ev.gpus?.[0]?.attestationReport_b64 ?? null,
                certChain: ev.gpus?.[0]?.attestationCertChain_b64 ?? null, gpus: ev.gpus || [] };
  } catch (e) { out.gpu = { technology: "nvidia-cc", available: false, error: e.message }; }
  res.json({ generatedAt: new Date().toISOString(), ...out, guideUrl: "https://enclave.host/#attest" });
});

// TLS-bridge cert binding, PUBLIC: closes the attestation gap on the relay
// path (relay/README.md). A relay-path session terminates against a cert
// minted in-enclave at boot (initTlsBridge) — self-signed, so CA validation
// says nothing about it. Publishing the cert + fingerprints OVER THE ATTESTED
// ORIGIN is what binds it: verify /v1/attestation, read the expected
// fingerprint from the same origin, then require exactly that cert when
// connecting to <dep-id>.tcp.<domain>:<port>. The private key never left the
// CVM, so nothing outside the enclave — a MITM relay, the operator — can
// present a cert that passes the pin.
app.get("/v1/tls-bridge", (_req, res) => {
  if (!TLS_BRIDGE_INFO) return res.json({ enabled: false });
  res.json({ enabled: true, ...TLS_BRIDGE_INFO,
             verify: "Verify this origin's /v1/attestation first; then require the served cert on "
                   + "<dep-id>.tcp.<domain> connections to match fingerprint256 (or pin spkiPinSha256, "
                   + "or use `certificate` as your sole trust root - it is self-signed, minted in-enclave)." });
});

// PUBLIC session-verification key set (JWKS, RFC 7517). The session JWT is
// ES256-signed by a key minted in-enclave at boot; this is its PUBLIC half,
// served over the attested origin. A client/relay/peer enclave can verify a
// token — and confirm the operator did NOT mint it — while holding no secret.
// The private key never left this CVM.
app.get("/v1/session-jwks", (_req, res) => {
  res.set("cache-control", "public, max-age=300");
  res.json({ keys: SESSION_JWK ? [SESSION_JWK] : [] });
});

// UDP routing map, PUBLIC: the udp-relay (relay/udp-relay.js) polls this to learn
// which per-deployment IPv6 to bind and which logical ports to route into the
// /x/:id/udp/:port bridge. Only public+running deployments with udp ports; the
// addresses are the deterministic ones the relay also derives from the id.
app.get("/v1/udp-map", (_req, res) =>
  res.json({ enabled: !!DEP_ADDR_PREFIX, prefix: DEP_ADDR_PREFIX || null, deployments: udpMap() }));

// Dedicated-IP routing map, PUBLIC: the tcp6-relay (and udp-relay) poll this to
// learn each public+running deployment's dedicated IPv6 and its per-protocol
// logical ports, then bind [address]:port and route into /x/:id/(tcp|udp)/:port.
// Same deterministic addresses the relays also derive from the id.
app.get("/v1/net-map", (_req, res) =>
  res.json({ enabled: !!DEP_ADDR_PREFIX, prefix: DEP_ADDR_PREFIX || null, deployments: netMap() }));

// Tail the worker's stdout/stderr (owner only). ?tail=N (default 200, max 2000).
app.get("/v1/deployments/:id/logs", authed, async (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  if (/^(1|true|on)$/i.test(process.env.MOCK_SPAWN || "")) return res.type("text/plain").send("[mock] no real worker; logs unavailable\n");
  const tail = String(Math.min(2000, Math.max(1, parseInt(req.query.tail, 10) || 200)));
  // vm backend: the wasm-manager keeps each tenant's stdout+stderr - the
  // app's stage markers and, crucially, its last words when it dies (panic,
  // CUDA/ORT abort). Without this, a crashed wasm app is undebuggable by
  // its owner.
  if (PROVISION_BACKEND === "vm") {
    if (!rec._vmId) return fail(res, 409, "no_instance", "No app instance (not provisioned here yet).");
    try {
      const r = await vmReq("GET", `/vms/${encodeURIComponent(rec._vmId)}/logs?tail=${tail}`, null, 15000);
      if (r.status !== 200) return fail(res, 502, "logs_error", (r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`);
      const b = r.body || {};
      const head = `# status=${b.status || rec.status}${b.exited ? ` exited(code=${b.exitCode})` : ""}${b.error ? ` error=${b.error}` : ""}\n`;
      return res.type("text/plain").send(head + (b.lines || []).join("\n") + "\n");
    } catch (e) { return fail(res, 502, "logs_error", (e.message || "").toString().slice(0, 300)); }
  }
  // worker (GPU PTX) backend: jobs are request/response, no per-tenant log stream.
  return fail(res, 501, "logs_unavailable", "Log retrieval is only available for wasm (vm) deployments.");
});

app.use((_req, res) => fail(res, 404, "not_found", "No such route."));
// Final error middleware (4-arg): a rejected async handler was forwarded here by
// wrap() (installed at the top of the app). Never crash — log and return a clean
// 500, and never double-send if the handler already began a response.
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}: ${err && (err.stack || err.message || err)}`);
  if (res.headersSent) { try { res.end(); } catch {} return; }
  fail(res, 500, "internal_error", "Internal error.");
});
if (IS_GPU) { await initGpu(); await initMps(); }        // CPU-only enclave: no cards to discover, no MPS
else if (PROVISION_BACKEND !== "vm")
  console.warn("[cpu] GPU_COUNT=0 but PROVISION_BACKEND!=vm — a CPU enclave has no GPU worker; deploys will fail");
// restore persisted deployments/payment cursor BEFORE serving traffic or polling:
// the downtime gap is frozen (never charged) and reservations shift by the gap.
initStatePersistence();
loadState();

// ---------------------------------------------------------------------------
// WebSocket upgrades - the TCP/UDP/TLS bridges below ride the one attested
// origin (no second external port). Gate: session JWT (Authorization header
// or ?token= for browsers/websocat) + ownership where the route demands it.
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

async function authUpgrade(req) {
  let token = null;
  const h = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (h) token = h[1];
  else { try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch {} }
  if (!token) return null;
  return verifySessionToken(token);
}

// --- platform-terminated TLS for app TCP ports (/x/:id/tls/:port) -----------
// The public relay (relay/relay.js, on any untrusted box) forwards a client's
// raw TLS bytes into this bridge; the session terminates HERE, inside the
// attested enclave. The key pair is MINTED IN-ENCLAVE at boot — never
// provisioned as a secret, so no operator, ACME account, or
// secret store ever holds it and the relay stays a dumb ciphertext pipe. The
// cert is self-signed for *.<TLS_BRIDGE_DOMAIN>; clients bind it to the
// enclave via the fingerprints published over the attested origin at
// /v1/tls-bridge (CA validation never proved enclave residency anyway — see
// relay/README.md). Stock clients that don't validate certs (psql
// sslmode=require, irssi --tls) connect unchanged; validating clients pin or
// use the published PEM as their trust root. The pair persists in the TLS-bridge
// dir (tmpfs, see tlsBridgeDir), so the fingerprint is stable across supervisor
// restarts within one CVM boot; a full relaunch (tmpfs wiped) mints a fresh key —
// re-read the pin from the attested origin. TLS_BRIDGE_DOMAIN unset = the /tls/
// path answers 503; /tcp/ is unchanged.
const TLS_BRIDGE_DOMAIN = (process.env.TLS_BRIDGE_DOMAIN || "").trim().replace(/^\*\./, "").replace(/\.$/, "");
let TLS_BRIDGE_CTX = null, TLS_BRIDGE_INFO = null;
// The TLS-bridge PRIVATE KEY is minted in-enclave and MUST live on memory-backed
// storage (tmpfs) — it must never touch host-persisted disk. STATE_FILE, by
// contrast, MAY be pointed at a host-backed volume for billing persistence (see
// its comment), so we keep the TLS key on its OWN path, independent of STATE_FILE.
// TLS_BRIDGE_DIR overrides; otherwise use the ramdisk the gpu/cpu configs mount,
// falling back (with a loud warning) to the STATE_FILE dir only when no ramdisk is
// present. Per-boot rotation is preserved: a fresh CVM boot has an empty tmpfs.
function tlsBridgeDir() {
  const explicit = (process.env.TLS_BRIDGE_DIR || "").trim();
  if (explicit) return explicit;
  if (existsSync("/mnt/ramdisk")) return "/mnt/ramdisk/enclave-tls";
  const fallback = join(dirname(STATE_FILE), "tls-bridge");
  console.warn(`[tls-bridge] no /mnt/ramdisk and TLS_BRIDGE_DIR unset — minting the in-enclave TLS key under ${fallback} (the STATE_FILE dir). This dir MUST be memory-backed (tmpfs): if STATE_FILE is on host-backed storage the private key would leak to the host. Set TLS_BRIDGE_DIR to a tmpfs path.`);
  return fallback;
}
function initTlsBridge() {
  if (!TLS_BRIDGE_DOMAIN) return;
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(TLS_BRIDGE_DOMAIN))
    return console.error(`[tls-bridge] TLS_BRIDGE_DOMAIN ${JSON.stringify(TLS_BRIDGE_DOMAIN)} is not a hostname - /tls/ bridge disabled`);
  const dir = tlsBridgeDir();                    // OWN tmpfs path, independent of STATE_FILE (the key must never hit host disk)
  const certPath = join(dir, "cert.pem"), keyPath = join(dir, "key.pem");
  try {
    let certPem = null, keyPem = null;
    try {   // reuse the persisted pair unless it's near expiry or the domain changed
      const c = readFileSync(certPath, "utf8"), k = readFileSync(keyPath, "utf8");
      const x = new X509Certificate(c);
      if (new Date(x.validTo).getTime() - Date.now() > 30 * 86400e3
          && (x.subjectAltName || "").split(", ").includes(`DNS:*.${TLS_BRIDGE_DOMAIN}`)) { certPem = c; keyPem = k; }
    } catch {}
    if (!certPem) {
      mkdirSync(dir, { recursive: true });
      // 10y self-signed EC P-256: expiry is a formality — trust comes from the
      // attested-origin pin, and a CVM relaunch mints a fresh pair long before.
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
        "-keyout", keyPath, "-out", certPath, "-days", "3650", "-nodes",
        "-subj", `/CN=*.${TLS_BRIDGE_DOMAIN}`,
        "-addext", `subjectAltName=DNS:*.${TLS_BRIDGE_DOMAIN},DNS:${TLS_BRIDGE_DOMAIN}`]);
      chmodSync(keyPath, 0o600);
      certPem = readFileSync(certPath, "utf8"); keyPem = readFileSync(keyPath, "utf8");
      console.log(`[tls-bridge] minted in-enclave key + self-signed cert for *.${TLS_BRIDGE_DOMAIN}`);
    }
    TLS_BRIDGE_CTX = tls.createSecureContext({ cert: certPem, key: keyPem });
    const x = new X509Certificate(certPem);
    TLS_BRIDGE_INFO = {
      subject: x.subject, subjectAltName: x.subjectAltName || null,
      validFrom: x.validFrom, validTo: x.validTo,
      fingerprint256: x.fingerprint256,                               // SHA-256 of the leaf DER (openssl x509 -fingerprint -sha256)
      spkiPinSha256: createHash("sha256")                             // HPKP-style public-key pin (curl --pinnedpubkey)
        .update(x.publicKey.export({ type: "spki", format: "der" })).digest("base64"),
      certificate: x.toString(),
      selfSigned: true, keySource: "in-enclave",                      // the key never existed outside this CVM
    };
  } catch (e) { console.error("[tls-bridge] in-enclave cert mint failed (openssl missing?) - /tls/ bridge disabled:", e.message); }
}
initSessionKey();
initTlsBridge();
if (TLS_BRIDGE_CTX) console.log(`[tls-bridge] in-enclave TLS termination enabled (/x/:id/tls/:port) · ${TLS_BRIDGE_INFO.fingerprint256}`);

// ============================================================================
// in-enclave ACME - RUNTIME HALF (the pure helpers live up top, next to the
// self-test seam). One ACME account per boot, one cert per public HTTP app at
// <label>.APP_CERT_DOMAIN, all held in memory: { keyPem, certPem, ctx }. The
// SNI hook below slots these contexts into the SAME TLS bridge that serves the
// self-signed pair, so a browser hitting /x/:id/https (or a validating client
// on /tls/) gets a CA-signed cert whose key never left this CVM.
// ============================================================================
const acmeCerts = new Map();   // name -> { keyPem, certPem, ctx, expiresAt, renewAt }
const acmeRetry = new Map();   // name -> { failures, nextAt } (per-name backoff)
const acmeQueue = [];          // names awaiting issuance, FIFO, deduped
let _acmeDir = null, _acmeAccount = null, _acmeNonce = null, _acmePumping = false;
const sleepMs = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// The relay's canonical app label (MUST mirror relay/api-relay.js depFromHost):
// on-chain 0x ids -> the first 8 hex chars (32 bits; collisions are fantasy);
// a retired-era dep_ id -> the id minus its redundant dep_ prefix.
const appCertLabel = (id) => { const s = String(id).toLowerCase(); return s.startsWith("0x") ? s.slice(2, 10) : s.replace(/^dep[-_]/, ""); };
const appCertName  = (id) => `${appCertLabel(id)}.${APP_CERT_DOMAIN}`;
// "serves HTTP" = empty firewall (classic wasi:http serve mode) or an explicit
// http:N entry; tcp/udp-only apps get no browser subdomain cert.
const servesHttp   = (rec) => { const fw = rec.firewall || []; return fw.length === 0 || fw.some((x) => String(x).startsWith("http")); };
const desiredCertNames = (rec) => {
  const names = [];
  // ONE hostname per deployment: on <label>.APP_CERT_DOMAIN, port 443 is the
  // HTTP surface (unless the tenant declared tcp:443 — their socket wins) and
  // every other DECLARED tcp port is the tenant's socket, all behind the same
  // in-enclave /tls/ terminator — so any http-serving OR tcp-declaring
  // deployment needs the app-zone cert. The tcp.<domain> zone is SUNSET: no
  // per-name certs are issued under it anymore; TLS_BRIDGE_DOMAIN now only
  // names the self-signed fallback pair and gates the /tls/ path.
  if (servesHttp(rec) || fwTcpPorts(rec).length) names.push(appCertName(rec.id));
  return names;
};

// --- ACME protocol plumbing (network; every entry point is ACME_ENABLED-gated
//     via startAcme/acmeReconcileSoon, so none of this runs unconfigured) -----
async function acmeDir() {
  if (!_acmeDir) {
    const r = await fetch(ACME_DIRECTORY);
    if (!r.ok) { throw new Error(`directory fetch ${r.status}`); }
    _acmeDir = await r.json();
  }
  return _acmeDir;
}
async function takeNonce() {
  if (_acmeNonce) { const n = _acmeNonce; _acmeNonce = null; return n; }
  const r = await fetch((await acmeDir()).newNonce, { method: "HEAD" });
  const n = r.headers.get("replay-nonce");
  if (!n) throw new Error("newNonce returned no replay-nonce");
  return n;
}
// Signed POST (the only verb ACME knows): ES256 JWS envelope, jwk before the
// account exists / kid after, fresh-nonce retry ONCE on badNonce (RFC 8555
// §6.5 - a stale cached nonce is routine, not an error). payload null =
// POST-as-GET. Returns { status, headers, data } with data json-or-text.
async function acmePost(url, payload, { useJwk = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const nonce = await takeNonce();
    const prot  = { alg: "ES256", nonce, url, ...(useJwk ? { jwk: _acmeAccount.jwk } : { kid: _acmeAccount.kid }) };
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/jose+json" },
                                 body: JSON.stringify(jwsSignEs256(prot, payload, _acmeAccount.key)) });
    _acmeNonce = r.headers.get("replay-nonce") || _acmeNonce;   // every reply carries the next nonce
    const isJson = /json/.test(r.headers.get("content-type") || "");
    const data = isJson ? await r.json().catch(() => null) : await r.text();
    if (r.status >= 400) {
      if (attempt === 0 && data && /badNonce/.test(data.type || "")) continue;
      throw new Error(`ACME ${r.status} at ${url}: ${isJson ? `${data?.type || "?"} ${data?.detail || ""}`.trim() : String(data).slice(0, 200)}`);
    }
    return { status: r.status, headers: r.headers, data };
  }
}
// One account per boot (in-memory key; CVMs have no disk and ZeroSSL's EAB
// makes re-registration free). The EAB inner JWS binds our fresh key to the
// CA-issued credential; the Location header is the kid all later JWS use.
async function acmeAccount() {
  if (_acmeAccount?.kid) return _acmeAccount;
  const dir = await acmeDir();
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" });
  _acmeAccount = { key: privateKey, jwk: { crv: j.crv, kty: j.kty, x: j.x, y: j.y }, thumbprint: jwkThumbprint(j), kid: null };
  try {
    const r = await acmePost(dir.newAccount,
      { termsOfServiceAgreed: true, externalAccountBinding: eabJws(ACME_EAB_KID, ACME_EAB_HMAC, _acmeAccount.jwk, dir.newAccount) },
      { useJwk: true });
    _acmeAccount.kid = r.headers.get("location");
    if (!_acmeAccount.kid) throw new Error("newAccount returned no Location (account kid)");
    console.log(`[acme] account registered at ${_acmeAccount.kid}`);
  } catch (e) { _acmeAccount = null; throw e; }
  return _acmeAccount;
}
// TXT push/cleanup through the platform DNS daemon. The body HMAC uses a
// DERIVED key, never the raw SECRET: SECRET mints session JWTs, and the DNS
// daemon lives on the relay box, which by design holds no platform secrets —
// it gets only HMAC(SECRET, "enclave dns-txt v1"), which authorizes TXT
// pushes and nothing else. The daemon's env SECRET= is that derived hex:
//   node -e 'console.log(require("node:crypto").createHmac("sha256",
//     process.argv[1]).update("enclave dns-txt v1").digest("hex"))' "$SECRET"
const DNS_TXT_KEY = SECRET ? createHmac("sha256", SECRET).update("enclave dns-txt v1").digest("hex") : "";
async function dnsTxt(method, name, value) {
  const body = JSON.stringify({ name, value, ttlSec: 300 });
  const sig  = createHmac("sha256", DNS_TXT_KEY).update(body).digest("hex");
  const r = await fetch(`${DNS_API}/v1/txt`, { method, headers: { "content-type": "application/json", "x-relay-sig": sig }, body });
  if (!r.ok) throw new Error(`DNS_API ${method} ${name}: HTTP ${r.status}`);
}
// Poll an authz/order URL (POST-as-GET) until ok/bad/timeout, gentle backoff.
async function acmePoll(url, what, isOk, isBad, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (let delay = 2000; ; delay = Math.min(Math.round(delay * 1.5), 10_000)) {
    const { data } = await acmePost(url, null);
    if (isOk(data)) return data;
    if (isBad(data)) {
      const errs = data.error || (data.challenges || []).map((c) => c.error).filter(Boolean);
      throw new Error(`${what} became ${data.status}: ${JSON.stringify(errs).slice(0, 300)}`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${what} still ${data.status} after ${Math.round(timeoutMs / 1000)}s`);
    await sleepMs(delay);
  }
}
// The full dns-01 dance for one name: order -> TXT -> challenge -> CSR ->
// finalize -> download. The TXT record is deleted win or lose.
async function acmeIssue(name) {
  const acct = await acmeAccount();
  const dir  = await acmeDir();
  const order = await acmePost(dir.newOrder, { identifiers: [{ type: "dns", value: name }] });
  const orderUrl = order.headers.get("location");
  const authzUrl = order.data.authorizations[0];
  const authz = await acmePost(authzUrl, null);
  // CAs reuse fresh authorizations across orders (renewals often land inside
  // the reuse window): an already-valid authz means no TXT dance at all.
  let txtName = null, txtValue = null;
  if (authz.data.status !== "valid") {
    const chal = (authz.data.challenges || []).find((c) => c.type === "dns-01");
    if (!chal) throw new Error(`no dns-01 challenge offered for ${name}`);
    txtName  = `_acme-challenge.${name}`;
    txtValue = dns01TxtValue(chal.token, acct.thumbprint);
    await dnsTxt("POST", txtName, txtValue);
  }
  try {
    if (txtName) {
      const chal = authz.data.challenges.find((c) => c.type === "dns-01");
      await sleepMs(5000);                                    // let the DNS daemon start answering before the CA looks
      await acmePost(chal.url, {});                           // {} = "I'm ready" (RFC 8555 §7.5.1)
      await acmePoll(authzUrl, `authz for ${name}`, (a) => a.status === "valid",
                     (a) => ["invalid", "revoked", "deactivated", "expired"].includes(a.status));
    }
    const { csrDer, keyPem } = buildCsr(name);
    await acmePost(order.data.finalize, { csr: b64u(csrDer) });
    const done = await acmePoll(orderUrl, `order for ${name}`, (o) => o.status === "valid" && o.certificate,
                                (o) => o.status === "invalid");
    const cert = await acmePost(done.certificate, null);      // POST-as-GET; body = PEM chain
    const certPem = String(cert.data);
    const leaf = new X509Certificate(certPem);                // parses the first (leaf) cert of the chain
    const nb = new Date(leaf.validFrom).getTime(), na = new Date(leaf.validTo).getTime();
    return { keyPem, certPem, expiresAt: na,
             renewAt: nb + Math.round((na - nb) * 2 / 3),     // renew past 2/3 of lifetime
             ctx: tls.createSecureContext({ key: keyPem, cert: certPem }) };
  } finally {                                                 // cleanup is best-effort: a leftover TXT is cosmetic
    if (txtName) dnsTxt("DELETE", txtName, txtValue).catch((e) => console.warn(`[acme] TXT cleanup failed for ${txtName}: ${e.message}`));
  }
}

// --- coverage + lifecycle ----------------------------------------------------
// Desired set = every public+running deployment that serves HTTP. Reconcile
// diffs desired-vs-held (missing, or past renewAt) into the queue; the pump
// drains it strictly serially with 2s spacing (CA politeness) and per-name
// exponential backoff on failure (5 min doubling, capped at 1h). Reconcile
// runs at boot, every 10 min, and is poked whenever a deployment flips to
// running (provisionTenant).
function acmeReconcile() {
  if (!ACME_ENABLED) return;
  const now = Date.now();
  for (const r of deployments.values()) {
    if (!(r.public && r.status === "running")) continue;
    for (const name of desiredCertNames(r)) {
      if (acmeCerts.get(name)?.renewAt > now) continue;       // held and still fresh
      if (acmeRetry.get(name)?.nextAt > now)  continue;       // failing; wait out the backoff
      if (!acmeQueue.includes(name)) acmeQueue.push(name);
    }
  }
  if (acmeQueue.length) acmePump();
}
let _acmeSoonTimer = null;
function acmeReconcileSoon() {                                // the status->running hook (cheap, debounced)
  if (!ACME_ENABLED || _acmeSoonTimer) return;
  _acmeSoonTimer = setTimeout(() => { _acmeSoonTimer = null; acmeReconcile(); }, 1000);
  if (_acmeSoonTimer.unref) _acmeSoonTimer.unref();
}
async function acmePump() {
  if (_acmePumping) return;
  _acmePumping = true;
  try {
    while (acmeQueue.length) {
      const name = acmeQueue.shift();
      if (acmeCerts.get(name)?.renewAt > Date.now()) continue;  // became fresh while queued (double-enqueue race)
      try {
        const issued = await acmeIssue(name);
        acmeCerts.set(name, issued);
        acmeRetry.delete(name);
        console.log(`[acme] issued ${name} (expires ${new Date(issued.expiresAt).toISOString()})`);
      } catch (e) {
        const failures = (acmeRetry.get(name)?.failures || 0) + 1;
        const backoff  = Math.min(3600_000, 300_000 * 2 ** (failures - 1));
        acmeRetry.set(name, { failures, nextAt: Date.now() + backoff });
        console.error(`[acme] failed ${name}: ${e.message} (retry #${failures} in ${Math.round(backoff / 60_000)}m)`);
      }
      await sleepMs(2000);
    }
  } finally { _acmePumping = false; }
}
function startAcme() {                                        // called at the bottom, with the other boot starters
  if (!ACME_ENABLED) {
    if (ACME_EAB_KID || ACME_EAB_HMAC || APP_CERT_DOMAIN || DNS_API)
      console.warn("[acme] partially configured - needs ALL of ACME_EAB_KID, ACME_EAB_HMAC, APP_CERT_DOMAIN, DNS_API; app-subdomain TLS stays off");
    return;
  }
  acmeReconcile();                                            // boot coverage (loadState already ran)
  const t = setInterval(acmeReconcile, 600_000);              // renewals + anything the running-hook missed
  if (t.unref) t.unref();
  console.log(`[acme] in-enclave issuance on: <label>.${APP_CERT_DOMAIN} via ${ACME_DIRECTORY} (dns-01 through ${DNS_API})`);
}

// --- SNI selection -----------------------------------------------------------
// One lookup shared by every in-enclave TLS termination point: a managed ACME
// cert wins when the client's SNI names it; otherwise the self-signed bridge
// pair (pin-verified via /v1/tls-bridge) serves, exactly as before.
const acmeCtxFor = (servername) => acmeCerts.get(String(servername || "").toLowerCase())?.ctx || null;
const sniSelect  = (servername, cb) => cb(null, acmeCtxFor(servername) || TLS_BRIDGE_CTX || undefined);

// --- /x/:id/https - browser HTTPS terminated in-enclave -----------------------
// The passthrough relay forwards a browser's raw TLS bytes here (same WS
// transport as /tls/); we unwrap them with the deployment's ACME cert and feed
// the plaintext into the express app THROUGH a real (non-listening) http.Server
// - so keep-alive, chunked bodies and pipelining all ride Node's own HTTP
// parser, zero hand-rolled parsing. The handler pins every inner request to the
// deployment resolved AT UPGRADE TIME by prefixing its /x/<fullId>; because the
// prefix is ALWAYS applied, a smuggled inner "/x/other/..." merely becomes
// "/x/<id>/x/other/..." - a subpath inside the same deployment, harmless.
const internalAppServer = http.createServer((req, res) => {
  const fullId = req.socket._appDepId;
  if (!fullId) { res.writeHead(500); return res.end(); }      // unreachable: only our emit('connection') feeds this server
  req.url = `/x/${fullId}${req.url.startsWith("/") ? "" : "/"}${req.url}`;
  app(req, res);                                              // the express app is a plain (req,res) function
});
internalAppServer.keepAliveTimeout = 180_000;                 // match the data path's idle allowance
internalAppServer.headersTimeout   = 185_000;                 // must exceed keepAliveTimeout (Node's slowloris guard)
internalAppServer.requestTimeout   = 0;                       // streaming request/response bodies can be long-lived
function wsHttpsBridge(req, socket, head, fullId) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const wsStream = createWebSocketStream(ws);
    const tlsSock  = new tls.TLSSocket(wsStream, { isServer: true, secureContext: TLS_BRIDGE_CTX || undefined, SNICallback: sniSelect });
    tlsSock._appDepId = fullId;                               // the internal server reads this to pin req.url
    const close = () => { try { ws.close(); } catch {} try { tlsSock.destroy(); } catch {} };
    wsStream.on("error", close); wsStream.on("close", close); tlsSock.on("error", close);
    internalAppServer.emit("connection", tlsSock);            // Node parses HTTP off the decrypted stream
  });
}

// bridge a WebSocket to a local TCP port, binary frames both ways
function wsTcpBridge(req, socket, head, port) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const tcp = net.connect(port, "127.0.0.1");
    const close = () => { try { ws.close(); } catch {} try { tcp.destroy(); } catch {} };
    tcp.on("connect", () => {
      ws.on("message", (d) => tcp.write(d));
      tcp.on("data", (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    });
    ws.on("close", close); ws.on("error", close);
    tcp.on("close", close); tcp.on("error", close);
  });
}

// like wsTcpBridge, but the frames carry the CLIENT's TLS session: unwrap it
// here (key never leaves the enclave) and pipe cleartext to the app's loopback
// port. The app still speaks plain TCP; TLS is platform dressing on top.
function wsTlsBridge(req, socket, head, port) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const wsStream = createWebSocketStream(ws);
    // SNI naming a managed ACME cert gets THAT cert (CA-signed, browser-green);
    // everything else keeps the pin-verified self-signed bridge pair.
    const tlsSock  = new tls.TLSSocket(wsStream, { isServer: true, secureContext: TLS_BRIDGE_CTX, SNICallback: sniSelect });
    const tcp = net.connect(port, "127.0.0.1");
    const close = () => { try { ws.close(); } catch {} try { tlsSock.destroy(); } catch {} try { tcp.destroy(); } catch {} };
    tlsSock.pipe(tcp); tcp.pipe(tlsSock);
    for (const s of [wsStream, tlsSock, tcp]) { s.on("error", close); s.on("close", close); }
  });
}

// UDP bridge: one WebSocket carries one client's datagram flow. WebSocket
// messages are already framed, so 1 binary message == 1 datagram, both ways —
// no length prefixing. Each flow gets its own loopback dgram socket toward the
// app's actual port, so replies fan back to the right client. UDP has no close,
// so an idle timer tears the flow down.
const UDP_IDLE_MS = parseInt(process.env.UDP_IDLE_MS || "120000", 10);
function wsUdpBridge(req, socket, head, port) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const udp = dgram.createSocket("udp4");
    let timer = null;
    const close = () => { clearTimeout(timer); try { ws.close(); } catch {} try { udp.close(); } catch {} };
    const bump = () => { clearTimeout(timer); timer = setTimeout(close, UDP_IDLE_MS); };
    ws.on("message", (d, isBinary) => { if (isBinary) { udp.send(d, port, "127.0.0.1"); bump(); } });
    udp.on("message", (d) => { if (ws.readyState === ws.OPEN) { ws.send(d); bump(); } });
    ws.on("close", close); ws.on("error", close); udp.on("error", close);
    bump();
  });
}

server.on("upgrade", async (req, socket, head) => {
  const deny = (line) => { socket.write(`HTTP/1.1 ${line}\r\n\r\n`); socket.destroy(); };

  // dedicated-IP egress: the relay's control channel (/v1/egress-control) and
  // per-connection data streams (/x/egress/<cid>). Both are relay-token gated
  // inside handleUpgrade; it returns true once it owns the path.
  if (egress && egress.handleUpgrade(req, socket, head)) return;

  // ---- app HTTPS: /x/:id/https — the browser's TLS, terminated IN-ENCLAVE ----
  // The passthrough relay tunnels the raw TLS bytes of <label>.APP_CERT_DOMAIN
  // sessions here. Prefix ids resolve like the HTTP path (the subdomain label
  // IS a prefix); public websites only — private deployments keep the
  // token-gated relay-terminated path, so nothing is lost by the 403.
  const hx = (req.url || "").match(/^\/x\/([^/?]+)\/https(?:\?|$)/);
  if (hx) {
    const rec = depByIdOrPrefix(hx[1]);
    if (!rec)                                   return deny("404 Not Found");
    if (!rec.public)                            return deny("403 Forbidden");
    if (rec.status !== "running")               return deny("409 Conflict");
    if (!TLS_BRIDGE_CTX && !acmeCerts.size)     return deny("503 Service Unavailable"); // no context could complete a handshake
    return wsHttpsBridge(req, socket, head, rec.id);
  }

  // ---- app TCP ports: /x/:id/(tcp|tls)/:port — the declared-firewall data path ----
  // Auth follows the deployment's `public` flag (like the HTTP path). Two gates
  // before bridging: the port must be DECLARED in the firewall config, and the
  // manager must confirm THIS app actually bound it (boundPorts) — otherwise a
  // tenant could declare-but-not-bind a port and bridge into a sibling's socket.
  // /tls/ is the same data path except the supervisor terminates the client's
  // TLS in-enclave first (see wsTlsBridge) — it's what the public relay targets.
  // A declared "tcp:N" serves both flavors; there is no separate tls: entry.
  const t = (req.url || "").match(/^\/x\/([^/?]+)\/(tcp|tls)\/(\d{1,5})(?:\?|$)/);
  if (t) {
    const rec = deployments.get(t[1]), mode = t[2], port = +t[3]; // `port` is the LOGICAL port (the app's advertised one)
    if (!rec)                                 return deny("404 Not Found");
    if (mode === "tls" && !TLS_BRIDGE_CTX)    return deny("503 Service Unavailable");
    if (!fwTcpPorts(rec).includes(port))      return deny("404 Not Found");
    if (!rec.public) {
      const addr = await authUpgrade(req);
      if (!addr)              return deny("401 Unauthorized");
      if (rec.owner !== addr) return deny("403 Forbidden");
    }
    if (rec.status !== "running" || !rec._vmId) return deny("409 Conflict");
    // resolve logical -> actual bind for THIS deployment (two tenants can both be
    // "the 5432 app"; each has its own actual port), then confirm the app bound it.
    const actual = (rec.portMap && rec.portMap["tcp:" + port]) || port;
    const vr = await vmReq("GET", `/vms/${encodeURIComponent(rec._vmId)}`).catch(() => null);
    const bound = (vr && vr.body && vr.body.boundPorts) || [];
    if (!bound.includes(actual)) return deny("409 Conflict");   // app hasn't bound it (yet)
    return (mode === "tls" ? wsTlsBridge : wsTcpBridge)(req, socket, head, actual);
  }

  // ---- app UDP ports: /x/:id/udp/:port — datagrams tunneled over the WS ----
  // Same gates as the tcp path (declared + bound), but bridged as datagrams.
  // The udp-relay routes here by the deployment's per-tenant IPv6, so it only
  // reaches public deployments; private udp is not exposed in v1.
  const u = (req.url || "").match(/^\/x\/([^/?]+)\/udp\/(\d{1,5})(?:\?|$)/);
  if (u) {
    const rec = deployments.get(u[1]), port = +u[2];
    if (!rec)                            return deny("404 Not Found");
    if (!fwUdpPorts(rec).includes(port)) return deny("404 Not Found");
    if (!rec.public) {
      const addr = await authUpgrade(req);
      if (!addr)              return deny("401 Unauthorized");
      if (rec.owner !== addr) return deny("403 Forbidden");
    }
    if (rec.status !== "running" || !rec._vmId) return deny("409 Conflict");
    const actual = (rec.portMap && rec.portMap["udp:" + port]) || port;
    const vr = await vmReq("GET", `/vms/${encodeURIComponent(rec._vmId)}`).catch(() => null);
    const bound = (vr && vr.body && vr.body.boundPorts) || [];
    if (!bound.includes(actual)) return deny("409 Conflict");
    return wsUdpBridge(req, socket, head, actual);
  }

  socket.destroy();
});

// ============================================================================
// portable deployments — the EnclaveDeployments claim loop (see contracts/DEPLOYMENTS.md)
// ============================================================================
// Deployments created on-chain are work items on a queue: this enclave CLAIMS
// one (burning a bounded lease from its funded balance), serves it through the
// exact same provisioning path as HTTP deploys, RENEWs while healthy, and
// RELEASEs on graceful teardown (refunding the unused tail). If we die
// silently, the lease expires on its own and any other enclave picks the
// deployment up — at-most-one-runner is enforced by the contract, not by us.
// Signing uses REGISTRY_PRIVATE_KEY: claims are gated to the operator of our
// registry entry, so advertising (registerOnChain) is a hard prerequisite.
// (DEPLOYMENTS_ADDRESS is a live binding from ./addressbook.js)
const CLAIM_ENABLED    = /^(1|true|on)$/i.test(process.env.CLAIM_ENABLED || "");
const CLAIM_POLL_SEC   = parseInt(process.env.CLAIM_POLL_SEC || "60", 10);    // sweep + audit + renew cadence
const RENEW_MARGIN_SEC = parseInt(process.env.RENEW_MARGIN_SEC || "300", 10); // renew when less lease than this remains
// CPU-only work prefers CPU-only enclaves: a GPU enclave waits this long after
// a CPU-only deployment becomes claimable (created, or its last lease expired)
// before bidding, so CPU enclaves get first claim and GPU leftovers stay a
// fallback rather than the default home.
const CPU_CLAIM_GRACE_SEC = parseInt(process.env.CPU_CLAIM_GRACE_SEC || "120", 10);
const CLAIM_PAGE = 100;
const CLAIM_READY = CLAIM_ENABLED && !!(DEPLOYMENTS_ADDRESS && REGISTRY_READY && PROVISION_BACKEND === "vm");

// ---- reachability watchdog — impure half ------------------------------------
// (verdict logic + rationale sit with the REACH_SELFTEST seam up top.) Runs as
// the claim tick's first stage: while the advertised hostname is affirmed gone
// from public DNS, this enclave stops claiming, stops renewing, and hands back
// everything it holds so a REACHABLE enclave re-claims it within a sweep. A
// positive resolve clears the trip and the sweep takes work again by itself.
const REACH_DNS_STRIKES = parseInt(process.env.REACH_DNS_STRIKES || "5", 10);   // consecutive "gone" rounds to trip; 0 disables
const REACH_DOH_RESOLVERS = (process.env.REACH_DOH_RESOLVERS
  || "https://cloudflare-dns.com/dns-query,https://dns.google/resolve")
  .split(",").map((s) => s.trim()).filter(Boolean);
const _reach = { strikes: 0, tripped: false, checkedAt: null, host: null };

async function dohQuery(resolver, host, type) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${resolver}?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
    if (!r.ok) return "error";
    return dohVerdict(await r.json());
  } catch { return "error"; }
  finally { clearTimeout(t); }
}

// A resolver affirms "gone" only when BOTH address families are absent; one
// live record of either kind proves public DNS still knows the name.
async function resolverVerdict(resolver, host) {
  const [a, aaaa] = await Promise.all([dohQuery(resolver, host, "A"), dohQuery(resolver, host, "AAAA")]);
  if (a === "resolves" || aaaa === "resolves") return "resolves";
  if (a === "gone" && aaaa === "gone") return "gone";
  return "error";
}

async function reachTick() {
  if (!REACH_DNS_STRIKES || !_advertisedEndpoint) return;
  const host = reachHostname(_advertisedEndpoint);
  if (!host) return;
  const verdicts = await Promise.all(REACH_DOH_RESOLVERS.map((r) => resolverVerdict(r, host)));
  const was = _reach.tripped;
  Object.assign(_reach, reachStep(_reach, verdicts, REACH_DNS_STRIKES), { checkedAt: Date.now(), host });
  if (_reach.tripped && !was) {
    console.warn(`[reach] ${host} is GONE from public DNS (${REACH_DNS_STRIKES} consecutive rounds, all resolvers agree): `
               + `unreachable by name — releasing on-chain work and pausing claims`);
    await abandonClaims("runner unreachable: its advertised endpoint vanished from public DNS");
  } else if (!_reach.tripped && was) {
    console.log(`[reach] ${host} resolves again — resuming claims`);
  } else if (!_reach.tripped && _reach.strikes) {
    console.warn(`[reach] ${host}: public DNS affirms no records (strike ${_reach.strikes}/${REACH_DNS_STRIKES})`);
  }
}

// Hand back EVERYTHING held on-chain — the same teardown the audit applies to
// a lost lease. The work re-queues the moment the release lands; keeping an
// app alive behind a dead front only burns its owner's balance. "expired" is
// CLAIM_TERMINAL, so once DNS returns the sweep may re-claim it right here.
async function abandonClaims(why) {
  for (const rec of [...deployments.values()]) {
    if (!rec._onchain || !["running", "claimed"].includes(rec.status)) continue;
    try { await stopContainer(rec); } catch {}
    if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
    rec.status = "expired"; rec.error = why;      // the owner's evidence (console polls the record)
    releaseLease(rec.id, why).catch(() => {});
  }
  saveStateSoon();
}

// mirrors EnclaveDeployments.Deployment (field order must match the struct
// exactly; schema rev 2)
const DEPLOYMENT_COMPONENTS = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
  { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" },
  { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
// rev-1 ledgers carry a removed sshPubKey string after ports (decoded, ignored)
const DEPLOYMENT_COMPONENTS_V1 = [
  ...DEPLOYMENT_COMPONENTS.slice(0, 4), { name: "sshPubKey", type: "string" }, ...DEPLOYMENT_COMPONENTS.slice(4),
];
const depsAbiFor = (components) => [
  { type: "function", name: "claim", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "renew", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "get", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components }] },
];
// Which struct shape the ledger at DEPLOYMENTS_ADDRESS speaks. The address is
// a LIVE binding (the address-book poll repoints it mid-flight on a contract
// migration), so the sniff is cached PER ADDRESS and re-runs whenever the
// address changes. A boot-once sniff kept the rev-1 ABI after a live repoint
// to a rev-2 ledger (observed 2026-07-13, minutes after the migration cutover:
// every get/getPage misdecoded and claim-hints 502'd). Only get/getPage decode
// depends on the shape - claim/renew/release/claimable use CLAIM_TX_ABI below.
let _depShape = { addr: null, rev: 1, abi: depsAbiFor(DEPLOYMENT_COMPONENTS_V1) };
async function depsAbi() {
  if (!DEPLOYMENTS_ADDRESS || _depShape.addr === DEPLOYMENTS_ADDRESS) return _depShape;
  try {
    const rev = Number(await chainClient.readContract({ address: getAddress(DEPLOYMENTS_ADDRESS),
      abi: [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "deploymentsSchema" }));
    _depShape = { addr: DEPLOYMENTS_ADDRESS, rev,
                  abi: depsAbiFor(rev >= 2 ? DEPLOYMENT_COMPONENTS : DEPLOYMENT_COMPONENTS_V1) };
    console.log(`[claim] ledger ${DEPLOYMENTS_ADDRESS} struct schema rev ${rev}`);
  } catch (e) {
    if (/revert|returned no data|zero data/i.test(e.shortMessage || e.message || "")) {
      _depShape = { addr: DEPLOYMENTS_ADDRESS, rev: 1, abi: depsAbiFor(DEPLOYMENT_COMPONENTS_V1) };
      console.log(`[claim] ledger ${DEPLOYMENTS_ADDRESS} struct schema rev 1 (pre-deploymentsSchema contract)`);
    }
    // transport trouble: don't cache - serve the last known shape this round
    // and re-sniff on the next call
  }
  return _depShape;
}
// tx surface (inputs only, never decodes a Deployment tuple) - shape-independent
const CLAIM_TX_ABI = depsAbiFor(DEPLOYMENT_COMPONENTS);
// Claim/renew receipts carry the post-tx lease in their event - read it from
// THERE, never from a follow-up eth_call: the public RPC's load balancer can
// serve pre-tx state for a minute after confirmation (and rate-limit the read
// outright), and both failure modes made the loop double-renew leases and
// abandon its own freshly-claimed work (observed live 2026-07-05).
const DEPLOYMENT_EVENTS = [
  { type: "event", name: "Claimed", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "enclaveId", type: "bytes32", indexed: true },
    { name: "operator", type: "address", indexed: true }, { name: "leaseUntil", type: "uint64" }, { name: "burned6", type: "uint256" }] },
  { type: "event", name: "Renewed", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "enclaveId", type: "bytes32", indexed: true },
    { name: "leaseUntil", type: "uint64" }, { name: "burned6", type: "uint256" }] },
];
function leaseFromReceipt(rcpt, eventName, id) {
  try {
    const logs = parseEventLogs({ abi: DEPLOYMENT_EVENTS, logs: rcpt.logs, eventName, strict: false });
    const hit = logs.find(l => (l.args.id || "").toLowerCase() === id.toLowerCase());
    return hit ? Number(hit.args.leaseUntil) : null;
  } catch { return null; }
}

// One shared signer (the registry operator EOA) and ONE queue for every tx it
// signs — registry register/heartbeat and ledger claim/renew/release alike.
// The queue serializes through CONFIRMATION, not just send order: public RPCs
// cap EIP-7702-delegated EOAs at a single in-flight tx ("in-flight transaction
// limit reached for delegated accounts"), and even a plain EOA avoids account-
// nonce races this way. A dropped tx can't wedge the queue (receipt wait is
// bounded and failures are swallowed — the caller still sees its own error).
let _claimAccount = null, _claimWallet = null, _txChain = Promise.resolve();
function claimSigner() {
  if (!_claimWallet) {
    _claimAccount = privateKeyToAccount(REGISTRY_PK.startsWith("0x") ? REGISTRY_PK : `0x${REGISTRY_PK}`);
    _claimWallet  = createWalletClient({ account: _claimAccount, chain: base, transport: viemHttp(BASE_RPC, { retryCount: 5, retryDelay: 500 }) });
  }
  return { account: _claimAccount, wallet: _claimWallet };
}
function sendOperatorTx(address, abi, functionName, args) {
  const p = _txChain.then(() => claimSigner().wallet.writeContract({
    address: getAddress(address), abi, functionName, args }));
  const rcptP = p.then((hash) => chainClient.waitForTransactionReceipt({ hash, timeout: 120_000 }));
  _txChain = rcptP.then(() => {}, () => {});   // keep the queue alive across failures
  p.receipt = rcptP;   // callers that need the outcome share the queue's own
  return p;            // receipt wait instead of polling for it a second time
}
const sendClaimTx = (functionName, args) => sendOperatorTx(DEPLOYMENTS_ADDRESS, CLAIM_TX_ABI, functionName, args);
const readOnchainDeployment = async (id) => chainClient.readContract({
  address: getAddress(DEPLOYMENTS_ADDRESS), abi: (await depsAbi()).abi, functionName: "get", args: [id] });

// local rec states that no longer hold the lease — safe to re-adopt over
// "stopping" is the pre-terminated legacy name, kept so records persisted by an
// older supervisor still count as terminal after an upgrade.
const CLAIM_TERMINAL = new Set(["expired", "failed", "terminated", "stopping"]);

// ids that failed provisioning here — exponential claim cooldown (see
// considerClaim). In-memory on purpose: a reboot is a fresh chance.
const _provisionBackoff = new Map();          // id -> { n, until }
function noteProvisionFailure(id) {
  const n = (_provisionBackoff.get(id)?.n || 0) + 1;
  const coolMs = Math.min(60 * 60_000, 5 * 60_000 * 2 ** (n - 1));   // 5m, 10m, 20m … cap 1h
  _provisionBackoff.set(id, { n, until: Date.now() + coolMs });
  return coolMs;
}

// Release with retries, in the background. A failed release strands the lease
// until it expires (~leaseSec of dead air for the user) — observed live when
// the release tx right behind a confirmed claim bounced off the public RPC.
async function releaseLease(id, why) {
  for (let i = 0; i < 4; i++) {
    try {
      const sent = sendClaimTx("release", [id]);
      await sent;
      const rcpt = await sent.receipt;
      if (rcpt.status !== "success") throw new Error("release tx reverted");
      console.log(`[claim] released ${id} (${why})`);
      return true;
    } catch (e) {
      console.warn(`[claim] release ${id} (${why}) attempt ${i + 1}/4 failed: ${e.shortMessage || e.message}`);
      await new Promise(r => setTimeout(r, 15_000 * (i + 1)));
    }
  }
  console.warn(`[claim] release ${id} (${why}) gave up; the lease expires on its own`);
  return false;
}

// Renew every adopted lease that's inside the margin. A failed renew is not
// fatal: "unfunded" means the balance is empty (the reaper will tear down when
// the lease runs out — "processed until there is no more time left"), anything
// else retries next pass (margin >> poll interval).
async function renewLeases() {
  // Unreachable: let stragglers lapse instead of paying to extend them. (A
  // hint-claim provisioning in the background when the watchdog tripped can
  // finish AFTER abandonClaims swept — this catches that record too; the
  // lease runs out within one quantum and the reaper tears it down.)
  if (_reach.tripped) return;
  for (const rec of deployments.values()) {
    if (!rec._onchain || rec.status !== "running" || rec._renewing) continue;
    if (rec._leaseUntil * 1000 - Date.now() > RENEW_MARGIN_SEC * 1000) continue;
    rec._renewing = true;
    try {
      const sent = sendClaimTx("renew", [rec.id]);
      await sent;
      const rcpt = await sent.receipt;
      if (rcpt.status !== "success") throw new Error("renew tx reverted");
      // the Renewed event IS the new lease - a follow-up read can be stale or
      // rate-limited, and a missed update here renews AGAIN next tick, burning
      // an extra quantum of the user's money every cycle (observed live)
      const until = leaseFromReceipt(rcpt, "Renewed", rec.id);
      if (until == null) throw new Error("renew receipt carried no Renewed event");
      // the renewal moved one quantum from balance into the lease; mirror that
      // locally so lease+balance (the reported time left) doesn't jump between
      // audit refreshes
      rec._balance6 = Math.max(0, (rec._balance6 || 0) - Math.round(Math.max(0, until - rec._leaseUntil) * rec.rate * 1e6));
      rec._leaseUntil = until;
      rec.remainingMs = rec._leaseUntil * 1000 - Date.now();
      console.log(`[claim] ${rec.id} lease renewed until ${new Date(rec._leaseUntil * 1000).toISOString()}`);
      saveStateSoon();
    } catch (e) {
      console.warn(`[claim] renew ${rec.id} failed (${e.shortMessage || e.message}); `
                 + `lease expires ${new Date(rec._leaseUntil * 1000).toISOString()}`);
    } finally { rec._renewing = false; }
  }
}

// Split-brain guard + owner-stop watcher + crash recovery. The chain is the
// source of truth: if we no longer hold the lease, stop serving (the new runner
// is attested identically and app state is ephemeral by design); if the owner
// deactivated, tear down AND release so the tail refunds; if we crashed between
// claim and provision (status "claimed"), finish the job or hand it back.
async function auditClaims(ledgerById) {
  const me = claimSigner().account.address.toLowerCase();
  for (const rec of [...deployments.values()]) {
    if (!rec._onchain || !["running", "claimed"].includes(rec.status)) continue;
    // the tick already paged the whole ledger once - one read serves the audit
    // AND the sweep (per-record re-reads were what blew the RPC rate budget)
    const d = ledgerById.get(rec.id.toLowerCase());
    if (!d) continue;                         // not in the page (RPC anomaly): keep serving, the lease is prepaid
    rec.paidUsdc = Number(d.spent6 + d.balance6);
    rec._balance6 = Number(d.balance6);          // funded-runtime display: balance beyond the current lease
    // OWNERSHIP is keyed on the ENCLAVE ID (d.runner === _enclaveId), matching the
    // sweep (considerClaim) and the resume path — NOT on runnerOperator. On a
    // SHARED gas key several enclaves sign as the same operator EOA but have
    // distinct enclave ids; keying on the operator made each of them think it owned
    // the OTHER's live-leased deployments (split-brain double-serve/double-renew).
    // runnerOperator stays available below only as a lagging-RPC fallback signal,
    // never as the sole ownership test.
    const mine = d.runner === _enclaveId
              && Number(d.leaseUntil) * 1000 > Date.now();
    if (!d.active) {
      console.log(`[claim] ${rec.id} stopped by owner on-chain -> teardown + release`);
      try { await stopContainer(rec); } catch {}
      if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
      rec.status = "terminated";
      if (mine) releaseLease(rec.id, "owner setActive(false)").catch(() => {});
      saveStateSoon();
    } else if (!mine) {
      // Re-acquire-in-place gate for a LAPSED lease: prefer our own enclave id
      // (matches `mine`); keep the shared-operator match ONLY as an additional
      // fallback for a lagging RPC node that hasn't yet surfaced our fresh claim.
      // This is safe because the branch below is further gated on !leaseLive AND a
      // locally-running tenant, so it can't double-serve another enclave's LIVE lease.
      const opMine = d.runner === _enclaveId || (!!_enclaveId && (d.runnerOperator || "").toLowerCase() === me);
      const leaseLive = Number(d.leaseUntil) * 1000 > Date.now();
      // OUR lease that lapsed (a missed renew, or our own fresh claim not yet
      // visible on a lagging node) around a still-healthy tenant: re-acquire
      // in place. Tearing down a serving app to re-claim it seconds later
      // helps nobody and burns the user's lease.
      if (opMine && !leaseLive && rec.status === "running") {
        try {
          const sent = sendClaimTx("claim", [rec.id, _enclaveId]);
          await sent;
          const rcpt = await sent.receipt;
          const until = rcpt.status === "success" ? leaseFromReceipt(rcpt, "Claimed", rec.id) : null;
          if (until != null) {
            rec._leaseUntil = until;
            rec.remainingMs = rec._leaseUntil * 1000 - Date.now();
            rec._loseStrikes = 0;
            console.log(`[claim] ${rec.id} re-acquired our lapsed lease in place`);
            saveStateSoon();
            continue;
          }
        } catch (e) { /* someone else won it - fall through to the strikes */ }
      }
      // Public RPC nodes can serve STALE state right after a confirmation
      // (observed live: an audit pass read the pre-claim lease one minute
      // after our own claim and tore down a freshly provisioned tenant).
      // One read never kills a serving tenant: it takes two consecutive
      // audit passes agreeing that the lease is lost.
      rec._loseStrikes = (rec._loseStrikes || 0) + 1;
      if (rec._loseStrikes < 2) {
        console.log(`[claim] ${rec.id} lease looks lost (strike 1/2; chain says runner=${d.runnerOperator}, leaseUntil=${d.leaseUntil}); re-checking next pass`);
        continue;
      }
      console.log(`[claim] ${rec.id} lease lost -> teardown (chain says runner=${d.runnerOperator})`);
      try { await stopContainer(rec); } catch {}
      if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
      rec.status = "expired";                 // sweep may legitimately re-claim it later
      saveStateSoon();
    } else if (rec.status === "claimed") {    // crashed after claim, before provision
      rec._loseStrikes = 0;
      if (!(await provisionTenant(rec))) {
        // keep the "failed" record as the owner's evidence (see adopt())
        noteProvisionFailure(rec.id);
        releaseLease(rec.id, "provision failed after crash recovery").catch(() => {});
        saveStateSoon();
      }
    } else {
      rec._loseStrikes = 0;                   // healthy pass: chain agrees the lease is ours
      // Crash recovery for a DIED app instance (fatal signal, OOM-kill): the
      // lease is ours and paid, the wasm is cached - relaunch. Bounded: an
      // app that keeps dying (crash-on-first-request) gets handed back after
      // 3 deaths instead of flapping forever on the owner's dime.
      if (rec.status === "running" && !(await instanceAlive(rec))) {
        rec._deaths = (rec._deaths || 0) + 1;
        if (rec._deaths > 3) {
          console.warn(`[claim] ${rec.id} app died ${rec._deaths}x; giving it back`);
          rec.status = "failed"; rec.error = rec.error || "app process kept dying";
          if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
          noteProvisionFailure(rec.id);
          releaseLease(rec.id, "app kept dying").catch(() => {});
          saveStateSoon();
          continue;
        }
        console.warn(`[claim] ${rec.id} app instance died; relaunching (death ${rec._deaths}/3)`);
        try { if (rec._vmId) await vmReq("DELETE", `/vms/${encodeURIComponent(rec._vmId)}`, null, 15000).catch(() => {}); } catch {}
        rec.status = "claimed";               // provision path's input state
        if (!(await provisionTenant(rec))) {
          noteProvisionFailure(rec.id);
          releaseLease(rec.id, "relaunch after app death failed").catch(() => {});
        }
        saveStateSoon();
      }
    }
  }
}

// One paged read of the whole ledger per tick, shared by the audit and the
// sweep - the per-stage reads it replaces were enough burst to trip the public
// RPC's per-IP rate limit, which killed the tail of every pass (the sweep)
// while the head (renewals) kept working: new deployments sat unclaimed for
// hours with all gauntlet conditions green (observed live 2026-07-05).
async function fetchLedger() {
  const all = [];
  for (let start = 0n; ; start += BigInt(CLAIM_PAGE)) {
    const page = await chainClient.readContract({ address: getAddress(DEPLOYMENTS_ADDRESS),
      abi: (await depsAbi()).abi, functionName: "getPage", args: [start, BigInt(CLAIM_PAGE)] });
    all.push(...page);
    if (page.length < CLAIM_PAGE) break;
  }
  return all;
}

// Sweep the ledger for claimable work this enclave can actually serve: funded,
// unleased, fits our free capacity, passes the same catalog-approval gate as
// HTTP deploys (fail closed). Checked BEFORE claiming so we never burn a
// user's lease on something we can't run. Decline reasons are LOGGED on
// change: a silent decline loop is indistinguishable from a dead sweep from
// outside the enclave, and it took chain forensics to tell them apart once.
const _sweepDeclines = new Map();             // id -> last logged reason
let _resumeHoldLogged = "";                   // last logged hold reason (log on change)
async function claimSweep(ledger) {
  if (!(await backendHealthy())) return;      // don't take work we'd immediately fail
  const sweepOne = async (d) => {
    let reason;
    try { reason = await considerClaim(d); }
    catch (e) { reason = "error: " + (e.shortMessage || e.message); }   // one bad item must not end the pass
    if (!reason) { _sweepDeclines.delete(d.id); return null; }          // a claim was attempted
    if (reason !== _sweepDeclines.get(d.id) && !reason.startsWith("already serving")) {
      console.log(`[claim] sweep skips ${d.id}: ${reason}`);
      _sweepDeclines.set(d.id, reason);
    }
    return reason;
  };
  // Own live leases resume FIRST, and an unresumed one holds all new claims
  // this pass — its owner already paid for the slice (see sweepPartition).
  const { own, rest } = sweepPartition(ledger, _enclaveId, Date.now(), (id) => {
    const ex = deployments.get(id);
    return !!ex && !CLAIM_TERMINAL.has(ex.status);
  });
  let hold = null;
  for (const d of own) { const r = await sweepOne(d); if (r) hold ??= `${d.id}: ${r}`; }
  if (hold) {
    if (hold !== _resumeHoldLogged) {
      console.log(`[claim] holding new claims: own lease not yet resumed (${hold})`);
      _resumeHoldLogged = hold;
    }
    return;
  }
  _resumeHoldLogged = "";
  for (const d of rest) await sweepOne(d);
}

// One deployment through the full claim gauntlet. Returns a reason string
// when we pass (shared by the sweep, which drops it, and POST /v1/claim-hint,
// which surfaces it to the deployer); null/undefined = a claim was attempted.
// `hinted` skips the CPU-first grace and the anti-stampede jitter: a hint is
// the deploying user asking THIS enclave to start their work now. `background`
// fires the claim without awaiting it (claim tx + provision can take tens of
// seconds - an IPFS fetch of a 100MB+ app is part of it - and a hint response
// must not hang that long; the deployer watches the ledger for the runner).
async function considerClaim(d, { hinted = false, background = false } = {}) {
  const ex = deployments.get(d.id);
  if (ex && !CLAIM_TERMINAL.has(ex.status)) return "already serving it here (status " + ex.status + ")";
  // Unreachable enclaves take no work — resumes included: re-provisioning an
  // app behind a dead front burns the owner's lease for service nobody gets.
  if (_reach.tripped) return "this enclave's advertised endpoint is gone from public DNS (unreachable); not claiming";
  if (!d.active) return "deployment is deactivated (owner setActive(false))";
  // A live lease held by OUR OWN enclaveId with no local record = a previous
  // life of this enclave (an update reboot wipes local state and cannot
  // release on-chain). RESUME it instead of leaving the app dark until the
  // lease lapses: we already own the lease, so no claim tx is needed (the
  // contract would refuse one anyway) - adopt + provision directly. This is
  // what makes enclave updates near-seamless for tenants.
  const leaseLive = Number(d.leaseUntil) * 1000 > Date.now();
  const resume = leaseLive && d.runner === _enclaveId;
  if (leaseLive && !resume) return "another enclave holds a live lease";
  if (!resume && d.balance6 < d.rate) return "out of funded time - fund it and retry";
  // configCid is RETIRED: ENCLAVE_CONFIG comes from the approved version's own
  // record (the deploy gate below). A deployment that carries one is refused —
  // silently ignoring it would run something other than what its owner thinks.
  if ((d.configCid || "").trim())
    return "configCid is retired: the app's config comes from the approved catalog version itself — recreate the deployment without a configCid";
  // Routing: the deployment bought two shares. GPU work (gpuMilli > 0)
  // runs ONLY on GPU enclaves and must fit a card AND the node's cpu pool.
  // CPU-only work runs on CPU enclaves immediately; a GPU enclave bids on
  // it only after CPU_CLAIM_GRACE_SEC (CPU enclaves get first claim) and
  // only out of LEFTOVER cpu pool.
  // Back off ids that just failed provisioning HERE: without this a broken
  // app (or a transient local fault) claims / fails / releases in a loop.
  const pf = _provisionBackoff.get(d.id);
  if (pf && Date.now() < pf.until) return "provisioning failed here recently; backing off";
  const gpuShare = Number(d.gpuMilli) / 1000, cpuShare = Number(d.cpuMilli) / 1000;
  let slice;
  if (gpuShare > 0) {
    if (!IS_GPU) return "GPU work on a CPU-only enclave";
    // Don't claim GPU work the manager would 503: right after a boot the CUDA
    // readiness probe is still running, and a claim during that window burns
    // the user's lease on a doomed provision (observed live 2026-07-05:
    // claim -> 503 warming up -> failed release -> lease stranded 30 min).
    const h = await vmHealth().catch(() => null);
    if (!h) return "app manager unreachable";
    if (h.nnProbe && h.nnProbe.state && h.nnProbe.state !== "ok")
      return "GPU interface not ready (CUDA readiness probe: " + h.nnProbe.state + ")";
    slice = normalizeGpuReq(gpuShare, cpuShare);
    if (slice.vramGb > maxFreeVram() + 1e-9 || slice.cpuShare > maxFreeCpu() + 1e-9)
      return "no free capacity for those shares here right now";
  } else {
    if (IS_GPU && !hinted && !resume) {
      const claimableSince = Math.max(Number(d.createdAt), Number(d.leaseUntil));
      if (Date.now() < (claimableSince + CPU_CLAIM_GRACE_SEC) * 1000) return "cpu-first grace";
    }
    slice = normalizeCpuReq(cpuShare);
    if (slice.cpuShare > maxFreeCpu() + 1e-9) return "no free CPU capacity here right now";
  }
  const g = await gateAppReference(d.appRef);
  if (g.error) return "app not deployable: " + g.error.msg;   // unapproved/unknown record (or catalog unreachable: fail closed)
  // the app's catalog specs set its MINIMUM shares on our hardware, gating
  // claims exactly like HTTP deploys: a deployment that bought less than
  // the app needs is nobody's work item
  const mins = minSharesOf(g.min);
  if (gpuShare < mins.gpuShare - 1e-9 || cpuShare < mins.cpuShare - 1e-9)
    return `below the app's minimum shares on this hardware (needs gpuShare ${round3(mins.gpuShare)} / cpuShare ${round3(mins.cpuShare)})`;
  // The firewall is the VERSION's declared ports — part of what approval
  // covered. The deployment's own ports field is ignored (create() still
  // carries it for the ledger's benefit; the record is the authority).
  let firewall;
  try { firewall = parseFirewall({ ports: g.ports ? String(g.ports).split(",") : [] }); }
  catch (e) { return "the version's port spec is not servable here: " + e.message; }
  if (background) {
    tryClaim(d, g, firewall, slice, { hinted, resume })
      .catch(e => console.warn(`[claim] hinted claim ${d.id} failed: ${e.shortMessage || e.message}`));
    return null;
  }
  await tryClaim(d, g, firewall, slice, { hinted, resume });
  return null;
}

// Jitter de-syncs enclaves that saw the same queue state; the claimable()
// re-check catches a claim that landed during the wait without paying for a
// reverted tx. Losing the race anyway costs one reverted tx (cents on Base).
async function tryClaim(d, g, firewall, slice, { hinted = false, resume = false } = {}) {
  if (!hinted && !resume) await new Promise(r => setTimeout(r, Math.random() * 5000));
  // Fetch + verify + cache the app BEFORE burning a lease: the launch's own
  // fetch then hits the manager's local cache instead of racing a 100MB+
  // IPFS transfer against the spawn window, and an unfetchable CID costs the
  // user nothing (no claim ever happens).
  if (PROVISION_BACKEND === "vm" && /^ipfs:\/\//.test(g.wasmRef)) {
    try {
      const r = await vmReq("POST", "/prefetch", { image: g.wasmRef }, 300_000);
      if (r.status !== 200) throw new Error((r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`);
      if (r.body && r.body.seconds > 1) console.log(`[claim] ${d.id} prefetched ${r.body.bytes} bytes in ${r.body.seconds}s`);
    } catch (e) {
      const coolMs = noteProvisionFailure(d.id);
      console.warn(`[claim] ${d.id} prefetch failed (${e.message}); not claiming, backing off ${Math.round(coolMs / 60000)}min`);
      return;
    }
  }
  if (resume) {
    // we already HOLD this lease (a previous life of this enclave claimed
    // it; the reboot wiped local state, not the chain) - no claim tx, just
    // pick the work back up
    console.log(`[claim] ${d.id} resuming our own live lease after a restart`);
    await adopt(d, g, firewall, slice);
    return;
  }
  const open = await chainClient.readContract({ address: getAddress(DEPLOYMENTS_ADDRESS),
    abi: CLAIM_TX_ABI, functionName: "claimable", args: [d.id] });
  if (!open) return;
  let rcpt;
  try {
    const sent = sendClaimTx("claim", [d.id, _enclaveId]);
    await sent;
    rcpt = await sent.receipt;
  } catch (e) { console.log(`[claim] ${d.id} claim tx failed (${e.shortMessage || e.message})`); return; }
  if (rcpt.status !== "success") { console.log(`[claim] ${d.id} lost the race`); return; }
  // The receipt's Claimed event is the proof we won AND the new lease bounds;
  // re-reading the ledger here once handed a stale/rate-limited answer and the
  // loop walked away from its own paid lease (tenant dark for a full quantum).
  const until = leaseFromReceipt(rcpt, "Claimed", d.id);
  if (until == null) {   // success receipt without our event: should be impossible - refund rather than strand
    console.warn(`[claim] ${d.id} claim confirmed but no Claimed event found; releasing`);
    releaseLease(d.id, "claim receipt unreadable").catch(() => {});
    return;
  }
  await adopt({ ...d, leaseUntil: BigInt(until), runner: _enclaveId,
                runnerOperator: claimSigner().account.address }, g, firewall, slice);
}

// On-chain record -> local rec, then the SAME provisioning path as HTTP deploys.
// rec.id IS the on-chain id, so the data path (/x/:id, tcp bridge, udp address)
// and clients resolving id -> runner -> endpoint from chain state need no
// mapping. rec.owner is the on-chain owner address — SIWE tokens already carry
// an address, so owner-only routes (status, delete) work unchanged.
async function adopt(d, g, firewall, slice) {
  if (deployments.has(d.id)) deployments.delete(d.id);      // terminal leftover from an earlier lease
  const gpu = slice.cpu ? allocCpu(slice.cpuShare) : allocGpu(slice.vramGb, slice.computeShare, slice.cpuShare);
  if (!gpu) {                                                // capacity vanished since the sweep checked
    releaseLease(d.id, "capacity vanished").catch(() => {}); // hand it back with the lease refunded
    return;
  }
  // the version's declared http:N entry is the app port; the record decides
  // (create()'s appPort field, like its ports field, is not consulted)
  const httpFw = firewall.find((x) => x.startsWith("http:"));
  const appPort = httpFw ? +httpFw.slice(5) : 8080;
  const rec = {
    id: d.id, owner: getAddress(d.owner), status: "claimed", public: d.isPublic, firewall,
    // image.reference is the CATALOG RECORD (the deployment's identity — the
    // dashboard shows app.slug:app.version from it); the wasm CID in appWasm
    // is only the manager's fetch address
    image: { reference: g.ref }, command: [],
    app: g.app, appWasm: g.wasmRef, config: g.config || "",
    // the two shares the deployment bought on-chain
    resources: slice.cpu
      ? { gpuShare: 0, cpuShare: slice.cpuShare }
      : { gpuShare: slice.gpuShare, cpuShare: slice.cpuShare, cardId: gpu.cardId },
    network: { port: appPort, protocol: "https", endpoint: `${_advertisedEndpoint}/x/${d.id}` },
    attestation: { available: true, vmTechnology: vmTech(), gpuTechnology: IS_GPU ? "nvidia-cc" : null, href: `/v1/deployments/${d.id}/attestation` },
    region: "tinfoil", createdAt: new Date(Number(d.createdAt) * 1000).toISOString(), startedAt: null,
    // the local clock only mirrors the CURRENT lease; the chain holds the rest
    remainingMs: Number(d.leaseUntil) * 1000 - Date.now(), consumedMs: 0,
    paused: false, pauseReason: null, _lastTickAt: Date.now(),
    rate: Number(d.rate) / 1e6, paidUsdc: Number(d.spent6 + d.balance6),
    // on a fresh claim this page read predates the claim tx, so it still counts
    // the quantum the claim just burned - the next audit pass (~CLAIM_POLL_SEC)
    // corrects it; the resume path is exact
    _balance6: Number(d.balance6),
    _onchain: true, _leaseUntil: Number(d.leaseUntil), _renewing: false,
    _gpu: gpu, _gpuSpec: gpu.cpu ? null : { cardId: gpu.cardId, cardUuid: gpuCards[gpu.cardId]?.uuid || null, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare },
    _port: 0, _payTimer: null,
  };
  deployments.set(rec.id, rec); saveStateSoon();
  if (await provisionTenant(rec)) {
    console.log(`[claim] ${rec.id} adopted: app=${g.app.slug}:${g.app.version} (${g.ref}) gpuShare=${round3(slice.gpuShare || 0)} cpuShare=${round3(slice.cpuShare)} `
              + `lease until ${new Date(rec._leaseUntil * 1000).toISOString()}`);
  } else {
    // launch failed (bad wasm, manager 503, spawn timeout, ...): hand the
    // lease back refunded and back off this id here. KEEP the failed record -
    // provisionTenant stamped status "failed" + rec.error, and that record is
    // the owner's only evidence of WHY (the console polls it). "failed" is in
    // CLAIM_TERMINAL, so any enclave (this one included) may still re-adopt.
    const coolMs = noteProvisionFailure(rec.id);
    console.warn(`[claim] provision failed for ${rec.id} (${rec.error || "?"}); backing off ${Math.round(coolMs / 60000)}min here`);
    releaseLease(rec.id, "provision failed").catch(() => {});
  }
  saveStateSoon();
}

// Graceful shutdown: release every held lease (refunds the unused tail and
// reopens the queue immediately) with a hard 10s cap so a dead RPC can't hang
// the exit. GPU handles are freed so a restart doesn't re-reserve ghosts.
let _shutdownReleased = false;
async function releaseClaimsOnShutdown() {
  if (_shutdownReleased) return; _shutdownReleased = true;
  const mine = [...deployments.values()].filter(r => r._onchain && ["running", "claimed"].includes(r.status));
  if (!mine.length || !CLAIM_READY) return;
  console.log(`[claim] shutdown: releasing ${mine.length} lease(s)`);
  await Promise.race([
    Promise.allSettled(mine.map(async (rec) => {
      rec.status = "terminated";     // this enclave's instance dies with the CVM; the on-chain deployment stays claimable
      if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
      await sendClaimTx("release", [rec.id]);
    })),
    new Promise(r => setTimeout(r, 10_000)),
  ]);
  saveStateNow();
}

let _claimBusy = false;
function startClaimLoop() {
  if (!CLAIM_ENABLED) return;
  if (!CLAIM_READY) {
    console.warn("[claim] CLAIM_ENABLED but not claimable: needs DEPLOYMENTS_ADDRESS, registry advertising "
               + "(REGISTRY_ENABLED/ADDRESS/PRIVATE_KEY/ENCLAVE_REPO), and PROVISION_BACKEND=vm — not claiming");
    return;
  }
  // Each stage runs in its own catch: renewals, the audit and the sweep are
  // independent duties, and a throw in an early stage starving the later ones
  // is exactly how the sweep silently died for hours (rate-limited RPC call
  // in the audit -> shared catch -> claimSweep never ran, renews fine).
  const stage = async (name, fn) => {
    try { await fn(); }
    catch (e) { console.warn(`[claim] ${name} failed: ${e.shortMessage || e.message}`); }
  };
  const t = setInterval(async () => {
    if (_claimBusy || !_enclaveId) return;   // not advertised yet, or a slow pass is still running
    _claimBusy = true;
    try {
      await stage("reach", reachTick);       // first: renew/sweep below consult the verdict
      await stage("renew", renewLeases);
      let ledger = null;
      try { ledger = await fetchLedger(); }
      catch (e) { console.warn(`[claim] ledger read failed: ${e.shortMessage || e.message}`); }
      if (ledger) {
        const byId = new Map(ledger.map(d => [String(d.id).toLowerCase(), d]));
        await stage("audit", () => auditClaims(byId));
        await stage("sweep", () => claimSweep(ledger));
      }
    } finally { _claimBusy = false; }
  }, CLAIM_POLL_SEC * 1000);
  if (t.unref) t.unref();
  console.log(`[claim] loop on: ${DEPLOYMENTS_ADDRESS} every ${CLAIM_POLL_SEC}s (renew margin ${RENEW_MARGIN_SEC}s)`);
}

// Funding instructions for a claimed deployment: top-ups go to the ledger
// contract (credited on-chain), NOT to EnclavePay — same EIP-3009 shape, different
// receiver, and the nonce binds to the on-chain id.
function onchainPaymentInstructions(rec) {
  return {
    chainId: CHAIN_ID, asset: "USDC", assets: ["USDC", "ETH"], usdc: USDC_ADDRESS,
    contract: DEPLOYMENTS_ADDRESS || null,
    deploymentRef: rec.id,                    // the bytes32 id to pass to fundWithAuthorization() / fundEth()
    ratePerSecondUsdc: (rec.rate || 0).toFixed(7),
    method: "fundWithAuthorization(bytes32 id, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
    payEthMethod: "fundEth(bytes32 id) payable",
    usdcDomain: _usdcDomain,
    ethUsd: _ethUsd.price8 ? (Number(_ethUsd.price8) / 1e8).toFixed(2) : null,
    note: "On-chain deployment: fund EnclaveDeployments directly. USDC (EIP-3009, no approve): sign a USDC "
        + "ReceiveWithAuthorization (EIP-712, to = the EnclaveDeployments contract, nonce = first 16 bytes of the "
        + "deployment id + 16 random bytes), then anyone submits fundWithAuthorization; amount(6dp)/rate = seconds. "
        + "ETH: fundEth(id) with msg.value; credited on-chain at the live Chainlink ETH/USD rate.",
  };
}

server.listen(PORT, () => console.log(`enclave supervisor on :${PORT} · ${IS_GPU
  ? `${GPU_COUNT}×GPU @ ${CARD_VRAM_GB}GB (arbitrary split)`
  : `CPU-only enclave (${NODE_VCPUS} vCPU / ${NODE_RAM_GB}GB, node-share split)`}`));
// warm the CPU-TEE detection (shim loopback) so the first deployment record
// created after boot already reports the real silicon, not null
fetchEnclaveRad().then(() => console.log(`[attest] CPU TEE detected: ${vmTech()}`)).catch(() => {});
if (egress) { egress.start(); console.log(`[egress] dedicated-IP egress on (SOCKS 127.0.0.1:${EGRESS_SOCKS_PORT}); awaiting relay control channel`); }

// advertise this enclave on-chain (opt-in, non-blocking, never fatal)
// If the origin is pinned (PUBLIC_URL), advertise eagerly at boot; otherwise
// discover our public hostname from the shim's loopback TLS cert and register
// eagerly, with the first-external-request middleware above as the fallback.
if (PUBLIC_URL) registerOnChain(PUBLIC_URL);
else if (REGISTRY_READY) advertiseFromShimCert();

// pay-per-deploy: watch the forwarder for payments + fair-billing ticker (drains
// funded time only while healthy; freezes through outages; reaps at -grace)
startPaymentWatcher();
startBillingTicker();

// portable deployments: claim/renew/release on-chain leases (opt-in; see
// contracts/DEPLOYMENTS.md). Requires registry advertising + DEPLOYMENTS_ADDRESS.
startClaimLoop();

// in-enclave ACME: issue + renew per-app browser certs for <label>.APP_CERT_DOMAIN
// (opt-in; a warning-then-no-op unless EAB + domain + DNS API are all configured).
startAcme();

