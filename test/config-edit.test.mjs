// Envelope-edit verdicts (supervisor.js) — the pure half: what the audit does
// to a SERVING record when the owner rewrites the deployment-options envelope
// on-chain (EnclaveDeployments.setConfig). Driven through the
// CFG_EDIT_SELFTEST seam, same contract as LEDGER_MOVE_SELFTEST et al.
//
// Why this exists: the envelope was only ever read at claim, so setConfig was
// a write-only field — an owner's config/waf edit reached a live app only
// after a full suspend/resume or lease migration. The watch makes the edit
// land in place: waf swaps live, a config change restarts the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function verdicts(records) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", CFG_EDIT_SELFTEST: JSON.stringify({ records }),
           SWEEP_SELFTEST: "", LEDGER_MOVE_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]).map((r) => r.verdict);
}

const RUN = { _onchain: true, status: "running" };
const WAF10 = '{"waf":{"rps":10}}';
const WAF20 = '{"waf":{"rps":20}}';
const CFG_A = '{"config":{"a":1}}';
const BOTH = '{"waf":{"rps":10},"config":{"a":1}}';
const BOTH_NEWWAF = '{"waf":{"rps":20},"config":{"a":1}}';

test("not applicable: off-chain, not-running, and pre-watch records", async () => {
  const v = await verdicts([
    { rec: { _onchain: false, status: "running", _envelope: "" }, chainCid: WAF10 },   // legacy dep_ row
    { rec: { _onchain: true, status: "claimed", _envelope: "" }, chainCid: WAF10 },    // mid-provision: claim re-parses
    { rec: { _onchain: true, status: "expired", _envelope: "" }, chainCid: WAF10 },    // holds nothing
    { rec: { ...RUN }, chainCid: WAF10 },                                              // pre-watch state file -> adopt, no restart
    { rec: { ...RUN, _envelope: WAF10 }, chainCid: WAF10 },                            // nothing changed
  ]);
  assert.deepEqual(v, ["skip", "skip", "skip", "stamp", "skip"]);
});

test("waf-only edits swap live; config edits restart", async () => {
  const v = await verdicts([
    { rec: { ...RUN, _envelope: WAF10 }, chainCid: WAF20 },        // waf tuned          -> live swap
    { rec: { ...RUN, _envelope: "" }, chainCid: WAF10 },           // waf added          -> live swap
    { rec: { ...RUN, _envelope: WAF10 }, chainCid: "" },           // waf removed        -> live swap
    { rec: { ...RUN, _envelope: BOTH }, chainCid: BOTH_NEWWAF },   // waf tuned, config untouched -> live swap
    { rec: { ...RUN, _envelope: "" }, chainCid: CFG_A },           // override added     -> restart
    { rec: { ...RUN, _envelope: CFG_A }, chainCid: "" },           // override removed (version config again) -> restart
    { rec: { ...RUN, _envelope: CFG_A }, chainCid: '{"config":{"a":2}}' },   // override changed -> restart
    { rec: { ...RUN, _envelope: "" }, chainCid: '{"config":{}}' }, // explicit-EMPTY override differs from absent -> restart
    { rec: { ...RUN, _envelope: BOTH }, chainCid: WAF10 },         // config dropped, waf kept -> restart
  ]);
  assert.deepEqual(v, ["waf", "waf", "waf", "waf", "restart", "restart", "restart", "restart", "restart"]);
});

test("an envelope this build can't parse never restarts the app: verdict error", async () => {
  const v = await verdicts([
    { rec: { ...RUN, _envelope: WAF10 }, chainCid: "QmSomeLegacyCid" },          // CID-shaped: refused namespace
    { rec: { ...RUN, _envelope: WAF10 }, chainCid: '{"nope":1}' },               // unknown namespace
    { rec: { ...RUN, _envelope: WAF10 }, chainCid: '{"waf":{"bogus":1}}' },      // unknown waf key
    { rec: { ...RUN, _envelope: "not json {", }, chainCid: CFG_A },              // stale-unparsable STAMP still applies the new value
  ]);
  assert.deepEqual(v, ["error", "error", "error", "restart"]);
});
