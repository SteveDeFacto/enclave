// Enclave relay fleet discovery — shared by the DATA-PLANE relays (tcp6-relay,
// udp-relay, egress-relay) so they follow an arbitrary, CHANGING set of
// enclaves instead of being pinned to one by env. The fleet can grow and
// shrink at any time; nobody should be hand-editing relay env files when it
// does.
//
// Two sources, same precedence as api-relay.js:
//   ENCLAVES           static comma list of enclave origins (wins if set)
//   ENCLAVE_URL        legacy single-enclave pin — folded into the list, so
//                      existing env files keep working unchanged
//   REGISTRY_ADDRESS   EnclaveRegistry on Base (chain 8453): the on-chain truth of
//                      the live fleet, re-read every REGISTRY_POLL_SEC and
//                      filtered to active + recently-seen entries. This is the
//                      set-and-forget mode: a new enclave registers itself and
//                      every relay picks it up within one poll.
//
// The registry read mirrors api-relay.js / scripts/enclave-discover.mjs (count +
// getPage paging). This module holds NO trust: it only tells the relays which
// origins to serve; every origin still authenticates the relay (egress) or
// scopes it to public deployments (tcp6/udp) exactly as before.

const DEFAULTS = {
  baseRpc: "https://mainnet.base.org",
  registryPollSec: 300,
  staleAfterSec: 3600,
};

// Parse the fleet-related env once. Returns { staticList, registryAddress,
// baseRpc, registryPollSec, staleAfterSec }; the caller decides what "neither
// source set" means (the daemons treat it as fatal).
export function fleetConfig(env = process.env) {
  const staticList = [...new Set([env.ENCLAVES, env.ENCLAVE_URL]
    .filter(Boolean).join(",")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean))];
  return {
    staticList,
    registryAddress: (env.REGISTRY_ADDRESS || "").trim(),
    baseRpc: env.BASE_RPC || DEFAULTS.baseRpc,
    registryPollSec: parseInt(env.REGISTRY_POLL_SEC || "", 10) || DEFAULTS.registryPollSec,
    staleAfterSec: parseInt(env.STALE_AFTER_SEC || "", 10) || DEFAULTS.staleAfterSec,
  };
}

const ABI = [
  { type: "function", name: "count", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "endpoint", type: "string" }, { name: "repo", type: "string" },
      { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
      { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" },
      { name: "active", type: "bool" }] }] },
];

// createFleet(cfg, log) -> { origins(), start() }
//   origins()  the current enclave https origins (static list, or the last
//              successful registry read — kept on read failure, never cleared)
//   start()    resolves after the first registry read in registry mode (so a
//              daemon's first reconcile already sees the fleet); schedules the
//              re-reads. No-op in static mode.
export function createFleet(cfg, log = () => {}) {
  let origins = cfg.staticList;
  if (cfg.staticList.length) {
    return { origins: () => origins,
             async start() { log(`static fleet: ${origins.join(", ")}`); } };
  }

  let client = null;
  async function readRegistry() {
    if (!client) {
      const { createPublicClient, http } = await import("viem");
      const { base } = await import("viem/chains");
      client = createPublicClient({ chain: base, transport: http(cfg.baseRpc) });
    }
    const total = Number(await client.readContract({
      address: cfg.registryAddress, abi: ABI, functionName: "count" }));
    const rows = [];
    for (let start = 0; start < total; start += 50)
      rows.push(...await client.readContract({ address: cfg.registryAddress, abi: ABI,
        functionName: "getPage", args: [BigInt(start), 50n] }));
    const now = Math.floor(Date.now() / 1000);
    return rows
      .filter((e) => e.active && now - Number(e.lastSeen) <= cfg.staleAfterSec)
      .map((e) => e.endpoint.replace(/\/+$/, ""));
  }

  async function refresh() {
    try {
      const next = [...new Set(await readRegistry())];
      if (next.join(",") !== origins.join(","))
        log(`fleet: ${next.length ? next.join(", ") : "(empty)"}`);
      origins = next;
    } catch (e) {
      // keep the last known fleet — a flaky RPC must not unbind live relays
      log(`registry read failed (keeping ${origins.length} known): ${e.message}`);
    }
  }

  return {
    origins: () => origins,
    async start() {
      log(`on-chain fleet: EnclaveRegistry ${cfg.registryAddress}`);
      await refresh();
      setInterval(refresh, cfg.registryPollSec * 1000);
    },
  };
}

// Small shared helper: GET url, JSON on 2xx, null on anything else (timeout,
// refused, non-2xx) — per-origin poll failures are data, not exceptions.
export async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; }
  finally { clearTimeout(t); }
}
