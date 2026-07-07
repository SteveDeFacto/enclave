// addressbook.js — the supervisor's contract-address root. Exports LIVE
// BINDINGS for the platform's contract addresses, seeded from the baked env
// (the measured tinfoil config) and — when ADDRESS_BOOK_ADDRESS is set —
// overridden from the on-chain EnclaveAddressBook at boot and re-polled, so
// a contract redeploy reaches running enclaves with ONE owner transaction
// instead of a release + dashboard update.
//
// Trust note (this is deliberate, documented policy): the book's owner is the
// platform governance key. With a book configured, WHICH contracts this
// enclave talks to is governed by that key at runtime; the measurement pins
// this code and the book's address, not the addresses inside it.
//
// import { APP_CATALOG_ADDRESS } from "./addressbook.js" — the value updates
// in place when the book changes (ES live bindings); process.env.* is kept in
// step for any child/tooling that reads env.

import { createPublicClient, http, getAddress } from "viem";
import { base } from "viem/chains";

export let REGISTRY_ADDRESS      = process.env.REGISTRY_ADDRESS || "";
export let DEPLOYMENTS_ADDRESS   = process.env.DEPLOYMENTS_ADDRESS || "";
export let APP_CATALOG_ADDRESS   = process.env.APP_CATALOG_ADDRESS || "";
export let FORWARDER_ADDRESS     = process.env.FORWARDER_ADDRESS || "";
export let VOLUME_ACCESS_ADDRESS = process.env.VOLUME_ACCESS_ADDRESS || "";

const BOOK = (process.env.ADDRESS_BOOK_ADDRESS || "").trim();
const POLL_SEC = parseInt(process.env.ADDRESS_BOOK_POLL_SEC || "", 10) || 300;

const ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [],
               outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];
// book key (ascii bytes32) -> [env name, setter for the live binding]
const KEYS = {
  registry:     ["REGISTRY_ADDRESS",      (v) => { REGISTRY_ADDRESS = v; }],
  deployments:  ["DEPLOYMENTS_ADDRESS",   (v) => { DEPLOYMENTS_ADDRESS = v; }],
  appCatalog:   ["APP_CATALOG_ADDRESS",   (v) => { APP_CATALOG_ADDRESS = v; }],
  enclavePay:   ["FORWARDER_ADDRESS",     (v) => { FORWARDER_ADDRESS = v; }],
  volumeAccess: ["VOLUME_ACCESS_ADDRESS", (v) => { VOLUME_ACCESS_ADDRESS = v; }],
};
const current = () => ({ registry: REGISTRY_ADDRESS, deployments: DEPLOYMENTS_ADDRESS,
  appCatalog: APP_CATALOG_ADDRESS, enclavePay: FORWARDER_ADDRESS, volumeAccess: VOLUME_ACCESS_ADDRESS });

let client = null;
async function readBook() {
  if (!client) client = createPublicClient({ chain: base,
    transport: http(process.env.BASE_RPC || "https://mainnet.base.org", { retryCount: 3, retryDelay: 500 }) });
  const [keysHex, values] = await client.readContract({ address: getAddress(BOOK), abi: ABI, functionName: "all" });
  const changed = [];
  keysHex.forEach((kh, i) => {
    let key = "";
    for (let b = 2; b < kh.length; b += 2) { const c = parseInt(kh.slice(b, b + 2), 16); if (!c) break; key += String.fromCharCode(c); }
    const ent = KEYS[key]; if (!ent) return;
    const v = getAddress(values[i]);
    if (/^0x0{40}$/i.test(v.slice(0))) return;               // zero = retired; keep the baked value
    const cur = current()[key] || "";
    if (cur.toLowerCase() === v.toLowerCase()) return;
    ent[1](v); process.env[ent[0]] = v;
    changed.push(`${ent[0]} ${cur || "(unset)"} -> ${v}`);
  });
  return changed;
}

/// Boot: block on one read (with the baked env as the fallback on failure),
/// then poll. Call this BEFORE anything derives state from the addresses.
export async function initAddressBook(log = console) {
  if (!BOOK) return false;
  try {
    const changed = await readBook();
    log.log(`[addressbook] resolved from ${BOOK}${changed.length ? " · " + changed.join(" · ") : " (matches baked env)"}`);
  } catch (e) {
    log.warn(`[addressbook] boot read failed (keeping the baked env): ${e.shortMessage || e.message}`);
  }
  const t = setInterval(async () => {
    try {
      const changed = await readBook();
      for (const c of changed) log.log(`[addressbook] ${c}`);
    } catch (e) { /* transient RPC trouble; next poll retries */ }
  }, POLL_SEC * 1000);
  if (t.unref) t.unref();
  return true;
}
