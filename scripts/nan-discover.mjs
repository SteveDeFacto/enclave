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

const REGISTRY_ADDRESS = process.env?.REGISTRY_ADDRESS || "0xYOUR_REGISTRY";
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

// 3) aggregate + pick the enclave with the most free share that fits `wantShare`
export async function pickEnclave(wantShare = 0, address = REGISTRY_ADDRESS) {
  const enclaves = await readRegistry(address);
  const rows = await Promise.all(enclaves.map(async (e) => {
    const a = await fetchAvailability(e.endpoint);
    return a ? { endpoint: e.endpoint, repo: e.repo, maxShare: a.maxShare ?? 0,
                 smFree: a.smFree ?? 0, vramFreeGb: a.vramFreeGb ?? 0, avail: a } : null;
  }));
  const live = rows.filter(Boolean);
  const totalFreeShare = live.reduce((s, r) => s + (r.maxShare || 0), 0);
  const fits = live.filter(r => r.maxShare >= wantShare).sort((a, b) => b.maxShare - a.maxShare);
  return {
    aggregate: { enclaves: live.length, totalFreeShare: Math.round(totalFreeShare * 1000) / 1000,
                 totalSmFree: live.reduce((s, r) => s + (r.smFree || 0), 0),
                 totalVramFreeGb: Math.round(live.reduce((s, r) => s + (r.vramFreeGb || 0), 0) * 10) / 10 },
    chosen: fits[0] || null,           // hand chosen.endpoint + chosen.repo to Tinfoil SecureClient
    all: live,
  };
}

// CLI: `node nan-discover.mjs [wantShare]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const want = parseFloat(process.argv[2] || "0");
  pickEnclave(want).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.chosen) { console.error(`\nNo live enclave has >= ${want} free share.`); process.exit(1); }
    console.log(`\n-> connect via Tinfoil SecureClient("${r.chosen.endpoint}", "${r.chosen.repo}")`);
  }).catch((e) => { console.error("discovery failed:", e.message); process.exit(1); });
}
