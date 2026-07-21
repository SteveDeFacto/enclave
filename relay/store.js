// Shared plumbing for the relay's account/billing modules (auth.js,
// billing.js, indexer.js, ofac.js, provisioner.js): flat-file JSON stores
// with atomic writes, the token-bucket rate limiter, id minting, and the
// multi-provider Base RPC pool.
//
// There is NO database anywhere in this codebase - state is either on-chain
// or a JSON file written tmp-then-rename (the supervisor's STATE_FILE
// pattern). These stores hold the relay-side account/order records: real
// money references them, so every write is atomic and every store flushes on
// SIGTERM. Unlike featured-views.json (best-effort metering, silent-drop by
// design) a failed write here is LOUD.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const rid = (prefix) => (prefix || "") + randomBytes(12).toString("hex");

// tmp + rename on the same filesystem = readers see the old or the new file,
// never a torn one (supervisor.js saveStateNow)
export function atomicWriteJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// A JSON document store: mutate `store.data` freely, call `saveSoon()` after.
// Default: a dirty flag + 2s timer coalesces bursts; `flush()` forces the
// write (call it before any await that must not lose the step - the
// provisioner's write-ahead steps do). With { durable: true } every saveSoon
// IS a flush: accounts/orders/payments are money-adjacent and low-write, and
// state must be on disk BEFORE the response acknowledges it - a crash inside
// a debounce window must never un-create an account or forget a payment.
// Every instance also flushes on SIGTERM/SIGINT for clean systemd restarts
// (SIGKILL is exactly what durable mode is for).
const _stores = [];
let _exitHooked = false;
export class JsonStore {
  constructor(file, initial, { durable = false } = {}) {
    this.file = file;
    this.data = initial;
    this.durable = durable;
    this.dirty = false;
    try {
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      this.data = { ...initial, ...onDisk };
    } catch { /* first boot: initial shape */ }
    this._timer = setInterval(() => { if (this.dirty) this.flush(); }, 2000);
    this._timer.unref?.();
    _stores.push(this);
    if (!_exitHooked) {
      _exitHooked = true;
      for (const sig of ["SIGTERM", "SIGINT"])
        process.on(sig, () => { for (const s of _stores) { try { s.flush(); } catch {} } process.exit(0); });
    }
  }
  saveSoon() { if (this.durable) return this.flush(); this.dirty = true; }
  flush() {
    this.dirty = false;
    atomicWriteJson(this.file, this.data);
  }
}

// per-key token bucket (api-relay.js fix 2; copied so the entry module's
// helpers stay private to it)
export function makeRateLimiter({ capacity, refillPerSec }) {
  const buckets = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.at > 300_000) buckets.delete(k); }, 60_000).unref?.();
  return (key) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  };
}

// The writable data dir - and the EXPLICIT activation switch for accounts +
// billing. Deliberately AUTH_DATA_DIR only: the systemd unit ships
// StateDirectory=enclave-relay (so /var/lib/enclave-relay exists, owned by
// the dynamic user), but a routine relay deploy must NOT auto-enable these
// surfaces - the operator activates them by adding
// AUTH_DATA_DIR=/var/lib/enclave-relay to /etc/nan-relay/api-relay.env.
// Unset/unwritable => accounts + billing stay disabled, said once at boot.
export function dataDir() {
  const dir = (process.env.AUTH_DATA_DIR || "").trim();
  if (!dir) {
    if ((process.env.STATE_DIRECTORY || "").trim())
      console.log(`[store] StateDirectory exists but AUTH_DATA_DIR is unset - accounts/billing stay OFF (activate with AUTH_DATA_DIR=${process.env.STATE_DIRECTORY})`);
    return "";
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (e) {
    // fail LOUD, not silent: a half-configured box must not pretend billing works
    console.error(`[store] data dir ${dir} is not writable (${e.message}) - accounts/billing disabled`);
    return "";
  }
}
export const dataFile = (dir, name) => path.join(dir, name);

// Multi-provider Base RPC pool (supervisor.js RPC_POOL): BASE_RPC first so an
// explicit key-bearing endpoint wins; public fallbacks behind it. One
// throttled provider must never blind the payment indexer.
export async function rpcParts() {
  const { http: viemHttp, fallback } = await import("viem");
  const { base, baseSepolia } = await import("viem/chains");
  const testnet = (process.env.BILLING_NETWORK || "base") === "base-sepolia";
  const BASE_RPC = process.env.BASE_RPC || (testnet ? "https://sepolia.base.org" : "https://mainnet.base.org");
  // RPC_FALLBACKS=0 pins the pool to BASE_RPC alone. Tests need this: with a
  // local BASE_RPC (anvil/stub) the mainnet fallbacks are a DIFFERENT CHAIN,
  // and one transient local error silently routes sends/receipt-polls there
  const pool = (testnet || process.env.RPC_FALLBACKS === "0") ? [BASE_RPC] : [...new Set([BASE_RPC,
    "https://base-rpc.publicnode.com", "https://base.drpc.org",
    "https://1rpc.io/base", "https://mainnet.base.org"])];
  return { chain: testnet ? baseSepolia : base,
           transport: fallback(pool.map((u) => viemHttp(u, { retryCount: 2, retryDelay: 500 }))) };
}
let _pub = null;
export async function rpcPool() {
  if (_pub) return _pub;
  const { createPublicClient } = await import("viem");
  const { chain, transport } = await rpcParts();
  _pub = createPublicClient({ chain, transport });
  return _pub;
}
