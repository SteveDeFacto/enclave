// Owner version changes (setAppRef) — the pure halves of the supervisor's
// in-place upgrade, driven through the SWITCH_SELFTEST seam (same contract as
// SWEEP_SELFTEST/REACH_SELFTEST):
//
//   needsVersionSwitch    — does the audit restart a serving record onto the
//                           ledger's (changed) appRef? Only RUNNING records
//                           switch in place; every other state rides the
//                           normal claim/provision paths.
//   provisionBackoffHolds — a provision-failure cooldown binds to the appRef
//                           that failed: the owner switching versions is a
//                           fresh chance, not the same doomed item on a timer.
//
//   run: node --test test/version-switch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function selftest(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", SWITCH_SELFTEST: JSON.stringify(c),
           REACH_SELFTEST: "", ACME_SELFTEST: "", SWEEP_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const V1 = "catalog://0x" + "cd".repeat(32) + "/0";
const V2 = "catalog://0x" + "cd".repeat(32) + "/1";
const NOW = 1700000000000;

test("only a RUNNING record with a genuinely different ledger ref switches in place", async () => {
  const r = await selftest({ switch: [
    { status: "running", localRef: V1, chainRef: V2 },   // the upgrade: switch
    { status: "running", localRef: V1, chainRef: V1 },   // no change
    { status: "claimed", localRef: V1, chainRef: V2 },   // mid-provision: next pass catches it
    { status: "failed",  localRef: V1, chainRef: V2 },   // terminal: the sweep re-claims with the new ref
    { status: "running", localRef: V1, chainRef: "" },   // RPC anomaly: never tear down on a blank ref
    { status: "running", localRef: "", chainRef: V2 },   // no local identity: nothing to compare
  ] });
  assert.deepEqual(r.switch, [true, false, false, false, false, false]);
});

test("a provision-failure cooldown binds to the appRef that failed", async () => {
  const active = { n: 1, until: NOW + 60_000, ref: V1 };
  const r = await selftest({ backoff: [
    { entry: active, nowMs: NOW, appRef: V1 },                          // same version still failing: hold
    { entry: active, nowMs: NOW, appRef: V2 },                          // owner switched versions: fresh chance
    { entry: { ...active, until: NOW - 1 }, nowMs: NOW, appRef: V1 },   // cooldown over
    { entry: { n: 1, until: NOW + 60_000, ref: null }, nowMs: NOW, appRef: V1 },   // legacy entry (no ref): hold
    { entry: null, nowMs: NOW, appRef: V1 },                            // no failure recorded
  ] });
  assert.deepEqual(r.backoff, [true, false, false, true, false]);
});
