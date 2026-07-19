// Ledger-move verdicts (supervisor.js) — the pure half: what happens to a
// local record when the address book repoints `deployments` at a new contract.
// Driven through the LEDGER_MOVE_SELFTEST seam, same contract as
// SWEEP_SELFTEST/REACH_SELFTEST/ACME_SELFTEST.
//
// Why this exists (2026-07-19, kryptos): the owner redeployed the deployments
// contract to wipe the fleet; the book repointed (addressbook.js live
// bindings already re-poll), but the audit reads an absent ledger row as an
// RPC anomaly and kept every old app serving — unbilled zombies on a retired
// ledger, invisible to the console.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function verdicts(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", LEDGER_MOVE_SELFTEST: JSON.stringify(c),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
           CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return Object.fromEntries(JSON.parse(lines[lines.length - 1]).map((r) => [r.id, r.verdict]));
}

const OLD = "0x" + "aa".repeat(20);
const NEW = "0x" + "bb".repeat(20);

test("records from a retired ledger tear down; current-ledger and legacy records do not", async () => {
  const v = await verdicts({
    current: NEW,
    records: [
      { id: "d-old-running",  _onchain: true,  status: "running",  _ledger: OLD },  // retired ledger -> teardown
      { id: "d-old-claimed",  _onchain: true,  status: "claimed",  _ledger: OLD },  // mid-provision counts too
      { id: "d-current",      _onchain: true,  status: "running",  _ledger: NEW },  // right where it should be
      { id: "d-legacy",       _onchain: true,  status: "running" },                 // pre-stamp state file -> adopt current
      { id: "d-terminal",     _onchain: true,  status: "expired",  _ledger: OLD },  // holds nothing; leave it
      { id: "d-http",         _onchain: false, status: "running" },                 // not the ledger's business
    ],
  });
  assert.deepEqual(v, {
    "d-old-running": "teardown",
    "d-old-claimed": "teardown",
    "d-current":     "skip",
    "d-legacy":      "stamp",
    "d-terminal":    "skip",
    "d-http":        "skip",
  });
});

test("case-insensitive address match: a checksum-vs-lower mismatch is not a move", async () => {
  const v = await verdicts({
    current: NEW.toUpperCase().replace("0X", "0x"),
    records: [{ id: "d", _onchain: true, status: "running", _ledger: NEW }],
  });
  assert.deepEqual(v, { d: "skip" });
});

test("no current address (claim path unconfigured) never tears anything down", async () => {
  const v = await verdicts({
    current: "",
    records: [{ id: "d", _onchain: true, status: "running", _ledger: OLD }],
  });
  assert.deepEqual(v, { d: "skip" });
});
