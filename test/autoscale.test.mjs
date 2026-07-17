// Planner policy tests for scripts/autoscale.mjs decide() — the guardrails
// that make demand-driven scaling safe against griefing. Pure snapshots in,
// actions out; no network, no tinfoil CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../scripts/autoscale.mjs";

const cfg = {
  dwellSec: 900, minFundedSec: 7200,
  minCommittedUsd: { gpu: 12, cpu: 3 },
  minUnmetShare: { gpu: 0.15, cpu: 0.25 },
  horizonSec: 86400,
  maxAuto: { gpu: 1, cpu: 1 },
  orgContainerQuota: 10,
  cooldownSec: 1800, idleStopSec: 2700,
};

// $6/hr full card ≈ 1667 µUSDC/s; 3h funded at 100% GPU ≈ $18
const gpuAsk = (over = {}) => ({
  id: "0x" + "ab".repeat(32), flavor: "gpu", gpuShare: 1, cpuShare: 0.1,
  ratePerSec6: 1667, fundedSec: 3 * 3600, ageSec: 3600,
  structural: false, inflight: false, ...over,
});
const cpuAsk = (over = {}) => ({
  id: "0x" + "cd".repeat(32), flavor: "cpu", gpuShare: 0, cpuShare: 0.5,
  ratePerSec6: 139, fundedSec: 12 * 3600, ageSec: 3600,
  structural: false, inflight: false, ...over,
});

const gpuBox = (over = {}) => ({ gpu: true, gpuShareFree: 0, cpuShareFree: 0.2, ...over });
const NOWS = 1700000000;                       // decide()'s on-chain clock
const RUNNER = "0x" + "ab".repeat(32);
const baseline = (over = {}) => ({
  name: "enclave1", status: "running", currentTag: "v0.5.150", domain: "enclave1.nan.containers.tinfoil.dev",
  staging: false, gpus: 1, flavor: "gpu", auto: false, createdAgoSec: 999999, runnerId: "0x" + "cd".repeat(32), ...over,
});
const autoBox = (over = {}) => ({
  name: "auto-gpu-1", status: "stopped", currentTag: "v0.5.149", domain: "auto-gpu-1.nan.containers.tinfoil.dev",
  staging: false, gpus: 1, flavor: "gpu", auto: true, createdAgoSec: 999999, runnerId: RUNNER, ...over,
});

const snap = (over = {}) => ({
  now: NOWS, candidates: [], enclaves: [gpuBox()], containers: [baseline()],
  health: {}, relayDomains: ["https://enclave1.nan.containers.tinfoil.dev"], relayOk: true,
  leases: [], lastActionAgo: {}, ...over,
});

test("funded unservable GPU demand starts the stopped standby at the fleet tag", () => {
  const r = decide(snap({ candidates: [gpuAsk()], containers: [baseline(), autoBox()] }), cfg);
  assert.equal(r.actions.length, 1);
  assert.deepEqual({ type: r.actions[0].type, name: r.actions[0].name, tag: r.actions[0].tag },
    { type: "start", name: "auto-gpu-1", tag: "v0.5.150" });
});

test("no standby → create with the next index", () => {
  const r = decide(snap({ candidates: [gpuAsk()] }), cfg);
  assert.equal(r.actions[0].type, "create");
  assert.equal(r.actions[0].name, "auto-gpu-1");
});

test("servable demand is not demand", () => {
  const r = decide(snap({ candidates: [gpuAsk({ gpuShare: 0.5 })], enclaves: [gpuBox({ gpuShareFree: 0.6 })] }), cfg);
  assert.equal(r.actions.length, 0);
  assert.equal(r.demand.gpu.count, 0);
});

test("dust funding, young records, structural and in-flight candidates never scale", () => {
  for (const c of [
    gpuAsk({ fundedSec: 600 }),          // below MIN_FUNDED_SEC: not enough prepaid money
    gpuAsk({ ageSec: 60 }),              // hasn't waited out the normal claim path
    gpuAsk({ structural: true }),        // permanently unclaimable (min-share etc.)
    gpuAsk({ inflight: true }),          // an enclave is already claiming it
  ]) {
    const r = decide(snap({ candidates: [c] }), cfg);
    assert.equal(r.actions.length, 0, JSON.stringify(c));
  }
});

test("aggregate thresholds gate the money: many dust asks below MIN_COMMITTED_USD stay unmet", () => {
  // 10% GPU at $0.6/hr funded 2h each = $1.2 committed total... far below $12
  const asks = Array.from({ length: 2 }, (_, i) =>
    gpuAsk({ id: `0x${i}${"ab".repeat(31)}`, gpuShare: 0.1, ratePerSec6: 167, fundedSec: 7200 }));
  const r = decide(snap({ candidates: asks }), cfg);
  assert.equal(r.actions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("below scale thresholds")));
});

test("cap: a running auto box blocks further scale-up at maxAuto", () => {
  const r = decide(snap({
    candidates: [gpuAsk()],
    containers: [baseline(), autoBox({ status: "running" })],
  }), cfg);
  assert.equal(r.actions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("cap reached")));
});

test("cooldown: a recent flavor action (stamped var) blocks any action", () => {
  const r = decide(snap({
    candidates: [gpuAsk()],
    containers: [baseline(), autoBox()],
    lastActionAgo: { gpu: 300 },
  }), cfg);
  assert.equal(r.actions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("cooldown")));
});

test("cooldown fallback: a freshly created auto box blocks even without the stamp", () => {
  const r = decide(snap({
    candidates: [gpuAsk()],
    containers: [baseline(), autoBox({ status: "running", createdAgoSec: 300 })],
  }), cfg);
  assert.equal(r.actions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("cooldown")));
});

test("org quota blocks creation", () => {
  const many = Array.from({ length: 10 }, (_, i) => baseline({ name: `e${i}` }));
  const r = decide(snap({ candidates: [gpuAsk()], containers: many }), cfg);
  assert.equal(r.actions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("quota")));
});

test("relay outage freezes the autoscaler entirely", () => {
  const idle = autoBox({ status: "running" });
  const r = decide(snap({
    candidates: [gpuAsk()], enclaves: [], relayDomains: [], relayOk: false,
    containers: [baseline(), idle], health: { "auto-gpu-1": { deployments: 0 } },
  }), cfg);
  assert.equal(r.actions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("relay unreachable")));
});

test("cold fleet (relay ok, zero enclaves) does scale up", () => {
  const r = decide(snap({ candidates: [gpuAsk()], enclaves: [], relayDomains: [], relayOk: true,
    containers: [baseline({ status: "stopped" })] }), cfg);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "create");
});

test("idle auto box stops only with zero demand, on-chain-idle past idleStopSec, health-confirmed", () => {
  const idle = autoBox({ status: "running" });
  const oldLease = [{ runner: RUNNER, leaseUntil: NOWS - 3000 }];   // last lease ended 50m ago
  const ok = decide(snap({ containers: [baseline(), idle], leases: oldLease,
    health: { "auto-gpu-1": { deployments: 0 } } }), cfg);
  assert.deepEqual(ok.actions.map((a) => a.type), ["stop"]);

  // busy box never stops
  const busy = decide(snap({ containers: [baseline(), idle], leases: oldLease,
    health: { "auto-gpu-1": { deployments: 2 } } }), cfg);
  assert.equal(busy.actions.length, 0);
  // unknown health never stops
  const unknown = decide(snap({ containers: [baseline(), idle], leases: oldLease, health: {} }), cfg);
  assert.equal(unknown.actions.length, 0);
  // a lease that ended recently keeps the box up (hysteresis)
  const recent = decide(snap({ containers: [baseline(), idle], leases: [{ runner: RUNNER, leaseUntil: NOWS - 600 }],
    health: { "auto-gpu-1": { deployments: 0 } } }), cfg);
  assert.equal(recent.actions.length, 0);
  // a never-claimed box falls back to creation age
  const fresh = decide(snap({ containers: [baseline(), autoBox({ status: "running", createdAgoSec: 600 })],
    health: { "auto-gpu-1": { deployments: 0 } } }), cfg);
  assert.equal(fresh.actions.length, 0);
  // demand for the flavor blocks the stop (box is about to be needed)
  const demand = decide(snap({ candidates: [gpuAsk()], containers: [baseline(), idle], leases: oldLease,
    health: { "auto-gpu-1": { deployments: 0 } } }), cfg);
  assert.ok(!demand.actions.some((a) => a.type === "stop"));
});

test("baseline fleet is never stopped, only auto-*", () => {
  const r = decide(snap({ containers: [baseline()], health: { enclave1: { deployments: 0 } } }), cfg);
  assert.equal(r.actions.length, 0);
});

test("untrusted running auto box raises a TRUST warning", () => {
  const rogue = autoBox({ status: "running", domain: "auto-gpu-1.nan.containers.tinfoil.dev" });
  const r = decide(snap({ containers: [baseline(), rogue],
    relayDomains: ["https://enclave1.nan.containers.tinfoil.dev"] }), cfg);
  assert.ok(r.warnings.some((w) => w.startsWith("TRUST:")));
});

test("cpu demand with no cpu baseline derives the -cpu tag", () => {
  const r = decide(snap({ candidates: [cpuAsk({ cpuShare: 0.5 })], enclaves: [gpuBox({ cpuShareFree: 0.1 })] }), cfg);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].name, "auto-cpu-1");
  assert.equal(r.actions[0].tag, "v0.5.150-cpu");
  assert.equal(r.actions[0].tagDerived, true);
});

test("gpu8 containers are never counted or touched", () => {
  const g8 = baseline({ name: "enclave-gpu8", flavor: "gpu8", currentTag: "v0.5.150-gpu8", gpus: 8 });
  const r = decide(snap({ candidates: [gpuAsk()], containers: [baseline(), g8] }), cfg);
  assert.ok(r.actions.every((a) => a.flavor !== "gpu8"));
  assert.ok(!r.actions.some((a) => a.name.includes("gpu8")));
});

// ---------- consolidation: evacuate an auto box whose tenants fit elsewhere --
const hostedRow = (over = {}) => ({
  id: "0x" + "e1".repeat(32), runner: RUNNER, flavor: "gpu",
  gpuShare: 0.35, cpuShare: 0.02, remainingSec: 7200, ...over,
});
const KRYPTOS_ID = "0x" + "cd".repeat(32);
const consolidatableSnap = (over = {}) => snap({
  containers: [baseline(), autoBox({ status: "running" })],
  enclaves: [
    gpuBox({ gpuShareFree: 0.6, cpuShareFree: 0.9, runnerId: KRYPTOS_ID, endpoint: "https://enclave1.nan.containers.tinfoil.dev" }),
    gpuBox({ gpuShareFree: 0.65, cpuShareFree: 0.9, runnerId: RUNNER, endpoint: "https://auto-gpu-1.nan.containers.tinfoil.dev" }),
  ],
  hosted: [hostedRow()],
  ...over,
});
const consolidateCfg = { ...cfg, consolidate: true, evacMinRemainingSec: 1800 };

test("quiet fleet: an auto box's tenants that fit elsewhere get evacuated", () => {
  const r = decide(consolidatableSnap(), consolidateCfg);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "evacuate");
  assert.equal(r.actions[0].name, "auto-gpu-1");
  assert.deepEqual(r.actions[0].moves, [hostedRow().id]);
  assert.ok(r.actions[0].target.includes("enclave1"));
});

test("evacuation never fires with demand, cooldown, near-drain tenants, or a too-full target", () => {
  // queued demand for the flavor
  assert.equal(decide(consolidatableSnap({ candidates: [gpuAsk()] }), consolidateCfg)
    .actions.filter((a) => a.type === "evacuate").length, 0);
  // cooldown
  assert.equal(decide(consolidatableSnap({ lastActionAgo: { gpu: 60 } }), consolidateCfg)
    .actions.filter((a) => a.type === "evacuate").length, 0);
  // tenant about to drain: cheaper to wait
  assert.equal(decide(consolidatableSnap({ hosted: [hostedRow({ remainingSec: 600 })] }), consolidateCfg)
    .actions.length, 0);
  // target lacks room
  const full = consolidatableSnap();
  full.enclaves[0].gpuShareFree = 0.2;
  assert.equal(decide(full, consolidateCfg).actions.length, 0);
  // kill switch
  assert.equal(decide(consolidatableSnap(), { ...consolidateCfg, consolidate: false }).actions.length, 0);
});

test("baseline boxes are never evacuation sources", () => {
  // tenants live on the BASELINE box; the auto box is empty -> the only
  // action allowed is idle-stopping the auto box, never evacuating enclave1
  const s2 = consolidatableSnap({ hosted: [hostedRow({ runner: KRYPTOS_ID })] });
  const r = decide(s2, consolidateCfg);
  assert.ok(!r.actions.some((a) => a.type === "evacuate"));
});

test("a gpu box's riding cpu tenants count toward the target's cpu pool", () => {
  const s2 = consolidatableSnap({ hosted: [
    hostedRow(),
    hostedRow({ id: "0x" + "e2".repeat(32), flavor: "cpu", gpuShare: 0, cpuShare: 0.5 }),
  ]});
  s2.enclaves[0].cpuShareFree = 0.3;    // can't take the cpu rider
  assert.equal(decide(s2, consolidateCfg).actions.length, 0);
  s2.enclaves[0].cpuShareFree = 0.9;    // now both fit
  const r = decide(s2, consolidateCfg);
  assert.equal(r.actions[0]?.type, "evacuate");
  assert.equal(r.actions[0].moves.length, 2);
});
