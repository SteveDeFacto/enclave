// NAN supervisor - the WHOLE service, running INSIDE the Tinfoil enclave behind
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
// One signing SECRET (an enclave secret). One token type: the session JWT the
// browser gets at login is reused as the capability on the data path.
//
// >>> The ONLY thing left to implement for your CVM is spawn/stop/measure below.

import express from "express";
import cors from "cors";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { WebSocketServer, createWebSocketStream } from "ws";
import { verifyMessage, createPublicClient, createWalletClient, http as viemHttp, getAddress, keccak256, toHex, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { SignJWT, jwtVerify } from "jose";
import { Verifier } from "@tinfoilsh/verifier";

// ----------------------------------------------------------------------------
// config
// ----------------------------------------------------------------------------
const PORT           = parseInt(process.env.PORT || "8080", 10);
const SECRET         = new TextEncoder().encode(need("SECRET")); // signs + verifies the session/capability token
const PUBLIC_URL     = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // own shim URL; else derived per-request
const SIWE_DOMAIN    = process.env.SIWE_DOMAIN || "nan.host";
const SIWE_URI       = process.env.SIWE_URI || "https://nan.host";
const CHAIN_ID       = parseInt(process.env.CHAIN_ID || "8453", 10);
const CORS_ORIGINS   = (process.env.CORS_ORIGINS || "https://nan.host").split(",").map(s => s.trim()).filter(Boolean);
// --- pay-per-deploy (no custody): users pay the NanPay forwarder; the supervisor
//     WATCHES it for Paid events and converts each payment to runtime. No held
//     balance, no escrow contract, no key in the enclave that can move funds.
const FORWARDER_ADDRESS  = process.env.FORWARDER_ADDRESS || "";   // NanPay contract (watch-only)
const USDC_ADDRESS       = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
// --- app approval: NanAppCatalog (read-only) is the deploy gate for ALL apps
//     (the image ships no deployable apps of its own). Only the catalog's owner
//     (the EOA that deployed it) can approve/reject a version, by signing a
//     setApproval transaction; an ipfs://<cid> deploy is refused until its
//     version is Approved. Empty = nothing can deploy at all (fail closed).
const APP_CATALOG_ADDRESS = process.env.APP_CATALOG_ADDRESS || "";
const PAYMENT_WINDOW_SEC = parseInt(process.env.PAYMENT_WINDOW_SEC || "600", 10); // unpaid awaiting_payment TTL
const GRACE_SEC          = parseInt(process.env.GRACE_SEC || "90", 10);           // post-expiry grace before teardown
const PAY_POLL_SEC       = parseInt(process.env.PAY_POLL_SEC || "12", 10);        // Base log poll interval
// --- fair billing: funded runtime is a BALANCE, not a wall-clock deadline -----
// remainingMs drains only on ticks where the platform is actually serving:
// supervisor up, backend manager healthy, payment watcher fresh, app instance
// alive. Any outage FREEZES every clock; it resumes on the first healthy tick.
// State is persisted so a supervisor restart freezes (never forfeits) the clock.
const BILL_TICK_SEC      = parseInt(process.env.BILL_TICK_SEC || "15", 10);       // billing/reaper cadence
const WATCHER_STALE_SEC  = Math.max(60, 5 * PAY_POLL_SEC);                        // watcher silence that freezes billing
const STATE_FILE         = process.env.STATE_FILE || "/var/lib/nan/state.json";   // mount a volume here to survive restarts
// manual-billing / pilot: boot deployments WITHOUT waiting for an on-chain payment.
//   AUTO_PROVISION=1            -> every deploy provisions immediately (closed pilot).
//   ADMIN_TOKEN set            -> operator can provision one deployment on demand via
//                                 POST /v1/admin/deployments/:id/provision (x-admin-token).
//   AUTO_PROVISION_HOURS > 0   -> optional safety expiry; 0 = runs until deleted.
const AUTO_PROVISION       = /^(1|true|on)$/i.test(process.env.AUTO_PROVISION || "");
const AUTO_PROVISION_HOURS = parseFloat(process.env.AUTO_PROVISION_HOURS || "0");
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || "";
const BASE_RPC       = process.env.BASE_RPC || "https://mainnet.base.org";
const SESSION_TTL    = parseInt(process.env.SESSION_TTL || "43200", 10); // 12h: long enough to cover a deployment's data-path use
const SSH_USER       = process.env.SSH_USER || "instance"; // login user the supervisor's sshd drops into
const DEFAULT_IMAGE  = process.env.DEFAULT_IMAGE || "debian:bookworm-slim"; // any stock image; sshd is hosted by the supervisor, not the image
// --- worker launch (per-tenant container = the only isolation boundary) ------
const DOCKER_SOCK    = process.env.DOCKER_SOCK || "/var/run/docker.sock";  // Engine API endpoint (mounted into the supervisor)
const MPS_PIPE_DIR   = process.env.CUDA_MPS_PIPE_DIRECTORY || "/tmp/nvidia-mps";
const ENABLE_MPS     = !/^(0|false|off)$/i.test(process.env.ENABLE_MPS || "1"); // MPS enforces BOTH the SM cap and the VRAM cap (validated under CC)
const WORKER_PREFIX  = process.env.WORKER_PREFIX || "nan_";
const SPAWN_TIMEOUT_MS = parseInt(process.env.SPAWN_TIMEOUT_MS || "180000", 10); // includes image pull
const WORKER_MEM      = process.env.WORKER_MEM || "16g";                // host-RAM cap per worker (not GPU)
const WORKER_PIDS     = process.env.WORKER_PIDS || "512";
// ---- worker MANAGER (Layer 2/3) --------------------------------------------
// The GPU container runs a manager that forks one MPS-capped CHILD PROCESS per
// tenant. The supervisor routes deploys/submissions HERE instead of creating
// containers itself (Tinfoil forbids runtime container creation). Reachable over
// the enclave-local network; default loopback.
const WORKER_MGR_URL  = (process.env.WORKER_MGR_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
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
        headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) } },
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
  return r.body;
}

// --- app manager client ("vm" backend on VMMGR_URL; the wasm-manager) --------
function vmReq(method, path, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(VMMGR_URL + path);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: timeoutMs,
        headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) } },
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
  return r.body;
}

// ---- on-chain discovery: self-register in NanRegistry (no trusted gateway) --
// On boot the enclave publishes itself (endpoint + attestation repo) to the
// registry contract on Base, then heartbeats. Callers read the registry from
// any RPC and connect DIRECTLY, verifying attestation themselves. Entirely
// opt-in: if REGISTRY_ENABLED isn't set, the enclave just doesn't advertise.
const REGISTRY_ENABLED  = /^(1|true|on)$/i.test(process.env.REGISTRY_ENABLED || "");
const REGISTRY_ADDRESS  = process.env.REGISTRY_ADDRESS || "";
const REGISTRY_PK       = process.env.REGISTRY_PRIVATE_KEY || "";        // operator key (enclave secret); needs a little Base ETH for gas
const ENCLAVE_REPO      = process.env.ENCLAVE_REPO || "";                // e.g. "SteveDeFacto/nan" - what callers attest against; MUST match GitHub's canonical casing (Sigstore compares it verbatim)
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
let _enclaveId = null;            // our NanRegistry id (keccak256 of the advertised endpoint); claim gating needs it
let _advertisedEndpoint = null;   // the endpoint we registered under; adopted deployments build their URL from it
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
// The sandbox sshd host key is GENERATED ONCE AT BOOT inside the enclave and
// measured into a TDX RTMR (see initSshHostKey) - so its fingerprint is
// attestation-bound without baking a key into any image, and one fingerprint
// covers every instance. These are set at runtime, never from env.
let SSH_HOST_KEY_PATH = null;
let SSH_HOST_KEY_FP   = "SHA256:<pending-boot>";

function need(n){ const v = process.env[n]; if(!v){ console.error("FATAL: missing env", n); process.exit(1);} return v; }

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
const CPU_RATE        = 0.0005556;                                      // USDC/sec, the WHOLE node's vCPU+RAM ($2.00/hr)
const FULL_RATE       = 0.0016667;                                      // USDC/sec, a WHOLE card ($6.00/hr)
const GPU_COUNT       = parseInt(process.env.GPU_COUNT || "1", 10);     // cards in this enclave; 0 = CPU-only enclave
// GPU work (gpuShare > 0) runs ONLY on GPU-enabled enclaves. CPU-only work runs
// on CPU-only enclaves first, and on GPU enclaves out of leftover cpu pool.
const IS_GPU          = GPU_COUNT > 0;
const NODE_VCPUS      = parseInt(process.env.NODE_VCPUS || "16", 10);   // node size, for CPU pricing/readouts
const NODE_RAM_GB     = parseInt(process.env.NODE_RAM_GB || "64", 10);
const NODE_GFLOPS     = parseFloat(process.env.NODE_GFLOPS || "")       // CPU compute per node in GFLOPS (16 vCPU ≈ 1000)
                     || parseFloat(process.env.NODE_TFLOPS || "1") * 1000; // legacy env name (was TFLOPS-denominated)
const CARD_VRAM_GB    = parseFloat(process.env.GPU_VRAM_GB || "141");   // usable VRAM per card
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
// the CPU slice at the whole-node rate (mirrors NanDeployments' rate formula).
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

// wait until the Docker Engine socket answers (it may not be ready at boot).
async function waitForDocker(tries = 20, gapMs = 500) {
  for (let i = 0; i < tries; i++) {
    try { const r = await dockerReq("GET", "/version", null, 3000); if (r.status < 400) return true; } catch {}
    await new Promise(r => setTimeout(r, gapMs));
  }
  return false;
}

const _applyGpu = (text) => {
  let got = 0;
  for (const line of text.trim().split("\n")) {
    const [idx, uuid, memMiB] = line.split(",").map(s => s.trim());
    const i = parseInt(idx, 10);
    if (gpuCards[i] && /^GPU-/.test(uuid || "")) {
      gpuCards[i].uuid = uuid; got++;
      const totalGb = parseFloat(memMiB) / 1024;
      if (totalGb > 0) console.log(`[gpu] card ${i} ${uuid} (${totalGb.toFixed(0)}GB)`);
    }
  }
  return got;
};
const GPU_QUERY = ["nvidia-smi", "--query-gpu=index,uuid,memory.total", "--format=csv,noheader,nounits"];

// Discover card UUIDs (so workers can be pinned). Supervisor image has no
// nvidia-smi, so enumerate via a one-shot CUDA container over the Docker API.
async function discoverGpus() {
  if (/^(1|true|on)$/i.test(process.env.MOCK_SPAWN || "")) return 0;
  // fast path: local nvidia-smi if present
  try { const { stdout } = await pexec("nvidia-smi", GPU_QUERY.slice(1), { timeout: 8000 });
        const n = _applyGpu(stdout); if (n >= GPU_COUNT) return n; } catch {}
  const ref = process.env.GPU_SCAN_IMAGE || "nvidia/cuda:12.6.2-base-ubuntu24.04";
  const name = WORKER_PREFIX + "gpuscan";
  try {
    await dockerPull(ref);
    await dockerReq("DELETE", `/containers/${name}?force=1`).catch(() => {});
    const created = await dockerJson("POST", `/containers/create?name=${name}`, {
      Image: ref, Cmd: GPU_QUERY,
      HostConfig: { DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }] },
    });
    const cid = created.Id;
    await dockerJson("POST", `/containers/${cid}/start`);
    await dockerReq("POST", `/containers/${cid}/wait`, null, 30000);
    const r = await dockerReq("GET", `/containers/${cid}/logs?stdout=1&stderr=1`);
    await dockerReq("DELETE", `/containers/${cid}?force=1`).catch(() => {});
    return _applyGpu(demuxLogs(r.buf));
  } catch (e) {
    console.warn("[gpu] UUID discovery via docker failed:", e.message);
    return 0;
  }
}

// Lazily ensure UUIDs are known before a GPU spawn - covers a boot-time socket
// race where discovery ran before the Docker socket was ready.
let _gpuDiscovering = null;
async function ensureGpuUuids() {
  if (gpuCards.every(c => c.uuid)) return true;
  if (!_gpuDiscovering) _gpuDiscovering = (async () => { await waitForDocker(); return discoverGpus(); })()
    .finally(() => { _gpuDiscovering = null; });
  await _gpuDiscovering;
  return gpuCards.some(c => c.uuid);
}

async function initGpu() {
  // Best-effort at boot; the socket may not be up yet, so wait briefly. If it
  // still fails, ensureGpuUuids() retries on the first spawn. Never blocks boot.
  await waitForDocker();
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

async function initSshHostKey() {
  // Generate the sandbox sshd host key ONCE, in-enclave. Every per-deployment
  // sshd the supervisor starts uses THIS key, so a single fingerprint covers all
  // instances and is verifiable against attestation. No key is baked into any
  // image. Resilient: if ssh-keygen is absent (local dev), boot continues with a
  // placeholder fingerprint.
  try {
    const dir  = mkdtempSync(join(tmpdir(), "nan-hostkey-"));
    const path = join(dir, "ssh_host_ed25519_key");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", "nan-host", "-f", path]);
    const out  = execFileSync("ssh-keygen", ["-lf", `${path}.pub`]).toString(); // "256 SHA256:… comment (ED25519)"
    SSH_HOST_KEY_PATH = path;
    SSH_HOST_KEY_FP   = (out.match(/SHA256:\S+/) || ["SHA256:<unknown>"])[0];
    // Tinfoil exposes no guest RTMR-extend, so this key cannot be folded into a
    // hardware register; getMeasurements() reports it as measured:false
    // (asserted by attested code) rather than pretending otherwise.
  } catch (e) {
    console.warn("ssh host key not generated (ssh-keygen missing?):", e.message);
  }
}

const chainClient = createPublicClient({ chain: base, transport: viemHttp(BASE_RPC) });

// ----------------------------------------------------------------------------
// state (in-process; this service is the single enclave instance)
// ----------------------------------------------------------------------------
const nonces     = new Map(); // nonce -> { address, exp }
const deployments = new Map(); // id -> record (incl. local container handle)
setInterval(() => { const t = Date.now(); for (const [n,v] of nonces) if (v.exp < t) nonces.delete(n); }, 60_000).unref?.();
const rid = (p) => p + Math.random().toString(36).slice(2, 10);

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

// ---- SSH access ------------------------------------------------------------
// Generate an ed25519 keypair in-enclave via ssh-keygen (correct OpenSSH format).
// privateKey is surfaced to the user exactly ONCE, in the create response.
function generateSshKeypair(label) {
  const dir = mkdtempSync(join(tmpdir(), "nan-ssh-"));
  try {
    const key = join(dir, "id");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", label || "nan", "-f", key]);
    return { privateKey: readFileSync(key, "utf8"), publicKey: readFileSync(key + ".pub", "utf8").trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// SSH rides the one attested origin over a WebSocket (no extra port): /x/:id/ssh.
function sshCommandFor(endpoint) {
  const wss = endpoint.replace(/^https:/i, "wss:") + "/ssh";
  return `ssh -o ProxyCommand='websocat -b ${wss}' ${SSH_USER}@nan`;
}
// public access shape (NEVER includes the private key)
function sshAccessOf(rec) {
  return { user: SSH_USER, command: sshCommandFor(rec.network.endpoint),
           hostKeyFingerprint: SSH_HOST_KEY_FP, keySource: rec._sshKeySource || "generated" };
}

// ============================================================================
// >>> IMPLEMENT THESE for your CVM launch mechanism (e.g. the app manager on
//     VMMGR_URL). Contract: one ingress port, no sibling reach.
//     Tinfoil exposes no guest RTMR-extend, so a launched image's digest cannot
//     be folded into the hardware measurements; /attestation reports exactly
//     that (per-app `coverage` in getMeasurements) instead of implying it.
//     SSH: the sandbox runs ANY stock image and needs NO sshd of its own. The
//     supervisor hosts sshd (measured host key from initSshHostKey); spawn starts
//     a loopback sshd for this deployment using SSH_HOST_KEY_PATH, installs
//     `authorizedKey`, and sets a ForceCommand that exec's into THIS sandbox's
//     namespace. Return its loopback port as sshPort.
// ============================================================================
// ============================================================================
// WORKER LAUNCH - one container per tenant. The process boundary is the ONLY
// thing giving memory isolation + fault containment + VRAM scrub-on-exit at once
// (all empirically confirmed). Compute + VRAM are capped by MPS, also confirmed
// enforced under CC. Never co-locate two tenants in one process.
//   STILL TODO (separate steps): SSH data-plane (returns sshPort 0 here
//   - the HTTP data path is the real channel; SSH is unwired in this revision).
//   Image digests are NOT RTMR-extended (no guest extend interface) - the
//   attestation endpoint reports that coverage gap explicitly, never fakes it.
// ============================================================================
const containerName = (id) => WORKER_PREFIX + String(id).replace(/[^a-zA-Z0-9_.-]/g, "");
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
// docker multiplexed log stream: [stream:1][000][size:4 BE][payload]…  -> plain text
function demuxLogs(buf) {
  let out = "", o = 0;
  while (o + 8 <= buf.length) {
    const size = buf.readUInt32BE(o + 4), start = o + 8, end = start + size;
    if (end > buf.length) break;
    out += buf.slice(start, end).toString(); o = end;
  }
  return o > 0 ? out : buf.toString();   // fallback if the stream wasn't framed
}

// ---- Docker Engine API client (over the mounted unix socket; no docker CLI) --
function dockerReq(method, path, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ socketPath: DOCKER_SOCK, method, path,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) } },
      (res) => { const chunks = []; res.on("data", c => chunks.push(c));
                 res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) })); });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("docker socket timeout")));
    if (data) req.write(data); req.end();
  });
}
async function dockerJson(method, path, body, timeoutMs) {
  const r = await dockerReq(method, path, body, timeoutMs);
  let j = null; try { j = r.buf.length ? JSON.parse(r.buf.toString()) : null; } catch {}
  if (r.status >= 400) throw new Error(`docker ${method} ${path.split("?")[0]} -> ${r.status} ${j?.message || r.buf.toString().slice(0,200)}`);
  return j;
}
async function dockerPull(ref) {
  let fromImage = ref, tag = "latest";
  const at = ref.indexOf("@");
  if (at >= 0) { fromImage = ref.slice(0, at); tag = ref.slice(at + 1); }      // repo@sha256:…
  else { const c = ref.lastIndexOf(":"), s = ref.lastIndexOf("/"); if (c > s) { fromImage = ref.slice(0, c); tag = ref.slice(c + 1); } }
  const r = await dockerReq("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`, null, SPAWN_TIMEOUT_MS);
  if (r.status >= 400) throw new Error(`pull ${ref} -> ${r.status} ${r.buf.toString().slice(0,200)}`);
  // the pull stream returns 200 even on failure; the error rides in the body
  const err = r.buf.toString().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).reverse().find(o => o && o.error);
  if (err) throw new Error(`pull ${ref}: ${err.error}`);
}

async function spawnContainer({ deploymentId, gpuShare, cpuShare, image, appPort, ports }) {
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
    return { internalPort: 0, sshPort: 0 };
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
        appPort: appPort || 8080, name: deploymentId, ports: ports || [] }, SPAWN_TIMEOUT_MS);
    if (r.status !== 201)
      throw new Error(`vmmanager: ${r.body.error || r.body.message || r.status}`);
    console.log(`[spawn-vm] ${deploymentId} image=${ref} cpuShare=${c} gpuShare=${g} `
              + `vm=${r.body.id} hostPort=${r.body.hostPort} status=${r.body.status}`);
    // The VM boots asynchronously; the data path 502s until its server is up.
    return { internalPort: r.body.hostPort || 0, sshPort: 0, vmId: r.body.id, hostPort: r.body.hostPort,
             portMap: r.body.portMap || {} };   // logical "tcp:5432" -> actual loopback bind
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
  return { internalPort: 0, sshPort: 0, smGranted: r.body.sm_granted };
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
// The Tinfoil shim generates the enclave TLS key, obtains an Intel TDX quote
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
  // the shim terminates TLS inside this CVM, so loopback is tried first; the
  // public origin (hairpin through ingress) is the fallback.
  const candidates = ATTESTATION_URL ? [ATTESTATION_URL]
    : ["https://127.0.0.1" + RAD_PATH, "http://127.0.0.1" + RAD_PATH,
       ...(origin ? [origin + RAD_PATH] : [])];
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

// Parse a raw Intel TDX quote (DCAP QuoteV4/V5). Offsets are the fixed TD-report
// layout; report_data is what binds the TLS key. Returns null on anything odd -
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
// AMD SEV-SNP report (in case a CVM lands on SNP hardware): fixed offsets too.
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
let _selfCheck = null;                  // { data, at }
let _selfCheckRun = null;               // in-flight run (shared across concurrent requests)
async function runSelfCheck(origin) {
  if (!ENCLAVE_REPO) return { result: "unavailable", error: "ENCLAVE_REPO not configured" };
  if (!origin)       return { result: "unavailable", error: "public origin not known yet (no external request seen)" };
  const v = new Verifier({ serverURL: origin, configRepo: ENCLAVE_REPO });
  let failure = null;
  try { await v.verify(); } catch (e) { failure = e; }
  const doc = v.getVerificationDocument();
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
      browser: "https://nan.host/#attest",
      repo: ENCLAVE_REPO || null,
      attestationEndpoint: (origin || "") + RAD_PATH,
    },
    tlsKeyFingerprint: null,
    sshHostKeyFingerprint: SSH_HOST_KEY_FP,
    sshHostKey: { fingerprint: SSH_HOST_KEY_FP, measured: false,
                  note: "Generated at boot inside the enclave by the attested supervisor and served over "
                      + "the attested origin, but NOT folded into a hardware register (Tinfoil exposes no "
                      + "guest RTMR-extend), so it is asserted by measured code rather than measured itself." },
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
app.use(cors({
  origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Authorization","Content-Type"],
  maxAge: 86400,
}));

const fail = (res, status, code, message) => res.status(status).json({ code, message });
const originOf = (req) => PUBLIC_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;

// Self-advertise on the first REAL external request: its Host is the hostname a
// caller actually reached us at — the attested origin the registry must carry —
// so there's nothing to hand-configure. Fire-and-forget, once (registerOnChain
// is guarded). Skip local/internal Hosts (health checks) so we never register a
// loopback origin.
app.use((req, _res, next) => {
  if (REGISTRY_READY && !_registered) {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    if (host && !/^(localhost|127\.|\[?::1\]?)/i.test(host)) registerOnChain(originOf(req));
  }
  next();
});

async function addrFromAuth(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { const { payload } = await jwtVerify(m[1], SECRET); return getAddress(payload.sub); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// DATA PATH - registered BEFORE express.json() so the body streams untouched.
// Same token, same origin as control; supervisor checks ownership, then proxies.
// ---------------------------------------------------------------------------
// Firewall config validation. Mirrors the wasm-manager's rules so a bad spec fails
// fast at create (422) instead of at provision: entries are "http" (default serve
// mode) | "http:N" | "tcp:N" | "udp:N"; N in 1..19999 (logical labels; <1024 always remapped), excluding infra ports
// (8080 supervisor, 8091 manager) and the manager-assigned serve range (20000+).
const FW_MIN = 1, FW_MAX = 19999, FW_RESERVED = new Set([8080, 8091]);   // logical labels; <1024 is always remapped to an unprivileged actual by the manager
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
// UDP addressing — a per-deployment IPv6 out of the relay box's /64.
// UDP carries no SNI, so a shared public port can't tell tenants apart; instead
// each deployment gets its OWN address and the relay routes by destination IP.
// The address is DETERMINISTIC from the deployment id (sha256 → low 64 host
// bits), so supervisor and relay derive the identical value with no shared
// state. UDP_ADDR_PREFIX is the relay box's routed /64 (e.g.
// "2a01:4f9:c013:bdfd::/64"); unset = UDP addressing off (the /udp bridge still
// works for direct callers, but no address is advertised). See relay/README.md.
const UDP_ADDR_PREFIX = (process.env.UDP_ADDR_PREFIX || "").trim();
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
function udpAddrFor(id) {
  if (!UDP_ADDR_PREFIX) return null;
  const [prefix] = UDP_ADDR_PREFIX.split("/");
  const net128 = v6ToBig(prefix) & (~0n << 64n);            // zero the low 64 (host) bits
  let host = BigInt("0x" + createHash("sha256").update(id).digest("hex").slice(0, 16)) & ((1n << 64n) - 1n);
  if (host < 0x10000n) host += 0x10000n;                    // reserve the low range for infra
  return bigToV6(net128 | host);
}
// public deployments exposing udp ports, with their address + logical ports —
// the relay reads this to know what to bind and where to route.
const udpMap = () => [...deployments.values()]
  .filter((r) => r.public && r.status === "running" && fwUdpPorts(r).length)
  .map((r) => ({ id: r.id, address: udpAddrFor(r.id), ports: fwUdpPorts(r) }));

app.use("/x/:id", async (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec) return fail(res, 404, "not_found", "Unknown deployment.");
  // Public deployments serve anyone (websites/APIs). Private ones require the owner's
  // token (checked before status so a private deployment's state isn't leaked). SSH
  // (the WebSocket upgrade below) is ALWAYS owner-only, regardless of `public`.
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
    target = new URL(`${WORKER_MGR_URL}/tenants/${encodeURIComponent(req.params.id)}/${sub}`);
  }
  const headers = { ...req.headers, host: target.host };
  delete headers.authorization; // the NAN token stays at the supervisor; the worker never sees it
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
                                 fresh: (Date.now() - _lastPollOkAt) < WATCHER_STALE_SEC * 1000 } : null }));
app.get("/v1/version", (_req, res) => res.json({ service: "nan-supervisor/0.1.0", contract: "nan-openapi/1.0.0", chainId: CHAIN_ID }));

app.get("/v1/pricing", (_req, res) => {
  // One model on every flavor: apps specify EXACT resources, the two billing
  // shares are CALCULATED from them. A CPU-only enclave simply has no card to
  // sell (vramGb must be 0 here).
  const base = {
    assets: ["ETH","USDC"], gpu: IS_GPU,
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
    return res.json({ ...shape(cpuFree, gpuFree, PROVISION_BACKEND === "vm" ? "vmmanager" : "worker"), ...nn });
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
  const statement = "Sign in to NAN. This signature is free and will not move funds.";
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
  const nonce = nm[1], claimed = getAddress(am[1]), rec = nonces.get(nonce);
  if (!rec || rec.exp < Date.now()) { nonces.delete(nonce); return fail(res, 401, "bad_nonce", "Unknown or expired nonce."); }
  if (getAddress(rec.address) !== claimed) return fail(res, 401, "address_mismatch", "Address does not match nonce.");
  let ok = false; try { ok = await verifyMessage({ address: claimed, message, signature }); } catch {}
  if (!ok) return fail(res, 401, "bad_signature", "Signature verification failed.");
  nonces.delete(nonce);
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(claimed)
    .setExpirationTime(expiresAt.getTime() / 1000 | 0).sign(SECRET);
  res.json({ token, tokenType: "Bearer", address: claimed, expiresAt: expiresAt.toISOString() });
});

// ============================================================================
// payments (pay-per-deploy) - the supervisor WATCHES the NanPay forwarder on
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
const timeRemainingSec = (rec) => rec.remainingMs == null ? null : Math.max(0, Math.round(rec.remainingMs / 1000));
const spentOf = (rec) => (((rec.consumedMs || 0) / 1000) * (rec.rate || 0)).toFixed(2);
const view = (rec) => {
  const o = { ...rec };
  for (const k of ["_port", "_gpu", "_gpuSpec", "rate", "_sshPort", "_sshKeySource", "_authorizedKey", "_payTimer",
                   "remainingMs", "consumedMs", "_lastTickAt", "_respawnAt", "_respawnBackoffMs", "_respawning",
                   "_onchain", "_leaseUntil", "_renewing"]) delete o[k];
  o.ssh = sshAccessOf(rec);
  o.ratePerSecondUsdc = (rec.rate || 0).toFixed(7);
  o.spentUsdc = spentOf(rec);
  o.paidUsdc = ((rec.paidUsdc || 0) / 1e6).toFixed(2);
  o.timeRemainingSec = timeRemainingSec(rec);
  // an ESTIMATE only: the balance drains solely while service is healthy, so a
  // frozen (paused) deployment has no meaningful wall-clock expiry.
  o.expiresAt = (rec.remainingMs != null && rec.status === "running" && !rec.paused)
    ? new Date(Date.now() + Math.max(0, rec.remainingMs)).toISOString() : null;
  o.payment = rec._onchain ? onchainPaymentInstructions(rec) : paymentInstructions(rec);
  // claimed-from-chain deployments surface their ledger identity + current lease
  if (rec._onchain) o.onchain = { contract: DEPLOYMENTS_ADDRESS, id: rec.id,
    leaseUntil: rec._leaseUntil ? new Date(rec._leaseUntil * 1000).toISOString() : null };
  // declared udp ports get a per-deployment IPv6 (via the udp-relay). Surface
  // it so the dashboard can show a ready-to-use endpoint, e.g. [addr]:53.
  const udpPorts = fwUdpPorts(rec);
  if (udpPorts.length) o.network = { ...o.network, udp: { address: udpAddrFor(rec.id), ports: udpPorts } };
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
// One eth_call resolves a CID to its listing + deployability flags.
const CATALOG_ABI = [{ type: "function", name: "cidStatus", stateMutability: "view",
  inputs: [{ name: "cid", type: "string" }],
  outputs: [
    { name: "listed",    type: "bool"    },
    { name: "appId",     type: "bytes32" },
    { name: "index",     type: "uint256" },
    { name: "approval",  type: "uint8"   },   // 0 pending | 1 approved | 2 rejected
    { name: "yanked",    type: "bool"    },
    { name: "appActive", type: "bool"    },
    // the version's exact minimum resources [vramMb, gpuGflops, memMb, cpuGflops]:
    // a deploy asking for less on any axis is refused
    { name: "res",       type: "uint32[4]" },
  ] }];
const BARE_CID_RE = /^(baf[a-z0-9]{10,}|Qm[1-9A-HJ-NP-Za-km-z]{20,})$/;
// Gate a vm-backend app reference on catalog approval. Returns { ref, min }
// (the reference to run, bare CIDs normalized to ipfs://, plus the version's
// exact declared minimums { vramMb, gpuGflops, memMb, cpuGflops }) or
// { error }. An RPC failure REJECTS the deploy (fail closed): this is the
// enforcement point, so an outage must not waive it. The image ships NO
// deployable apps (nn-demo.wasm inside it is solely the boot probe's fixture,
// launched by the manager itself, never through this API), so approved store
// CIDs are the only deploy surface — anything else is refused here, which
// also keeps bare paths under the manager's APPS_DIR (e.g. a cached
// ipfs-<cid>.wasm) from dodging the approval check.
const NO_MIN = { vramMb: 0, gpuGflops: 0, memMb: 0, cpuGflops: 0 };
async function gateAppReference(reference) {
  const deny = (status, code, msg) => ({ error: { status, code, msg } });
  let ref = String(reference || "").trim();
  if (BARE_CID_RE.test(ref)) ref = "ipfs://" + ref;
  const m = /^ipfs:\/\/([^/?#]+)/.exec(ref);
  if (!m) {
    return deny(422, "invalid_spec", "image.reference must be an ipfs://<cid> (or bare CID) listed in the app catalog.");
  }
  if (!APP_CATALOG_ADDRESS)
    return deny(503, "approval_unavailable", "Catalog apps are disabled on this enclave: APP_CATALOG_ADDRESS is not configured, so approval cannot be verified.");
  let st;
  try {
    st = await chainClient.readContract({ address: getAddress(APP_CATALOG_ADDRESS),
      abi: CATALOG_ABI, functionName: "cidStatus", args: [m[1]] });
  } catch (e) {
    console.warn(`[approval] cidStatus(${m[1]}) failed: ${e.shortMessage || e.message}`);
    return deny(503, "catalog_unreachable", "Could not verify this app's approval against the on-chain catalog; try again shortly.");
  }
  const [listed, , , approval, yanked, appActive, res] = st;
  if (!listed)               return deny(403, "not_approved", "This CID is not listed in the app catalog. Publish it, then ask the catalog owner to approve it.");
  if (!appActive)            return deny(403, "not_approved", "This app is delisted from the catalog.");
  if (yanked)                return deny(403, "not_approved", "This version was yanked by its publisher.");
  if (Number(approval) === 2) return deny(403, "not_approved", "This version was rejected by the catalog owner.");
  if (Number(approval) !== 1) return deny(403, "not_approved", "This version is awaiting catalog-owner approval; it cannot be deployed yet.");
  const [vramMb, gpuGflops, memMb, cpuGflops] = (res || []).map(Number);
  return { ref, min: { vramMb: vramMb || 0, gpuGflops: gpuGflops || 0, memMb: memMb || 0, cpuGflops: cpuGflops || 0 } };
}

app.post("/v1/deployments", authed, async (req, res) => {
  const b = req.body || {};
  let image = (b.image && b.image.reference) ? b.image : { reference: DEFAULT_IMAGE };
  // Approval gate (vm backend runs catalog apps): only ipfs:// CIDs whose
  // version the catalog owner APPROVED may deploy. Checked before any
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
  // Private (default): only the owner's SIWE token can. SSH/management stay owner-only
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
  if (b.sshPublicKey != null && !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/.test(String(b.sshPublicKey).trim()))
    return fail(res, 422, "invalid_spec", "sshPublicKey must be an OpenSSH public key (ssh-ed25519 / ssh-rsa / ecdsa / sk-*).");

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

  // SSH: install the caller's key, or mint one in-enclave and return it ONCE (now, at create).
  let keySource = "provided", authorizedKey = (b.sshPublicKey || "").trim(), oneTimePrivateKey = null;
  if (!authorizedKey) {
    try { const kp = generateSshKeypair(`nan:${req.address.slice(0, 10)}`);
          authorizedKey = kp.publicKey; oneTimePrivateKey = kp.privateKey; keySource = "generated"; }
    catch (e) { releaseGpu(gpu); return fail(res, 500, "keygen_error", "Could not generate an SSH key: " + e.message); }
  }

  const id = rid("dep_");
  const payRef = keccak256(stringToBytes(id));          // the bytes32 to pass to NanPay.payWithAuthorization()
  const rec = {
    id, owner: req.address, status: "awaiting_payment", public: isPublic, firewall,
    image, command: b.command || [],
    // the two shares bought (the app's catalog specs only set the minimums)
    resources: gpu.cpu
      ? { gpuShare: 0, cpuShare: slice.cpuShare }
      : { gpuShare: slice.gpuShare, cpuShare: slice.cpuShare, cardId: gpu.cardId },
    network: { port: appPort, protocol: "https", endpoint: `${originOf(req)}/x/${id}` },
    attestation: { available: true, vmTechnology: "intel-tdx", gpuTechnology: IS_GPU ? "nvidia-cc" : null, href: `/v1/deployments/${id}/attestation` },
    region: "tinfoil", createdAt: new Date().toISOString(), startedAt: null,
    // fair-billing clock: a funded BALANCE (null = unlimited pilot) drained only
    // on healthy ticks - see startBillingTicker. paused surfaces a frozen clock.
    remainingMs: null, consumedMs: 0, paused: false, pauseReason: null, _lastTickAt: 0,
    payDeadline: Date.now() + PAYMENT_WINDOW_SEC * 1000,
    digest: image.digest || null, rate, payRef, paidUsdc: 0,
    _gpu: gpu, _gpuSpec: gpu.cpu ? null : { cardId: gpu.cardId, cardUuid: gpuCards[gpu.cardId]?.uuid || null, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare },
    _port: 0, _sshPort: 0, _sshKeySource: keySource, _authorizedKey: authorizedKey, _payTimer: null,
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

  const out = view(rec);                                  // includes payment instructions + ssh
  if (oneTimePrivateKey) out.ssh.privateKey = oneTimePrivateKey; // shown once; never persisted
  res.status(201).json(out);
});

// Spawn the tenant's MPS-capped worker process (called once, on first payment).
async function provisionTenant(rec) {
  try {
    const sp = await spawnContainer({ deploymentId: rec.id,
      gpuShare: rec.resources.gpuShare || 0, cpuShare: rec.resources.cpuShare,
      image: rec.image, appPort: rec.network.port, ports: rec.firewall });
    rec._port = sp.internalPort; rec._sshPort = sp.sshPort;
    if (sp.vmId) { rec._vmId = sp.vmId; rec._vmHostPort = sp.hostPort; }
    if (sp.portMap) rec.portMap = sp.portMap;   // logical -> actual (public: clients see their mapping)
    if (!rec.startedAt) rec.startedAt = Date.now();
    rec.status = "running"; rec.paused = false; rec.pauseReason = null; rec._lastTickAt = Date.now();
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
  return r.status === 200;
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
      image: rec.image, appPort: rec.network.port, ports: rec.firewall });
    rec._port = sp.internalPort; rec._sshPort = sp.sshPort;
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
  if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN)
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
    sendClaimTx("release", [rec.id])
      .catch(e => console.warn(`[claim] release on delete failed: ${e.shortMessage || e.message}`));
    return res.json({ id: rec.id, status: "terminated",
               ranSeconds: Math.round((rec.consumedMs || 0) / 1000),
               note: "On-chain deployment: lease released (unused lease time refunded to its balance). It stays "
                   + "claimable by any enclave while active and funded — call setActive(false) on NanDeployments "
                   + "to stop it for good." });
  }
  res.json({ id: rec.id, status: "terminated",
             paidUsdc: ((rec.paidUsdc || 0) / 1e6).toFixed(2),
             ranSeconds: Math.round((rec.consumedMs || 0) / 1000),
             note: "Pay-per-deploy: no balance is held, so unused funded time is forfeit on early stop." });
});

// Top-up instructions: just call NanPay.pay(deploymentRef, amount) again to extend.
app.post("/v1/deployments/:id/topup", authed, (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  if (!["running", "awaiting_payment"].includes(rec.status))
    return fail(res, 409, "not_toppable", `Deployment is ${rec.status}.`);
  res.json({ id: rec.id, status: rec.status, timeRemainingSec: timeRemainingSec(rec), payment: paymentInstructions(rec) });
});

// Optional ?nonce=<64 hex chars>: freshness challenge folded into the GPU report
// (the TDX quote needs none - it binds the long-lived TLS key, and freshness
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
                   guideUrl: "https://nan.host/#attest" }); }
  catch (e) { fail(res, 502, "attestation_error", e.message); }
});

// Enclave-level attestation, PUBLIC: verify the enclave before logging in or
// sending a byte. GPU evidence is included from a short cache (refreshed with a
// self-chosen nonce) so an unauthenticated caller can't spam NVML report
// generation; pass a nonce on the per-deployment endpoint for a fresh challenge.
let _gpuEvCache = null;                       // { ev?, err?, at } - failures cached briefly too
app.get("/v1/attestation", async (req, res) => {
  const out = await getMeasurements(null, { origin: originOf(req) });
  if (!IS_GPU)                                 // CPU-only enclave: no card, no NVML evidence to fetch
    return res.json({ generatedAt: new Date().toISOString(), ...out, guideUrl: "https://nan.host/#attest" });
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
  res.json({ generatedAt: new Date().toISOString(), ...out, guideUrl: "https://nan.host/#attest" });
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

// UDP routing map, PUBLIC: the udp-relay (relay/udp-relay.js) polls this to learn
// which per-deployment IPv6 to bind and which logical ports to route into the
// /x/:id/udp/:port bridge. Only public+running deployments with udp ports; the
// addresses are the deterministic ones the relay also derives from the id.
app.get("/v1/udp-map", (_req, res) =>
  res.json({ enabled: !!UDP_ADDR_PREFIX, prefix: UDP_ADDR_PREFIX || null, deployments: udpMap() }));

// Tail the worker's stdout/stderr (owner only). ?tail=N (default 200, max 2000).
app.get("/v1/deployments/:id/logs", authed, async (req, res) => {
  const rec = deployments.get(req.params.id);
  if (!rec || rec.owner !== req.address) return fail(res, 404, "not_found", "No such deployment.");
  if (/^(1|true|on)$/i.test(process.env.MOCK_SPAWN || "")) return res.type("text/plain").send("[mock] no real worker; logs unavailable\n");
  const tail = String(Math.min(2000, Math.max(1, parseInt(req.query.tail, 10) || 200)));
  try {
    const r = await dockerReq("GET", `/containers/${containerName(rec.id)}/logs?stdout=1&stderr=1&tail=${tail}`, null, 15000);
    if (r.status >= 400) return fail(res, 502, "logs_error", r.buf.toString().slice(0, 200));
    res.type("text/plain").send(demuxLogs(r.buf));
  } catch (e) { fail(res, 502, "logs_error", (e.message || "").toString().slice(0, 300)); }
});

app.use((_req, res) => fail(res, 404, "not_found", "No such route."));
if (IS_GPU) { await initGpu(); await initMps(); }        // CPU-only enclave: no cards to discover, no MPS
else if (PROVISION_BACKEND !== "vm")
  console.warn("[cpu] GPU_COUNT=0 but PROVISION_BACKEND!=vm — a CPU enclave has no GPU worker; deploys will fail");
await initSshHostKey();
// restore persisted deployments/payment cursor BEFORE serving traffic or polling:
// the downtime gap is frozen (never charged) and reservations shift by the gap.
initStatePersistence();
loadState();

// ---------------------------------------------------------------------------
// SSH TUNNEL - ssh rides the one attested origin as a WebSocket at /x/:id/ssh.
// `websocat -b` carries the raw SSH byte stream; we bridge it to the per-
// deployment sshd the SUPERVISOR hosts (measured host key from initSshHostKey;
// the sandbox image needs no sshd). Same gate as the data path: session JWT
// (Authorization header or ?token= for browsers/websocat) + ownership. No second
// external port is opened.
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

async function authUpgrade(req) {
  let token = null;
  const h = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (h) token = h[1];
  else { try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch {} }
  if (!token) return null;
  try { const { payload } = await jwtVerify(token, SECRET); return getAddress(payload.sub); } catch { return null; }
}

// --- platform-terminated TLS for app TCP ports (/x/:id/tls/:port) -----------
// The public relay (relay/relay.js, on any untrusted box) forwards a client's
// raw TLS bytes into this bridge; the session terminates HERE, inside the
// attested enclave. The key pair is MINTED IN-ENCLAVE at boot (like the ssh
// host key) — never provisioned as a secret, so no operator, ACME account, or
// secret store ever holds it and the relay stays a dumb ciphertext pipe. The
// cert is self-signed for *.<TLS_BRIDGE_DOMAIN>; clients bind it to the
// enclave via the fingerprints published over the attested origin at
// /v1/tls-bridge (CA validation never proved enclave residency anyway — see
// relay/README.md). Stock clients that don't validate certs (psql
// sslmode=require, irssi --tls) connect unchanged; validating clients pin or
// use the published PEM as their trust root. The pair persists in the state
// dir (ramdisk), so the fingerprint is stable across supervisor restarts
// within one CVM boot; a full relaunch mints a fresh key — re-read the pin
// from the attested origin. TLS_BRIDGE_DOMAIN unset = the /tls/ path answers
// 503; /tcp/ is unchanged.
const TLS_BRIDGE_DOMAIN = (process.env.TLS_BRIDGE_DOMAIN || "").trim().replace(/^\*\./, "").replace(/\.$/, "");
let TLS_BRIDGE_CTX = null, TLS_BRIDGE_INFO = null;
function initTlsBridge() {
  if (!TLS_BRIDGE_DOMAIN) return;
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(TLS_BRIDGE_DOMAIN))
    return console.error(`[tls-bridge] TLS_BRIDGE_DOMAIN ${JSON.stringify(TLS_BRIDGE_DOMAIN)} is not a hostname - /tls/ bridge disabled`);
  const dir = join(dirname(STATE_FILE), "tls-bridge");
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
initTlsBridge();
if (TLS_BRIDGE_CTX) console.log(`[tls-bridge] in-enclave TLS termination enabled (/x/:id/tls/:port) · ${TLS_BRIDGE_INFO.fingerprint256}`);

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
    const tlsSock  = new tls.TLSSocket(wsStream, { isServer: true, secureContext: TLS_BRIDGE_CTX });
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

  // ---- SSH: always owner-only, regardless of `public` ----
  const m = (req.url || "").match(/^\/x\/([^/?]+)\/ssh(?:\?|$)/);
  if (!m) { socket.destroy(); return; }
  const rec  = deployments.get(m[1]);
  const addr = await authUpgrade(req);
  if (!rec || !rec._sshPort)     return deny("404 Not Found");
  if (!addr)                     return deny("401 Unauthorized");
  if (rec.owner !== addr)        return deny("403 Forbidden");
  if (rec.status !== "running")  return deny("409 Conflict");
  wsTcpBridge(req, socket, head, rec._sshPort);
});

// ============================================================================
// portable deployments — the NanDeployments claim loop (see contracts/DEPLOYMENTS.md)
// ============================================================================
// Deployments created on-chain are work items on a queue: this enclave CLAIMS
// one (burning a bounded lease from its funded balance), serves it through the
// exact same provisioning path as HTTP deploys, RENEWs while healthy, and
// RELEASEs on graceful teardown (refunding the unused tail). If we die
// silently, the lease expires on its own and any other enclave picks the
// deployment up — at-most-one-runner is enforced by the contract, not by us.
// Signing uses REGISTRY_PRIVATE_KEY: claims are gated to the operator of our
// registry entry, so advertising (registerOnChain) is a hard prerequisite.
const DEPLOYMENTS_ADDRESS = process.env.DEPLOYMENTS_ADDRESS || "";
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

// mirrors NanDeployments.Deployment (field order must match the struct exactly)
const DEPLOYMENT_COMPONENTS = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "sshPubKey", type: "string" }, { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
  { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" },
  { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
const DEPLOYMENTS_ABI = [
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
    outputs: [{ type: "tuple", components: DEPLOYMENT_COMPONENTS }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: DEPLOYMENT_COMPONENTS }] },
];

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
    _claimWallet  = createWalletClient({ account: _claimAccount, chain: base, transport: viemHttp(BASE_RPC) });
  }
  return { account: _claimAccount, wallet: _claimWallet };
}
function sendOperatorTx(address, abi, functionName, args) {
  const p = _txChain.then(() => claimSigner().wallet.writeContract({
    address: getAddress(address), abi, functionName, args }));
  _txChain = p
    .then((hash) => chainClient.waitForTransactionReceipt({ hash, timeout: 120_000 }))
    .then(() => {}, () => {});              // keep the queue alive across failures
  return p;
}
const sendClaimTx = (functionName, args) => sendOperatorTx(DEPLOYMENTS_ADDRESS, DEPLOYMENTS_ABI, functionName, args);
const readOnchainDeployment = (id) => chainClient.readContract({
  address: getAddress(DEPLOYMENTS_ADDRESS), abi: DEPLOYMENTS_ABI, functionName: "get", args: [id] });

// local rec states that no longer hold the lease — safe to re-adopt over
// "stopping" is the pre-terminated legacy name, kept so records persisted by an
// older supervisor still count as terminal after an upgrade.
const CLAIM_TERMINAL = new Set(["expired", "failed", "terminated", "stopping"]);

// Renew every adopted lease that's inside the margin. A failed renew is not
// fatal: "unfunded" means the balance is empty (the reaper will tear down when
// the lease runs out — "processed until there is no more time left"), anything
// else retries next pass (margin >> poll interval).
async function renewLeases() {
  for (const rec of deployments.values()) {
    if (!rec._onchain || rec.status !== "running" || rec._renewing) continue;
    if (rec._leaseUntil * 1000 - Date.now() > RENEW_MARGIN_SEC * 1000) continue;
    rec._renewing = true;
    try {
      const hash = await sendClaimTx("renew", [rec.id]);
      await chainClient.waitForTransactionReceipt({ hash });
      const d = await readOnchainDeployment(rec.id);
      rec._leaseUntil = Number(d.leaseUntil);
      rec.remainingMs = rec._leaseUntil * 1000 - Date.now();
      rec.paidUsdc = Number(d.spent6 + d.balance6);
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
async function auditClaims() {
  const me = claimSigner().account.address.toLowerCase();
  for (const rec of [...deployments.values()]) {
    if (!rec._onchain || !["running", "claimed"].includes(rec.status)) continue;
    let d; try { d = await readOnchainDeployment(rec.id); }
    catch { continue; }                       // RPC blip: keep serving, the lease is prepaid
    const mine = (d.runnerOperator || "").toLowerCase() === me
              && Number(d.leaseUntil) * 1000 > Date.now();
    if (!d.active) {
      console.log(`[claim] ${rec.id} stopped by owner on-chain -> teardown + release`);
      try { await stopContainer(rec); } catch {}
      if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
      rec.status = "terminated";
      if (mine) await sendClaimTx("release", [rec.id])
        .catch(e => console.warn(`[claim] release failed: ${e.shortMessage || e.message}`));
      saveStateSoon();
    } else if (!mine) {
      console.log(`[claim] ${rec.id} lease lost -> teardown (chain says runner=${d.runnerOperator})`);
      try { await stopContainer(rec); } catch {}
      if (rec._gpu) { releaseGpu(rec._gpu); rec._gpu = null; }
      rec.status = "expired";                 // sweep may legitimately re-claim it later
      saveStateSoon();
    } else if (rec.status === "claimed") {    // crashed after claim, before provision
      if (!(await provisionTenant(rec))) {
        deployments.delete(rec.id);           // provisionTenant already released the GPU
        await sendClaimTx("release", [rec.id]).catch(() => {});
        saveStateSoon();
      }
    }
  }
}

// Page the ledger for claimable work this enclave can actually serve: funded,
// unleased, fits our free capacity, passes the same catalog-approval gate as
// HTTP deploys (fail closed). Checked BEFORE claiming so we never burn a
// user's lease on something we can't run.
async function claimSweep() {
  if (!(await backendHealthy())) return;      // don't take work we'd immediately fail
  for (let start = 0n; ; start += BigInt(CLAIM_PAGE)) {
    const page = await chainClient.readContract({ address: getAddress(DEPLOYMENTS_ADDRESS),
      abi: DEPLOYMENTS_ABI, functionName: "getPage", args: [start, BigInt(CLAIM_PAGE)] });
    for (const d of page) {
      const ex = deployments.get(d.id);
      if (ex && !CLAIM_TERMINAL.has(ex.status)) continue;                 // already ours
      if (!d.active || Number(d.leaseUntil) * 1000 > Date.now()) continue; // stopped or leased
      if (d.balance6 < d.rate) continue;                                  // out of funded time
      let firewall;
      try { firewall = parseFirewall({ ports: d.ports ? String(d.ports).split(",") : [] }); }
      catch (e) { continue; }                 // port spec we won't serve (mirrors the HTTP 422)
      // Routing: the deployment bought two shares. GPU work (gpuMilli > 0)
      // runs ONLY on GPU enclaves and must fit a card AND the node's cpu pool.
      // CPU-only work runs on CPU enclaves immediately; a GPU enclave bids on
      // it only after CPU_CLAIM_GRACE_SEC (CPU enclaves get first claim) and
      // only out of LEFTOVER cpu pool.
      const gpuShare = Number(d.gpuMilli) / 1000, cpuShare = Number(d.cpuMilli) / 1000;
      let slice;
      if (gpuShare > 0) {
        if (!IS_GPU) continue;                // GPU work never runs on a CPU-only enclave
        slice = normalizeGpuReq(gpuShare, cpuShare);
        if (slice.vramGb > maxFreeVram() + 1e-9 || slice.cpuShare > maxFreeCpu() + 1e-9) continue;
      } else {
        if (IS_GPU) {
          const claimableSince = Math.max(Number(d.createdAt), Number(d.leaseUntil));
          if (Date.now() < (claimableSince + CPU_CLAIM_GRACE_SEC) * 1000) continue;
        }
        slice = normalizeCpuReq(cpuShare);
        if (slice.cpuShare > maxFreeCpu() + 1e-9) continue;
      }
      const g = await gateAppReference(d.appRef);
      if (g.error) continue;                  // unapproved/unlisted CID (or catalog unreachable: fail closed)
      // the app's catalog specs set its MINIMUM shares on our hardware, gating
      // claims exactly like HTTP deploys: a deployment that bought less than
      // the app needs is nobody's work item
      const mins = minSharesOf(g.min);
      if (gpuShare < mins.gpuShare - 1e-9 || cpuShare < mins.cpuShare - 1e-9) continue;
      await tryClaim(d, g.ref, firewall, slice);
    }
    if (page.length < CLAIM_PAGE) break;
  }
}

// Jitter de-syncs enclaves that saw the same queue state; the claimable()
// re-check catches a claim that landed during the wait without paying for a
// reverted tx. Losing the race anyway costs one reverted tx (cents on Base).
async function tryClaim(d, ref, firewall, slice) {
  await new Promise(r => setTimeout(r, Math.random() * 5000));
  const open = await chainClient.readContract({ address: getAddress(DEPLOYMENTS_ADDRESS),
    abi: DEPLOYMENTS_ABI, functionName: "claimable", args: [d.id] });
  if (!open) return;
  let hash;
  try { hash = await sendClaimTx("claim", [d.id, _enclaveId]); }
  catch (e) { console.log(`[claim] ${d.id} claim tx failed (${e.shortMessage || e.message})`); return; }
  const rcpt = await chainClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") { console.log(`[claim] ${d.id} lost the race`); return; }
  const fresh = await readOnchainDeployment(d.id);
  if ((fresh.runnerOperator || "").toLowerCase() !== claimSigner().account.address.toLowerCase()) return;
  await adopt(fresh, ref, firewall, slice);
}

// On-chain record -> local rec, then the SAME provisioning path as HTTP deploys.
// rec.id IS the on-chain id, so the data path (/x/:id, tcp bridge, udp address)
// and clients resolving id -> runner -> endpoint from chain state need no
// mapping. rec.owner is the on-chain owner address — SIWE tokens already carry
// an address, so owner-only routes (status, ssh, delete) work unchanged.
async function adopt(d, ref, firewall, slice) {
  if (deployments.has(d.id)) deployments.delete(d.id);      // terminal leftover from an earlier lease
  const gpu = slice.cpu ? allocCpu(slice.cpuShare) : allocGpu(slice.vramGb, slice.computeShare, slice.cpuShare);
  if (!gpu) {                                                // capacity vanished since the sweep checked
    await sendClaimTx("release", [d.id]).catch(() => {});    // hand it back with the lease refunded
    return;
  }
  const rec = {
    id: d.id, owner: getAddress(d.owner), status: "claimed", public: d.isPublic, firewall,
    image: { reference: ref }, command: [],
    // the two shares the deployment bought on-chain
    resources: slice.cpu
      ? { gpuShare: 0, cpuShare: slice.cpuShare }
      : { gpuShare: slice.gpuShare, cpuShare: slice.cpuShare, cardId: gpu.cardId },
    network: { port: Number(d.appPort) || 8080, protocol: "https", endpoint: `${_advertisedEndpoint}/x/${d.id}` },
    attestation: { available: true, vmTechnology: "intel-tdx", gpuTechnology: IS_GPU ? "nvidia-cc" : null, href: `/v1/deployments/${d.id}/attestation` },
    region: "tinfoil", createdAt: new Date(Number(d.createdAt) * 1000).toISOString(), startedAt: null,
    // the local clock only mirrors the CURRENT lease; the chain holds the rest
    remainingMs: Number(d.leaseUntil) * 1000 - Date.now(), consumedMs: 0,
    paused: false, pauseReason: null, _lastTickAt: Date.now(),
    rate: Number(d.rate) / 1e6, paidUsdc: Number(d.spent6 + d.balance6),
    _onchain: true, _leaseUntil: Number(d.leaseUntil), _renewing: false,
    _gpu: gpu, _gpuSpec: gpu.cpu ? null : { cardId: gpu.cardId, cardUuid: gpuCards[gpu.cardId]?.uuid || null, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare },
    _port: 0, _sshPort: 0, _sshKeySource: "on-chain", _authorizedKey: (d.sshPubKey || "").trim(), _payTimer: null,
  };
  deployments.set(rec.id, rec); saveStateSoon();
  if (await provisionTenant(rec)) {
    console.log(`[claim] ${rec.id} adopted: app=${ref} gpuShare=${round3(slice.gpuShare || 0)} cpuShare=${round3(slice.cpuShare)} `
              + `lease until ${new Date(rec._leaseUntil * 1000).toISOString()}`);
  } else {
    // launch failed (bad wasm, image too big, ...): hand it back refunded so
    // another enclave can try — the user paid nothing for our failure
    deployments.delete(rec.id);                              // provisionTenant released the GPU already
    await sendClaimTx("release", [rec.id])
      .catch(e => console.warn(`[claim] release after failed provision: ${e.shortMessage || e.message}`));
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
  const t = setInterval(async () => {
    if (_claimBusy || !_enclaveId) return;   // not advertised yet, or a slow pass is still running
    _claimBusy = true;
    try { await renewLeases(); await auditClaims(); await claimSweep(); }
    catch (e) { console.warn(`[claim] pass failed: ${e.shortMessage || e.message}`); }
    finally { _claimBusy = false; }
  }, CLAIM_POLL_SEC * 1000);
  if (t.unref) t.unref();
  console.log(`[claim] loop on: ${DEPLOYMENTS_ADDRESS} every ${CLAIM_POLL_SEC}s (renew margin ${RENEW_MARGIN_SEC}s)`);
}

// Funding instructions for a claimed deployment: top-ups go to the ledger
// contract (credited on-chain), NOT to NanPay — same EIP-3009 shape, different
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
    note: "On-chain deployment: fund NanDeployments directly. USDC (EIP-3009, no approve): sign a USDC "
        + "ReceiveWithAuthorization (EIP-712, to = the NanDeployments contract, nonce = first 16 bytes of the "
        + "deployment id + 16 random bytes), then anyone submits fundWithAuthorization; amount(6dp)/rate = seconds. "
        + "ETH: fundEth(id) with msg.value; credited on-chain at the live Chainlink ETH/USD rate.",
  };
}

server.listen(PORT, () => console.log(`nan supervisor on :${PORT} · ${IS_GPU
  ? `${GPU_COUNT}×GPU @ ${CARD_VRAM_GB}GB (arbitrary split)`
  : `CPU-only enclave (${NODE_VCPUS} vCPU / ${NODE_RAM_GB}GB, node-share split)`} · ssh host key ${SSH_HOST_KEY_FP}`));

// advertise this enclave on-chain (opt-in, non-blocking, never fatal)
// If the origin is pinned (PUBLIC_URL), advertise eagerly at boot; otherwise we
// register lazily on the first external request (middleware above).
if (PUBLIC_URL) registerOnChain(PUBLIC_URL);

// pay-per-deploy: watch the forwarder for payments + fair-billing ticker (drains
// funded time only while healthy; freezes through outages; reaps at -grace)
startPaymentWatcher();
startBillingTicker();

// portable deployments: claim/renew/release on-chain leases (opt-in; see
// contracts/DEPLOYMENTS.md). Requires registry advertising + DEPLOYMENTS_ADDRESS.
startClaimLoop();
