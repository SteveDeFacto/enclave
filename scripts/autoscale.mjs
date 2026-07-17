#!/usr/bin/env node
// autoscale.mjs — demand-driven fleet scaling with anti-griefing guardrails.
//
//   node scripts/autoscale.mjs plan [--out plan.json]     read-only: propose actions
//   node scripts/autoscale.mjs apply plan.json            execute a reviewed plan
//
// Detects funded, claimable EnclaveDeployments records that no live enclave has
// capacity to serve, and starts (or creates) standby enclave containers via the
// Tinfoil controlplane; stops auto-managed enclaves that sit idle. Design and
// threat model: docs/autoscale.md. The guardrails, in one breath:
//
//   - Demand is read from the CHAIN, and funding is non-custodial and
//     NON-REFUNDABLE (EnclaveDeployments forwards USDC to the payout wallet in
//     the funding tx; there is no withdraw path). Faking demand costs real,
//     permanently-lost money, and every scale-up requires MIN_COMMITTED_USD of
//     prepaid runtime behind it — a griefer forcing a scale-up is a customer
//     overpaying for the box they force us to run.
//   - Structural non-demand is filtered out (below min-share, deactivated,
//     retired config, unapproved app) via claim-hint classification, so
//     permanently-unclaimable records never trigger scaling.
//   - Hard caps: at most AUTOSCALE_MAX_GPU/_CPU auto containers (default 1+1),
//     under Tinfoil's own 10-container org quota; one action per flavor per
//     run; AUTOSCALE_COOLDOWN_SEC between lifecycle changes per flavor.
//   - Scale-down only ever STOPS containers named auto-* (billing pauses,
//     config preserved); it never deletes anything and never touches the
//     baseline fleet.
//   - apply re-verifies container state before each action (safe to run a
//     stale reviewed plan) and rolls a started box back to stopped if the
//     relay does not list it (TRUSTED_OPERATORS mismatch — see docs).
//
// Env knobs (defaults in CFG below): AUTOSCALE_* thresholds, ENCLAVE_API_BASE,
// ENCLAVE_RPC, TINFOIL_API_KEY (read by the tinfoil CLI).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http, fallback, stringToHex } from "viem";
import { base } from "viem/chains";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);

export const CFG = {
  repo: env.ENCLAVE_TINFOIL_REPO || "EnclaveHost/enclave",
  apiBase: (env.ENCLAVE_API_BASE || "https://api.enclave.host").replace(/\/+$/, ""),
  // a deployment only counts as demand once it has waited out the normal claim
  // path (dwell) and carries a meaningful prepaid runtime (non-refundable)
  dwellSec: num("AUTOSCALE_DWELL_SEC", 600),
  minFundedSec: num("AUTOSCALE_MIN_FUNDED_SEC", 3600),
  // per-flavor: minimum aggregate prepaid USD and unmet share to justify a box
  minCommittedUsd: { gpu: num("AUTOSCALE_MIN_COMMITTED_USD_GPU", 4), cpu: num("AUTOSCALE_MIN_COMMITTED_USD_CPU", 1.5) },
  minUnmetShare: { gpu: num("AUTOSCALE_MIN_UNMET_GPU_SHARE", 0.10), cpu: num("AUTOSCALE_MIN_UNMET_CPU_SHARE", 0.25) },
  horizonSec: num("AUTOSCALE_HORIZON_SEC", 86400), // cap per-deployment committed-USD credit at 24h
  maxAuto: { gpu: num("AUTOSCALE_MAX_GPU", 1), cpu: num("AUTOSCALE_MAX_CPU", 1) },
  orgContainerQuota: 10, // Tinfoil's documented per-org instance limit
  cooldownSec: num("AUTOSCALE_COOLDOWN_SEC", 1800),
  idleStopSec: num("AUTOSCALE_IDLE_STOP_SEC", 2700),
  hintMax: num("AUTOSCALE_HINT_MAX", 10),
  bootTimeoutSec: num("AUTOSCALE_BOOT_TIMEOUT_SEC", 1500),
  trustTimeoutSec: num("AUTOSCALE_TRUST_TIMEOUT_SEC", 420), // relay REGISTRY_POLL_SEC is 300
};

// mirrors cli/enclave.mjs DEFAULTS: address book is the on-chain root
const ADDRESS_BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const DEPLOYMENTS_FALLBACK = "0x0A7dE5D205c10B812AbaF0b89f3A243466bCEe01";
const RPCS = env.ENCLAVE_RPC ? [env.ENCLAVE_RPC] : [
  "https://base-rpc.publicnode.com", "https://base.drpc.org",
  "https://1rpc.io/base", "https://mainnet.base.org",
];

const DEPLOYMENT_TUPLE = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
  { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
  { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
  { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
const LEDGER_ABI = [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: DEPLOYMENT_TUPLE }] },
];
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view",
  inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];

// claim-hint reasons that mean a record can NEVER be served by adding capacity
const STRUCTURAL_RE = /below the app's minimum|deactivated|configCid is retired|not deployable|port spec is not servable|out of funded time/i;

// ---------------------------------------------------------------------------
// pure planner — all scaling policy lives here (unit-tested in test/)
// ---------------------------------------------------------------------------
export function decide(snap, cfg = CFG) {
  const { candidates, enclaves, containers, health, relayDomains, relayOk = true } = snap;
  const warnings = [];
  const actions = [];
  // a relay outage looks identical to "no capacity anywhere" — refuse to act on it.
  // (relayOk=true with zero enclaves is a genuinely cold fleet: scaling IS the fix.)
  if (!relayOk) warnings.push("relay unreachable — capacity unknown; taking NO actions this run");

  const servable = (c) => c.flavor === "gpu"
    ? enclaves.some((e) => e.gpu && e.gpuShareFree >= c.gpuShare && e.cpuShareFree >= c.cpuShare)
    : enclaves.some((e) => e.cpuShareFree >= c.cpuShare);

  // demand = funded past the gates, not structural, not already being claimed,
  // and not servable by any single live enclave
  const demandRows = candidates.filter((c) =>
    c.ageSec >= cfg.dwellSec && c.fundedSec >= cfg.minFundedSec &&
    !c.structural && !c.inflight && !servable(c));
  const demand = {};
  for (const f of ["gpu", "cpu"]) {
    const rows = demandRows.filter((c) => c.flavor === f);
    demand[f] = {
      count: rows.length,
      unmetShare: rows.reduce((s, c) => s + (f === "gpu" ? c.gpuShare : c.cpuShare), 0),
      committedUsd: rows.reduce((s, c) => s + Math.min(c.fundedSec, cfg.horizonSec) * c.ratePerSec6, 0) / 1e6,
      ids: rows.map((c) => c.id),
    };
  }

  const auto = containers.filter((c) => c.auto && !c.staging);
  const autoOf = (f) => auto.filter((c) => c.flavor === f);
  const isRunning = (c) => !/^(stopped|stopping|failed)$/.test(c.status);
  const fleetOf = (f) => containers.filter((c) => c.flavor === f && !c.staging);

  for (const f of ["gpu", "cpu"]) {
    const d = demand[f];
    const mine = autoOf(f);
    const running = mine.filter(isRunning);
    const cooling = mine.find((c) => c.updatedAgoSec < cfg.cooldownSec);

    const wantUp = relayOk && d.unmetShare >= cfg.minUnmetShare[f] && d.committedUsd >= cfg.minCommittedUsd[f];
    if (wantUp) {
      if (cooling) {
        warnings.push(`${f}: demand present but ${cooling.name} changed state ${Math.round(cooling.updatedAgoSec / 60)}m ago (cooldown)`);
      } else if (running.length >= cfg.maxAuto[f]) {
        warnings.push(`${f}: demand present but auto-capacity cap reached (${running.length}/${cfg.maxAuto[f]}) — raise AUTOSCALE_MAX_${f.toUpperCase()} or investigate why the running auto box isn't absorbing it`);
      } else {
        const stopped = mine.find((c) => c.status === "stopped");
        const tag = fleetTag(containers, f);
        if (stopped) {
          actions.push({ type: "start", name: stopped.name, flavor: f, tag: tag.tag, tagDerived: tag.derived,
            reason: reasonOf(f, d) });
        } else if (containers.length >= cfg.orgContainerQuota) {
          warnings.push(`${f}: demand present but the org is at Tinfoil's ${cfg.orgContainerQuota}-container quota`);
        } else {
          const n = 1 + Math.max(0, ...mine.map((c) => Number(c.name.match(/-(\d+)$/)?.[1] || 0)));
          actions.push({ type: "create", name: `auto-${f}-${n}`, flavor: f, tag: tag.tag, tagDerived: tag.derived,
            reason: reasonOf(f, d) });
        }
      }
    } else if (d.count > 0) {
      warnings.push(`${f}: ${d.count} unmet queued deployment(s) below scale thresholds (share ${d.unmetShare.toFixed(2)} < ${cfg.minUnmetShare[f]} or $${d.committedUsd.toFixed(2)} < $${cfg.minCommittedUsd[f]})`);
    }

    // scale-down: idle auto boxes, only when this flavor has zero unmet demand
    // and the relay still lists live capacity (never react to a relay outage)
    if (relayOk && !wantUp && d.count === 0 && relayDomains.length > 0 && !cooling) {
      for (const c of running) {
        const h = health[c.name];
        if (h && h.deployments === 0 && c.updatedAgoSec >= cfg.idleStopSec) {
          actions.push({ type: "stop", name: c.name, flavor: f,
            reason: `idle (0 deployments, last lifecycle change ${Math.round(c.updatedAgoSec / 60)}m ago), no queued ${f} demand` });
        }
      }
    }

    // trust check: a running auto box the relay doesn't route to burns money
    for (const c of running) {
      if (c.domain && relayDomains.length > 0 && !relayDomains.some((d2) => d2.includes(c.domain.toLowerCase()))) {
        warnings.push(`TRUST: ${c.name} (${c.domain}) is running but the relay does not list it — likely TRUSTED_OPERATORS mismatch on the relay boxes (docs/autoscale.md)`);
      }
    }

    if (fleetOf(f).length === 0 && d.count > 0 && !actions.some((a) => a.flavor === f)) {
      warnings.push(`${f}: no containers of this flavor exist at all; creation will use the ${f === "cpu" ? "derived -cpu" : "release"} tag`);
    }
  }

  return { demand, actions, warnings };
}

function reasonOf(f, d) {
  return `${d.count} queued ${f} deployment(s), unmet share ${d.unmetShare.toFixed(2)}, $${d.committedUsd.toFixed(2)} prepaid (non-refundable)`;
}

// tag for a new/started box: whatever the live fleet of that flavor runs
// (attestation-locked to /releases/latest by the update-fleet job). With no
// same-flavor baseline, derive <gpu tag>-cpu and let plan() verify it exists.
function fleetTag(containers, f) {
  const running = (c) => !/^(stopped|stopping|failed)$/.test(c.status) && c.currentTag;
  const same = containers.find((c) => c.flavor === f && !c.auto && running(c))
    || containers.find((c) => c.flavor === f && running(c));
  if (same) return { tag: same.currentTag, derived: false };
  if (f === "cpu") {
    const gpu = containers.find((c) => c.flavor === "gpu" && running(c));
    if (gpu) return { tag: `${gpu.currentTag}-cpu`, derived: true };
  }
  return { tag: null, derived: false };
}

// ---------------------------------------------------------------------------
// adapters (chain / relay / tinfoil)
// ---------------------------------------------------------------------------
const chainClient = () => createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { retryCount: 2 }))) });

async function ledgerAddress(client, log) {
  try {
    const a = await client.readContract({ address: ADDRESS_BOOK, abi: BOOK_ABI, functionName: "addr",
      args: [stringToHex("deployments", { size: 32 })] });
    if (a && !/^0x0+$/.test(a)) return a;
  } catch (e) { log(`address book unreadable (${e.shortMessage || e.message}) — baked fallback`); }
  return DEPLOYMENTS_FALLBACK;
}

async function readLedger(client, ledger) {
  const count = Number(await client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "count" }));
  const rows = [];
  for (let start = 0; start < count; start += 50) {
    rows.push(...await client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "getPage",
      args: [BigInt(start), 50n] }));
  }
  return rows;
}

function toCandidate(d, now) {
  const rate = Number(d.rate);
  if (!d.active || rate <= 0) return null;
  if (Number(d.balance6) < rate) return null;            // contract claimable() boundary
  if (Number(d.leaseUntil) >= now) return null;          // live lease — someone is serving it
  return {
    id: d.id,
    flavor: d.gpuMilli > 0 ? "gpu" : "cpu",
    gpuShare: d.gpuMilli / 1000,
    cpuShare: d.cpuMilli / 1000,
    ratePerSec6: rate,
    fundedSec: Math.floor(Number(d.balance6) / rate),
    ageSec: Math.max(0, now - Number(d.createdAt)),
    structural: false,
    inflight: false,
  };
}

async function fetchJson(url, opts = {}, timeoutMs = 10000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// classify candidates via the fleet's own claim logic (rate-limited endpoint:
// 2/s refill — pace politely, cap the per-run spend)
async function classifyByHint(candidates, log) {
  const toCheck = candidates.slice(0, CFG.hintMax);
  for (const c of toCheck) {
    try {
      const res = await fetch(`${CFG.apiBase}/v1/claim-hint`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id }), signal: AbortSignal.timeout(10000),
      });
      const body = await res.json().catch(() => ({}));
      if (body?.accepted === true) c.inflight = true;
      else if (typeof body?.reason === "string" && STRUCTURAL_RE.test(body.reason)) {
        c.structural = true;
        log(`  hint ${c.id.slice(0, 10)}…: structural — ${body.reason}`);
      } else if (body?.reason) log(`  hint ${c.id.slice(0, 10)}…: ${body.reason}`);
    } catch (e) {
      log(`  hint ${c.id.slice(0, 10)}…: unavailable (${e.message}) — keeping (chain data is authoritative)`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (candidates.length > toCheck.length) log(`  (${candidates.length - toCheck.length} more candidates not hint-checked this run)`);
}

async function tinfoil(args, opts = {}) {
  const { stdout } = await execFileP("tinfoil", args, { maxBuffer: 8 * 1024 * 1024, ...opts });
  return stdout;
}
const tinfoilJson = async (args) => JSON.parse(await tinfoil([...args, "-o", "json"]));

function flavorOfTag(tag) {
  if (!tag) return null;
  if (tag.endsWith("-cpu")) return "cpu";
  if (tag.endsWith("-gpu8")) return "gpu8";
  return "gpu";
}

function toContainer(c, now) {
  const auto = /^auto-(gpu|cpu)-\d+$/.test(c.name || "");
  return {
    name: c.name, id: c.id, status: String(c.status || "").toLowerCase(),
    currentTag: c.current_tag || "", domain: c.domain || "",
    staging: !!c.staging, gpus: c.gpus || 0,
    flavor: auto ? c.name.split("-")[1] : flavorOfTag(c.current_tag),
    auto,
    updatedAgoSec: c.updated_at ? Math.max(0, now - Math.floor(Date.parse(c.updated_at) / 1000)) : Infinity,
    variables: c.variables, secrets: c.secrets || [],
  };
}

async function enclaveHealth(domain) {
  try {
    const h = await fetchJson(`https://${domain}/v1/health`, {}, 8000);
    return { deployments: Number(h.deployments ?? NaN) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------
async function buildSnapshot(log) {
  const now = Math.floor(Date.now() / 1000);

  const client = chainClient();
  const ledger = await ledgerAddress(client, log);
  const rows = await readLedger(client, ledger);
  const candidates = rows.map((d) => toCandidate(d, now)).filter(Boolean);
  log(`ledger ${ledger}: ${rows.length} records, ${candidates.length} claimable`);

  let enclaves = [], relayDomains = [], relayOk = false;
  try {
    const r = await fetchJson(`${CFG.apiBase}/enclaves`);
    enclaves = (r.enclaves || []).map((e) => ({
      gpu: !!e.availability?.gpu,
      gpuShareFree: Number(e.availability?.gpuShareFree || 0),
      cpuShareFree: Number(e.availability?.cpuShareFree || 0),
      endpoint: String(e.endpoint || e.url || ""),
    }));
    relayDomains = enclaves.map((e) => e.endpoint.toLowerCase()).filter(Boolean);
    relayOk = true;
    log(`relay: ${enclaves.length} live enclave(s)`);
  } catch (e) {
    log(`relay unreachable (${e.message}) — treating fleet capacity as unknown/none`);
  }

  // only hint-check candidates past the cheap gates and unservable right now
  const gated = [];
  for (const c of candidates) {
    const gates = [];
    if (c.ageSec < CFG.dwellSec) gates.push(`dwell ${c.ageSec}s<${CFG.dwellSec}s`);
    if (c.fundedSec < CFG.minFundedSec) gates.push(`funded ${c.fundedSec}s<${CFG.minFundedSec}s`);
    if (gates.length) log(`  gate  ${c.id.slice(0, 10)}… ${c.flavor} share=${c.flavor === "gpu" ? c.gpuShare : c.cpuShare}: dropped (${gates.join(", ")})`);
    else gated.push(c);
  }
  if (enclaves.length > 0 && gated.length > 0) await classifyByHint(gated, log);

  const list = await tinfoilJson(["container", "list"]);
  const containers = list.filter((c) => (c.repo || "").toLowerCase() === CFG.repo.toLowerCase())
    .map((c) => toContainer(c, now));
  log(`tinfoil: ${containers.length} fleet container(s), ${containers.filter((c) => c.auto).length} auto-managed`);

  const health = {};
  for (const c of containers.filter((x) => x.auto && !/^(stopped|stopping|failed)$/.test(x.status) && x.domain)) {
    health[c.name] = await enclaveHealth(c.domain);
  }

  return { now, candidates, enclaves, containers, health, relayDomains, relayOk };
}

async function verifyTagExists(tag) {
  try {
    await fetchJson(`https://api.github.com/repos/${CFG.repo}/releases/tags/${tag}`,
      env.GITHUB_TOKEN ? { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}` } } : {});
    return true;
  } catch { return false; }
}

async function plan(outPath) {
  const log = (m) => console.log(m);
  const snap = await buildSnapshot(log);
  const result = decide(snap, CFG);

  // resolve derived tags (e.g. first-ever cpu box: <gpu tag>-cpu must exist)
  for (const a of [...result.actions]) {
    if (a.type !== "stop" && !a.tag) {
      result.warnings.push(`${a.flavor}: no live baseline tag to inherit — dropped ${a.type} of ${a.name}`);
      result.actions = result.actions.filter((x) => x !== a);
    } else if (a.tagDerived && !(await verifyTagExists(a.tag))) {
      result.warnings.push(`${a.flavor}: derived tag ${a.tag} has no GitHub release — dropped ${a.type} of ${a.name} (cut a ${a.flavor} release first)`);
      result.actions = result.actions.filter((x) => x !== a);
    }
  }

  console.log("\n== demand ==");
  for (const f of ["gpu", "cpu"]) {
    const d = result.demand[f];
    console.log(`  ${f}: ${d.count} unmet queued, share ${d.unmetShare.toFixed(2)}, $${d.committedUsd.toFixed(2)} prepaid${d.ids.length ? ` [${d.ids.map((i) => i.slice(0, 10)).join(", ")}]` : ""}`);
  }
  for (const w of result.warnings) console.log(`WARN  ${w}`);
  console.log("\n== actions ==");
  if (result.actions.length === 0) console.log("  none");
  for (const a of result.actions) console.log(`  ${a.type.toUpperCase()} ${a.name}${a.tag ? ` @ ${a.tag}` : ""} — ${a.reason}`);

  const doc = { generatedAt: new Date().toISOString(), cfg: CFG, ...result };
  if (outPath) writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return doc;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
function configSecrets(flavor) {
  const p = join(HERE, "..", "enclaves", flavor, "tinfoil-config.yml");
  if (!existsSync(p)) throw new Error(`no config for flavor ${flavor}: ${p}`);
  const names = new Set();
  let inSecrets = false;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*secrets:\s*(#.*)?$/.test(line)) { inSecrets = true; continue; }
    if (inSecrets) {
      const m = line.match(/^\s*-\s*([A-Z][A-Z0-9_]*)\s*(#.*)?$/);
      if (m) names.add(m[1]);
      else if (!/^\s*#/.test(line) && line.trim() !== "") inSecrets = false;
    }
  }
  if (names.size === 0) throw new Error(`parsed no secret names from ${p}`);
  return [...names];
}

// containerView.variables arrives as an object or base64-encoded JSONB
function decodeVariables(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { /* base64 form */ }
  try { return JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { return {}; }
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function waitServing(name, log) {
  const deadline = Date.now() + CFG.bootTimeoutSec * 1000;
  let c;
  for (;;) {
    c = await tinfoilJson(["container", "get", name]);
    const st = String(c.status || "").toLowerCase();
    if (/^(ready|running)$/.test(st)) break;
    if (st === "failed") throw new Error(`${name} failed to boot: ${c.error_message || "no error message"}`);
    if (Date.now() > deadline) throw new Error(`${name} did not reach Running within ${CFG.bootTimeoutSec}s (status ${st})`);
    log(`  … ${name}: ${st}`);
    await sleep(20);
  }
  const domain = c.domain;
  for (;;) {
    try { await fetchJson(`https://${domain}/v1/health`, {}, 8000); break; }
    catch {
      if (Date.now() > deadline) throw new Error(`${name}: /v1/health never answered on ${domain}`);
      await sleep(15);
    }
  }
  log(`  ${name}: running and healthy on ${domain}`);
  return domain;
}

// the whole point is serving user traffic through the relay: if the relay
// never lists the new box (TRUSTED_OPERATORS mismatch), roll it back to
// stopped rather than burn money on an unroutable enclave
async function waitRelayTrust(name, domain, log) {
  const deadline = Date.now() + CFG.trustTimeoutSec * 1000;
  for (;;) {
    try {
      const r = await fetchJson(`${CFG.apiBase}/enclaves`);
      const listed = (r.enclaves || []).some((e) => String(e.endpoint || e.url || "").toLowerCase().includes(domain.toLowerCase()));
      if (listed) { log(`  ${name}: listed by the relay — serving`); return; }
    } catch { /* transient */ }
    if (Date.now() > deadline) {
      log(`  ${name}: NOT listed by the relay after ${CFG.trustTimeoutSec}s — rolling back to stopped.`);
      log(`  Likely cause: the box's registry operator EOA is not in TRUSTED_OPERATORS on the relay boxes.`);
      log(`  Fix: add the operator to TRUSTED_OPERATORS on api-relay/egress-relay/fleet relays and restart, then re-run (docs/autoscale.md).`);
      await tinfoil(["container", "stop", name]);
      throw new Error(`${name} rolled back: relay never trusted it`);
    }
    await sleep(20);
  }
}

async function apply(planPath) {
  const doc = JSON.parse(readFileSync(planPath, "utf8"));
  const log = (m) => console.log(m);
  if (!doc.actions?.length) { log("plan has no actions"); return; }

  const now = Math.floor(Date.now() / 1000);
  const list = await tinfoilJson(["container", "list"]);
  const containers = list.filter((c) => (c.repo || "").toLowerCase() === CFG.repo.toLowerCase())
    .map((c) => toContainer(c, now));
  const failures = [];

  for (const a of doc.actions) {
    const cur = containers.find((c) => c.name === a.name);
    log(`\n== ${a.type.toUpperCase()} ${a.name}${a.tag ? ` @ ${a.tag}` : ""} ==`);
    try {
      if (a.type === "stop") {
        if (!cur || /^(stopped|stopping)$/.test(cur.status)) { log("  already stopped — skip"); continue; }
        // last-second idle re-check: never stop a box that picked up work
        const h = cur.domain ? await enclaveHealth(cur.domain) : null;
        if (!h || h.deployments !== 0) { log(`  no longer idle (deployments=${h?.deployments ?? "unknown"}) — skip`); continue; }
        await tinfoil(["container", "stop", a.name]);
        log("  stopped (billing pauses; config preserved)");
      } else if (a.type === "start") {
        if (!cur) { log("  container no longer exists — skip"); continue; }
        if (!/^(stopped|failed)$/.test(cur.status)) { log(`  not stopped (status ${cur.status}) — skip`); continue; }
        await tinfoil(["container", cur.status === "failed" ? "relaunch" : "start", a.name, "--tag", a.tag]);
        const domain = await waitServing(a.name, log);
        await waitRelayTrust(a.name, domain, log);
      } else if (a.type === "create") {
        if (cur) { log(`  already exists (status ${cur.status}) — skip`); continue; }
        const args = ["container", "create", a.name, "--repo", CFG.repo, "--tag", a.tag];
        for (const s of configSecrets(a.flavor)) args.push("--secret", s);
        // inherit non-secret variables from a running baseline of the flavor
        const baseline = containers.find((c) => c.flavor === a.flavor && !c.auto && !/^(stopped|stopping|failed)$/.test(c.status))
          || containers.find((c) => c.flavor === "gpu" && !c.auto && !/^(stopped|stopping|failed)$/.test(c.status));
        for (const [k, v] of Object.entries(decodeVariables(baseline?.variables))) args.push("--variable", `${k}=${v}`);
        await tinfoil(args);
        log(`  created (bound vault secrets: ${configSecrets(a.flavor).join(", ")})`);
        const domain = await waitServing(a.name, log);
        await waitRelayTrust(a.name, domain, log);
      }
    } catch (e) {
      log(`  FAILED: ${e.message}`);
      failures.push(`${a.type} ${a.name}: ${e.message}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} action(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  log("\nall actions applied");
}

// ---------------------------------------------------------------------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "plan" || cmd === undefined) {
    const outIdx = rest.indexOf("--out");
    const doc = await plan(outIdx >= 0 ? rest[outIdx + 1] : null);
    return;
  }
  if (cmd === "apply") {
    if (!rest[0]) { console.error("usage: autoscale.mjs apply plan.json"); process.exit(2); }
    return apply(rest[0]);
  }
  console.error("usage: autoscale.mjs [plan [--out plan.json] | apply plan.json]");
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
