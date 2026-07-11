// Reachability watchdog (supervisor.js) — the pure half: which advertised
// hostnames are watchable, how one DoH answer maps to a verdict, and the
// strike/trip/reset state machine. Driven through the REACH_SELFTEST seam
// (prints the helpers mapped over JSON inputs and exits before boot), same
// contract as ACME_SELFTEST. The impure half (DoH fetch, abandonClaims'
// teardown + release) is deliberately untested here: it needs live DNS and a
// claim loop, and every entry point is gated on the claim envs.
//
// Why this exists (2026-07-11, kryptos): a CVM whose public DNS record
// vanished kept claiming and renewing on-chain work for six hours — tenants
// paid for apps nobody could reach. The watchdog trips only on that precise
// signal: every resolver AFFIRMING the name is gone, N rounds in a row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function selftest(cases) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", REACH_SELFTEST: JSON.stringify(cases),
           ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// ---------- reachHostname: what is watchable ---------------------------------

test("hostnames: public dns names pass, everything unwatchable maps to null", async () => {
  const { hosts } = await selftest({ hosts: [
    "https://kryptos.enclave.containers.tinfoil.dev",              // the real shape
    "https://KRYPTOS.Enclave.Containers.Tinfoil.Dev:8443/x/abc",   // case + port + path
    "https://127.0.0.1:8443",                                      // IPv4 literal
    "https://[2a01:4f9:c013:9b52::1]/health",                      // IPv6 literal (URL keeps brackets)
    "http://localhost:3000",                                       // single label
    "https://enclave.local",                                       // mDNS
    "not a url at all",
  ] });
  assert.deepEqual(hosts, [
    "kryptos.enclave.containers.tinfoil.dev",
    "kryptos.enclave.containers.tinfoil.dev",
    null, null, null, null, null,
  ]);
});

// ---------- dohVerdict: one answer, one verdict -------------------------------

test("verdicts: only an affirmed absence is 'gone'; trouble is 'error'", async () => {
  const { verdicts } = await selftest({ bodies: [
    { Status: 0, Answer: [{ type: 1, data: "69.46.85.219" }] },   // NOERROR + A
    { Status: 0, Answer: [{ type: 5, data: "front.example." }] }, // CNAME alone proves the zone knows the name
    { Status: 0, Answer: [] },                                    // NOERROR, empty answer: affirmed gone
    { Status: 0 },                                                // NOERROR, no answer section: affirmed gone
    { Status: 3 },                                                // NXDOMAIN: affirmed gone
    { Status: 2 },                                                // SERVFAIL: resolver trouble, not evidence
    { Status: 5 },                                                // REFUSED
    {},                                                           // junk
    null,
  ] });
  assert.deepEqual(verdicts, [
    "resolves", "resolves", "gone", "gone", "gone", "error", "error", "error", "error",
  ]);
});

// ---------- reachStep: the strike/trip/reset machine --------------------------

test("steps: strikes accumulate only on unanimous 'gone' and trip at the threshold", async () => {
  const { steps } = await selftest({ steps: [
    { state: { strikes: 0, tripped: false }, verdicts: ["gone", "gone"], strikes: 5 },      // first strike
    { state: { strikes: 3, tripped: false }, verdicts: ["gone", "gone"], strikes: 5 },      // fourth
    { state: { strikes: 4, tripped: false }, verdicts: ["gone", "gone"], strikes: 5 },      // fifth: trip
    { state: { strikes: 2, tripped: false }, verdicts: ["gone", "error"], strikes: 5 },     // mixed round holds
    { state: { strikes: 2, tripped: false }, verdicts: ["error", "error"], strikes: 5 },    // all-error holds
    { state: { strikes: 4, tripped: false }, verdicts: ["resolves", "gone"], strikes: 5 },  // one sighting resets
  ] });
  assert.deepEqual(steps, [
    { strikes: 1, tripped: false },
    { strikes: 4, tripped: false },
    { strikes: 5, tripped: true },
    { strikes: 2, tripped: false },
    { strikes: 2, tripped: false },
    { strikes: 0, tripped: false },
  ]);
});

test("steps: a trip persists through 'gone' and 'error' rounds, clears only on a resolve", async () => {
  const { steps } = await selftest({ steps: [
    { state: { strikes: 5, tripped: true }, verdicts: ["gone", "gone"], strikes: 5 },       // still gone
    { state: { strikes: 6, tripped: true }, verdicts: ["error", "error"], strikes: 5 },     // resolver trouble: stay tripped
    { state: { strikes: 6, tripped: true }, verdicts: ["gone", "error"], strikes: 5 },      // mixed: stay tripped
    { state: { strikes: 6, tripped: true }, verdicts: ["resolves", "resolves"], strikes: 5 }, // recovery
    { state: { strikes: 2, tripped: false }, verdicts: [], strikes: 5 },                    // no resolvers: never trip
  ] });
  assert.deepEqual(steps, [
    { strikes: 6, tripped: true },
    { strikes: 6, tripped: true },
    { strikes: 6, tripped: true },
    { strikes: 0, tripped: false },
    { strikes: 0, tripped: false },
  ]);
});
