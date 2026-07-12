#!/usr/bin/env node
// nan-pin-cleanup.mjs — daily IPFS storage-hygiene job on the nan box.
//
// Why this exists: nan runs the single Kubo node that pins every app's wasm, and
// pins never GC on their own — so once an app version is DELISTED or its approval
// is pulled, its bytes would otherwise sit pinned forever, growing the repo toward
// the disk cap (see nan-disk-alert). This job reconciles the pinned wasm against
// the on-chain EnclaveAppCatalog once a day and unpins anything the catalog no
// longer wants deployable, then runs repo GC to actually reclaim the space.
//
// What counts as "no longer wanted" (mirrors the runner deploy gate):
//   A catalog CID is KEPT iff SOME version referencing it is deployable —
//   app.active && approval == Approved(1) && !yanked. Otherwise it is UNPINNED.
//   The keep test is a UNION over every version that lists the CID: a CID that a
//   later Approved version re-listed stays pinned even if an earlier version of
//   the same bytes is Pending/yanked (versions can share bytes but differ in
//   approved config — the wasm is one fetch address for all of them).
//
// SAFETY — this only ever unpins a CID that is BOTH:
//   (a) currently recursively pinned here, AND
//   (b) positively listed in the catalog AND not in the keep-set.
// Anything the catalog doesn't list — the site's DNSLink root, config pins, MFS,
// anything from another source — is never touched. And if ANY catalog read fails
// (RPC down, partial page), we ABORT and unpin nothing: an incomplete keep-set
// must never be allowed to widen the unpin set. Fail-safe, not fail-open.
//
// Env (systemd loads /etc/nan-relay/api-relay.env for BASE_RPC + ADDRESS_BOOK_ADDRESS):
//   BASE_RPC               Base JSON-RPC (default https://base-rpc.publicnode.com)
//   ADDRESS_BOOK_ADDRESS   on-chain address book (default the known mainnet root)
//   ENCLAVE_APP_CATALOG    override the catalog addr (else resolved via the book)
//   KUBO_API               Kubo API base (default http://127.0.0.1:5001)
//   RELAY_DIR              dir whose node_modules has viem (default /opt/nan-relay)
//   PIN_CLEANUP_GC         "0" to skip the post-unpin repo GC (default: GC on)
//   PIN_CLEANUP_DRY_RUN    "1"/CLI --dry-run: report only, unpin nothing
//
// Exit codes: 0 ok (incl. nothing to do), 1 aborted on a read/RPC error.

import { createRequire } from "node:module";

const RELAY_DIR = (process.env.RELAY_DIR || "/opt/nan-relay").replace(/\/+$/, "");
// viem lives in the relay's node_modules; borrow it without moving this file
// there (this file survives relay redeploys, which are targeted file copies).
const require = createRequire(RELAY_DIR + "/__pin_cleanup_require__.js");
const { createPublicClient, http, stringToHex, hexToString, getAddress } = require("viem");

const RPC     = process.env.BASE_RPC || "https://base-rpc.publicnode.com";
const BOOK    = process.env.ADDRESS_BOOK_ADDRESS || "0xab214342d5A490150A4A977063A2f88E21F80907";
const KUBO    = (process.env.KUBO_API || "http://127.0.0.1:5001").replace(/\/+$/, "");
const DRY_RUN = process.env.PIN_CLEANUP_DRY_RUN === "1" || process.argv.includes("--dry-run");
const DO_GC   = process.env.PIN_CLEANUP_GC !== "0";
const APPROVAL_APPROVED = 1;

const BOOK_ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [],
  outputs: [{ name: "keys_", type: "bytes32[]" }, { name: "values", type: "address[]" }] }];

// Minimal catalog ABI — only the three read functions this job needs, embedded
// so the script is self-contained (no repo checkout required on nan).
const CAT_ABI = [
  { type: "function", name: "appCount", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "getAppsPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ name: "page", type: "tuple[]", components: [
      { name: "appId", type: "bytes32" }, { name: "publisher", type: "address" },
      { name: "slug", type: "string" }, { name: "name", type: "string" },
      { name: "description", type: "string" }, { name: "versionCount", type: "uint32" },
      { name: "createdAt", type: "uint64" }, { name: "updatedAt", type: "uint64" },
      { name: "active", type: "bool" }] }] },
  { type: "function", name: "getVersionsPage", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }, { name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ name: "page", type: "tuple[]", components: [
      { name: "cid", type: "string" }, { name: "version", type: "string" },
      { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
      { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" },
      { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
      { name: "yanked", type: "bool" }, { name: "ports", type: "string" },
      { name: "approval", type: "uint8" }, { name: "config", type: "string" }] }] },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const die = (...a) => { console.error(new Date().toISOString(), "ABORT:", ...a); process.exit(1); };

async function kubo(path) {
  const r = await fetch(KUBO + "/api/v0/" + path, { method: "POST" });
  if (!r.ok) throw new Error(`kubo ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function main() {
  const pub = createPublicClient({ transport: http(RPC) });

  // 1) resolve the catalog address (env override, else the on-chain book)
  let catalog = process.env.ENCLAVE_APP_CATALOG;
  if (!catalog) {
    let keys, values;
    try {
      [keys, values] = await pub.readContract({ address: getAddress(BOOK), abi: BOOK_ABI, functionName: "all" });
    } catch (e) { die("address book read failed:", e.shortMessage || e.message); }
    const book = {};
    keys.forEach((k, i) => { book[hexToString(k, { size: 32 }).replace(/\0+$/, "")] = values[i]; });
    catalog = book.appCatalog;
    if (!catalog) die("address book has no appCatalog entry");
  }
  catalog = getAddress(catalog);
  log(`catalog=${catalog} rpc=${RPC} kubo=${KUBO}${DRY_RUN ? " [DRY-RUN]" : ""}`);

  // 2) read the WHOLE catalog. Any failure aborts (never unpin on partial data).
  let appCount;
  try { appCount = Number(await pub.readContract({ address: catalog, abi: CAT_ABI, functionName: "appCount" })); }
  catch (e) { die("appCount read failed:", e.shortMessage || e.message); }

  const apps = [];
  for (let start = 0; start < appCount; ) {
    let page;
    try { page = await pub.readContract({ address: catalog, abi: CAT_ABI, functionName: "getAppsPage", args: [BigInt(start), 50n] }); }
    catch (e) { die("getAppsPage failed:", e.shortMessage || e.message); }
    if (page.length === 0) break;
    apps.push(...page); start += page.length;
  }
  if (apps.length !== appCount) die(`read ${apps.length} apps but appCount=${appCount} (partial read)`);

  // keep = CIDs with a deployable version; listed = every CID the catalog knows.
  // reasons = for a dropped CID, why (for the log): collected across its versions.
  const keep = new Set(), listed = new Set(), reasons = new Map();
  for (const a of apps) {
    const vers = [];
    for (let start = 0; start < a.versionCount; ) {
      let page;
      try { page = await pub.readContract({ address: catalog, abi: CAT_ABI, functionName: "getVersionsPage", args: [a.appId, BigInt(start), 100n] }); }
      catch (e) { die(`getVersionsPage(${a.slug}) failed:`, e.shortMessage || e.message); }
      if (page.length === 0) break;
      vers.push(...page); start += page.length;
    }
    if (vers.length !== a.versionCount) die(`app ${a.slug}: read ${vers.length} versions but versionCount=${a.versionCount}`);
    for (const v of vers) {
      const cid = v.cid.trim().toLowerCase();
      if (!cid) continue;
      listed.add(cid);
      const deployable = a.active && Number(v.approval) === APPROVAL_APPROVED && !v.yanked;
      if (deployable) { keep.add(cid); }
      else {
        const why = !a.active ? "app-delisted" : v.yanked ? "yanked"
          : Number(v.approval) === 2 ? "rejected" : "pending-approval";
        const set = reasons.get(cid) || new Set(); set.add(`${a.slug}@${v.version}:${why}`); reasons.set(cid, set);
      }
    }
  }
  // a CID kept by ANY deployable version wins the union — clear its drop reasons
  for (const c of keep) reasons.delete(c);
  const unwanted = new Set([...listed].filter((c) => !keep.has(c)));
  log(`catalog: apps=${apps.length} listedCIDs=${listed.size} keep=${keep.size} unwanted=${unwanted.size}`);

  // 3) list the node's recursive pins
  let pinned;
  try {
    const j = await (await kubo("pin/ls?type=recursive")).json();
    pinned = Object.keys(j.Keys || {});
  } catch (e) { die("pin/ls failed:", e.message); }

  // 4) intersect: unpin only CIDs that are pinned here AND catalog-unwanted
  const toUnpin = pinned.filter((c) => unwanted.has(c.trim().toLowerCase()));
  log(`pins: recursive=${pinned.length} matched-unwanted=${toUnpin.length}`);
  if (toUnpin.length === 0) { log("nothing to unpin"); return; }

  const before = await repoStat();
  let removed = 0;
  for (const cid of toUnpin) {
    const why = [...(reasons.get(cid.trim().toLowerCase()) || [])].join(", ");
    if (DRY_RUN) { log(`  would unpin ${cid}  (${why})`); continue; }
    try { await kubo(`pin/rm?arg=${encodeURIComponent(cid)}`); removed++; log(`  unpinned ${cid}  (${why})`); }
    catch (e) { log(`  WARN unpin ${cid} failed: ${e.message}`); }
  }

  if (!DRY_RUN && removed > 0 && DO_GC) {
    log("running repo gc…");
    try { await (await kubo("repo/gc")).text(); } catch (e) { log("WARN repo gc:", e.message); }
    const after = await repoStat();
    if (before && after)
      log(`repo: ${fmt(before.RepoSize)} -> ${fmt(after.RepoSize)} (reclaimed ${fmt(before.RepoSize - after.RepoSize)}), objects ${before.NumObjects} -> ${after.NumObjects}`);
  }
  log(`done: unpinned ${DRY_RUN ? 0 : removed}${DRY_RUN ? ` (dry-run; ${toUnpin.length} candidates)` : ""}`);
}

async function repoStat() {
  try { return await (await kubo("repo/stat")).json(); } catch { return null; }
}
function fmt(n) {
  n = Number(n); const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

main().catch((e) => die(e.stack || e.message));
