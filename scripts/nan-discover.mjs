// nan-discover — read the on-chain registry, aggregate live availability, pick
// an enclave. No trusted gateway: this runs in the CALLER (browser or server).
//
// IMPORTANT — this helper does discovery + placement ONLY. It does NOT verify
// attestation. The caller MUST connect to the chosen endpoint through Tinfoil's
// SecureClient (tinfoil-js / tinfoil-go / tinfoil python / swift), which fetches
// the enclave's live SEV-SNP/TDX quote, checks it against the Sigstore
// measurement for `repo`, and pins the TLS key. Picking the wrong enclave here
// costs you a suboptimal placement, NOT security — attestation still gates trust
// at connect time. Treat `repo` from the registry as the value you hand to
// SecureClient(endpoint, repo).
//
// Node: `npm i viem` then `node nan-discover.mjs`. Browser: import the same way;
// `fetch` and viem both work in-page.

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const REGISTRY_ADDRESS = process.env?.REGISTRY_ADDRESS || "0xC4C6C7D4D0b9C92ba5326f7903e6f0C300B6994D";
const RPC_URL          = process.env?.BASE_RPC || "https://mainnet.base.org";
const STALE_AFTER_SEC  = 3600;  // treat enclaves silent longer than this as down

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

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

// 1) read the registry (slow-moving truth: who exists, where, what code)
export async function readRegistry(address = REGISTRY_ADDRESS) {
  const total = Number(await client.readContract({ address, abi: ABI, functionName: "count" }));
  const out = [];
  for (let start = 0; start < total; start += 50) {
    const page = await client.readContract({ address, abi: ABI, functionName: "getPage",
      args: [BigInt(start), 50n] });
    out.push(...page);
  }
  const now = Math.floor(Date.now() / 1000);
  return out.filter(e => e.active && now - Number(e.lastSeen) <= STALE_AFTER_SEC);
}

// 2) fan out to each enclave's /availability (fast-moving truth: free capacity)
export async function fetchAvailability(endpoint, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, "")}/availability`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// 3) aggregate + pick. EXACT-resource placement on four axes: vramGb +
// gpuTflops of one GPU card (both 0 = CPU-only app) and memMb + cpuTflops of a
// node. Shares are calculated per enclave against ITS OWN specs from
// /availability, so heterogeneous hardware routes correctly. GPU work only
// fits GPU enclaves (all axes must fit). CPU-only work prefers CPU-only
// enclaves; GPU enclaves are the FALLBACK, renting out the cpu pool their GPU
// tenants left over (e.g. a whole card + 10% of the RAM sold leaves 90% free).
const gpuFreeOf = (a) => a.gpuShareFree ?? (a.gpu ? a.maxShare ?? 0 : 0);   // maxShare: pre-two-pool enclaves
const cpuFreeOf = (a) => a.cpuShareFree ?? (a.gpu ? 0 : a.maxShare ?? 0);
const vramFreeGbOf    = (a) => gpuFreeOf(a) * (a.cardVramGb || 141);
const gpuTflopsFreeOf = (a) => gpuFreeOf(a) * (a.cardTflops || 989);
const ramFreeMbOf     = (a) => cpuFreeOf(a) * (a.nodeRamGb || 64) * 1024;
const cpuTflopsFreeOf = (a) => cpuFreeOf(a) * (a.nodeTflops || 1);
export async function pickEnclave(want = {}, address = REGISTRY_ADDRESS) {
  const { vramGb = 0, gpuTflops = 0, memMb = 0, cpuTflops = 0 } = want;
  const enclaves = await readRegistry(address);
  const rows = await Promise.all(enclaves.map(async (e) => {
    const a = await fetchAvailability(e.endpoint);
    return a ? { endpoint: e.endpoint, repo: e.repo, gpu: !!a.gpu,
                 vramFreeGb: Math.round(vramFreeGbOf(a) * 10) / 10,
                 gpuTflopsFree: Math.round(gpuTflopsFreeOf(a) * 10) / 10,
                 ramFreeMb: Math.round(ramFreeMbOf(a)),
                 cpuTflopsFree: Math.round(cpuTflopsFreeOf(a) * 1000) / 1000,
                 smFree: a.smFree ?? 0, avail: a } : null;
  }));
  const live = rows.filter(Boolean);
  const cpuFits = (r) => r.ramFreeMb >= memMb && r.cpuTflopsFree >= cpuTflops;
  let chosen;
  if (vramGb > 0 || gpuTflops > 0) {
    chosen = live.filter(r => r.gpu && r.vramFreeGb >= vramGb && r.gpuTflopsFree >= gpuTflops && cpuFits(r))
                 .sort((a, b) => b.vramFreeGb - a.vramFreeGb)[0] || null;
  } else {
    const fits = live.filter(cpuFits);
    const byRamFree = (a, b) => b.ramFreeMb - a.ramFreeMb;
    chosen = fits.filter(r => !r.gpu).sort(byRamFree)[0]      // CPU-only enclaves first...
          || fits.filter(r => r.gpu).sort(byRamFree)[0]       // ...then GPU leftovers
          || null;
  }
  return {
    aggregate: { enclaves: live.length,
                 totalVramFreeGb: Math.round(live.reduce((s, r) => s + r.vramFreeGb, 0) * 10) / 10,
                 totalGpuTflopsFree: Math.round(live.reduce((s, r) => s + r.gpuTflopsFree, 0) * 10) / 10,
                 totalRamFreeGb: Math.round(live.reduce((s, r) => s + r.ramFreeMb, 0) / 1024 * 10) / 10,
                 totalCpuTflopsFree: Math.round(live.reduce((s, r) => s + r.cpuTflopsFree, 0) * 100) / 100,
                 totalSmFree: live.reduce((s, r) => s + (r.smFree || 0), 0) },
    chosen,                            // hand chosen.endpoint + chosen.repo to Tinfoil SecureClient
    all: live,
  };
}

// CLI: `node nan-discover.mjs [vramGb] [memMb] [gpuTflops] [cpuTflops]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const want = { vramGb: parseFloat(process.argv[2] || "0"), memMb: parseFloat(process.argv[3] || "0"),
                 gpuTflops: parseFloat(process.argv[4] || "0"), cpuTflops: parseFloat(process.argv[5] || "0") };
  pickEnclave(want).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.chosen) { console.error(`\nNo live enclave fits ${JSON.stringify(want)}.`); process.exit(1); }
    console.log(`\n-> connect via Tinfoil SecureClient("${r.chosen.endpoint}", "${r.chosen.repo}")`);
  }).catch((e) => { console.error("discovery failed:", e.message); process.exit(1); });
}
