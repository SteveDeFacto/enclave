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

const REGISTRY_ADDRESS = process.env?.REGISTRY_ADDRESS || "0x13deE63b80353a15C6E03D54240EE463B420353F";
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

// 3) aggregate + pick. Deployments buy TWO shares, so placement is by the
// shares you intend to buy: gpuShare (0..1 of one GPU card; 0 = CPU-only app)
// and cpuShare (0..1 of a node's vCPU+RAM). Your app's exact specs (catalog)
// only set the MINIMUM shares — derive them per enclave from /availability's
// cardVramGb / cardTflops / nodeRamGb / nodeGflops if you're sizing from
// specs. GPU work only fits GPU enclaves (both pools must fit). CPU-only work
// prefers CPU-only enclaves; GPU enclaves are the FALLBACK, renting out the
// cpu pool their GPU tenants left over (e.g. a whole card + 10% of the node
// sold leaves 90% free).
const gpuFreeOf = (a) => a.gpuShareFree ?? (a.gpu ? a.maxShare ?? 0 : 0);   // maxShare: pre-two-pool enclaves
const cpuFreeOf = (a) => a.cpuShareFree ?? (a.gpu ? 0 : a.maxShare ?? 0);
export async function pickEnclave(want = {}, address = REGISTRY_ADDRESS) {
  const { gpuShare = 0, cpuShare = 0 } = want;
  const enclaves = await readRegistry(address);
  const rows = await Promise.all(enclaves.map(async (e) => {
    const a = await fetchAvailability(e.endpoint);
    return a ? { endpoint: e.endpoint, repo: e.repo, gpu: !!a.gpu,
                 gpuShareFree: gpuFreeOf(a), cpuShareFree: cpuFreeOf(a),
                 smFree: a.smFree ?? 0, vramFreeGb: a.vramFreeGb ?? 0, avail: a } : null;
  }));
  const live = rows.filter(Boolean);
  let chosen;
  if (gpuShare > 0) {
    chosen = live.filter(r => r.gpu && r.gpuShareFree >= gpuShare && r.cpuShareFree >= cpuShare)
                 .sort((a, b) => b.gpuShareFree - a.gpuShareFree)[0] || null;
  } else {
    const fits = live.filter(r => r.cpuShareFree >= cpuShare);
    const byCpuFree = (a, b) => b.cpuShareFree - a.cpuShareFree;
    chosen = fits.filter(r => !r.gpu).sort(byCpuFree)[0]      // CPU-only enclaves first...
          || fits.filter(r => r.gpu).sort(byCpuFree)[0]       // ...then GPU leftovers
          || null;
  }
  return {
    aggregate: { enclaves: live.length,
                 totalGpuShareFree: Math.round(live.reduce((s, r) => s + r.gpuShareFree, 0) * 1000) / 1000,
                 totalCpuShareFree: Math.round(live.reduce((s, r) => s + r.cpuShareFree, 0) * 1000) / 1000,
                 totalSmFree: live.reduce((s, r) => s + (r.smFree || 0), 0),
                 totalVramFreeGb: Math.round(live.reduce((s, r) => s + (r.vramFreeGb || 0), 0) * 10) / 10 },
    chosen,                            // hand chosen.endpoint + chosen.repo to Tinfoil SecureClient
    all: live,
  };
}

// CLI: `node nan-discover.mjs [gpuShare] [cpuShare]` (0..1 each)
if (import.meta.url === `file://${process.argv[1]}`) {
  const want = { gpuShare: parseFloat(process.argv[2] || "0"), cpuShare: parseFloat(process.argv[3] || "0") };
  pickEnclave(want).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.chosen) { console.error(`\nNo live enclave has gpuShare >= ${want.gpuShare} and cpuShare >= ${want.cpuShare} free.`); process.exit(1); }
    console.log(`\n-> connect via Tinfoil SecureClient("${r.chosen.endpoint}", "${r.chosen.repo}")`);
  }).catch((e) => { console.error("discovery failed:", e.message); process.exit(1); });
}
