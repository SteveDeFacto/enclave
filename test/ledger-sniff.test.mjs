// Ledger schema-sniff hardening (supervisor.js) — the pure half: which
// deploymentsSchema() probe failures may cache the rev-1 struct shape, and
// which get/getPage failures mean the cached shape misdecodes this ledger.
// Driven through the SNIFF_SELFTEST seam, same contract as SWEEP_SELFTEST.
//
// Why this exists (2026-07-17, kryptos): right after the v0.5.179 fleet
// update, the boot sniff of the freshly migrated ledger hit a pool RPC that
// answered "returned no data" ("0x" — no code visible to THAT provider), the
// old regex cached rev 1 for the address, and every get/getPage misdecoded
// (IntegerOutOfRange on the id / misaligned words) until relaunch: claim,
// resume, and hint all fail-closed "chain_unreachable" while the box sat
// 99.6% free and its tenants' leases lapsed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function classify(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", SNIFF_SELFTEST: JSON.stringify(c),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("only a genuine revert proves a pre-deploymentsSchema ledger", async () => {
  const { probe } = await classify({ probeErrors: [
    'The contract function "deploymentsSchema" reverted.',            // real rev-1 contract
    "execution reverted",                                             // raw node phrasing
    'The contract function "deploymentsSchema" returned no data ("0x")', // no code visible: lagging/throttled RPC
    "zero data returned from contract",                               // same class, other phrasing
    "HTTP request failed.",                                           // transport trouble
    "",                                                               // no message at all
  ] });
  assert.deepEqual(probe, ["cache-rev1", "cache-rev1", "retry", "retry", "retry", "retry"]);
});

test("shape misdecodes are recognized; transport errors are not", async () => {
  const { decode } = await classify({ decodeErrors: [
    // the live 2026-07-17 signature: a bytes32 id word read as a string length
    'Number "83265078185559481096319599811657619411256371719351009557485289127131200367430n" is not in safe integer range (-9007199254740991 to 9007199254740991)',
    'Slice starting at offset "350" is out-of-bounds (size: 96).',
    "Data size of 17 bytes is too small for given parameters.",
    'Bytes value "0x02" is not a valid boolean.',
    "HTTP request failed.",       // transport: keep the shape, bubble the error
    "execution reverted",         // contract-side: not a shape problem
  ] });
  assert.deepEqual(decode, [true, true, true, true, false, false]);
});
