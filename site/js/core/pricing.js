/* ============================================================
   Pricing + share math. The deploy page has exactly TWO dials:
   a GPU/VRAM share and a CPU/RAM share, 0-100% each. An app's
   exact specs (VRAM, compute, RAM in the catalog) only set the
   MINIMUM shares those dials allow: spec / server spec, the
   larger of the memory and compute axes per pool, rounded up to
   the whole percent. A GPU app's CPU minimum also lifts its GPU
   minimum (a GPU app's gpuShare must be >= its cpuShare).
   Rate = gpuShare x card rate + cpuShare x node rate.
   ============================================================ */
export const FULL_RATE = 0.0016667;        // whole-H200 USDC/sec ($6.00/hr)
export const CPU_NODE_RATE = 0.0002778;    // whole CPU node USDC/sec ($1.00/hr)
export const CARD_GB = 141;                // whole-card VRAM
export const NODE_VCPUS = 16;              // host vCPUs on the enclave (confirm vs real Tinfoil spec)
export const NODE_RAM_GB = 64;             // host RAM GB on the enclave (confirm vs real Tinfoil spec)
export const MIN_COMPUTE_PCT = 1;    // shares are dialed in whole percent (CUDA MPS grain); 1% floor, no fixed 1/7
export const CARD_TFLOPS = 989;      // GPU compute per card (H200 FP16 dense)
export const NODE_GFLOPS = 1000;     // CPU compute per node in GFLOPS (~16 vCPU; a node is ~1/1000 of a card)

export const pctCeil = (x) => Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.ceil(x * 100 - 1e-9)));
export function minPctsOf(v){                // v: a catalog version's exact specs (zeros = no minimum)
  const vramMb = Number(v && v.vramMb || 0), gpuGf = Number(v && v.gpuGflops || 0);
  const memMb = Number(v && v.memMb || 0), cpuGf = Number(v && v.cpuGflops || 0);
  const cpu = (memMb > 0 || cpuGf > 0) ? pctCeil(Math.max(memMb / (NODE_RAM_GB * 1024), cpuGf / NODE_GFLOPS)) : 1;
  const gpu0 = (vramMb > 0 || gpuGf > 0) ? pctCeil(Math.max(vramMb / 1024 / CARD_GB, gpuGf / 1000 / CARD_TFLOPS)) : 0;
  return { gpuPct: gpu0 > 0 ? Math.max(gpu0, cpu) : 0, cpuPct: cpu };
}
export function shareRates(gpuPct, cpuPct){  // what the two dials buy on this server spec
  const g = Math.min(100, Math.max(0, Math.round(gpuPct)));
  const c = Math.min(100, Math.max(MIN_COMPUTE_PCT, Math.round(cpuPct)));
  return { rate: (g / 100) * FULL_RATE + (c / 100) * CPU_NODE_RATE, gpuPct: g, cpuPct: c,
           vramGb: (g / 100) * CARD_GB, tflops: (g / 100) * CARD_TFLOPS,
           ramGb: (c / 100) * NODE_RAM_GB, vcpus: (c / 100) * NODE_VCPUS, gflops: (c / 100) * NODE_GFLOPS };
}
