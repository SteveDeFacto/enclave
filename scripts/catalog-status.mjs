#!/usr/bin/env node
// catalog-status.mjs — read APP_CATALOG_* out of site/js/core/config.js and report what
// the site points at: whether an address is wired, and WHICH revision of
// EnclaveAppCatalog lives there (detected by function selectors in the bytecode).
//
// Usage:  node scripts/catalog-status.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SITE = path.join(REPO, "site", "js", "core", "config.js");

const SEL_PUBLISH_SHARES = "adbf439a"; // publishVersion(...,uint32[4] res,string ports) -> current (exact resources incl. compute -> derived shares)
const SEL_SET_APPROVAL  = "a67613fa"; // setApproval(bytes32,uint256,uint8)      -> approval-gated deploys, memMb-only resources
const SEL_PUBLISH_PORTS = "2936ec7d"; // publishVersion(...,uint32,string ports) -> firewall, no approval
const SEL_PUBLISH_V2    = "7535857a"; // publishVersion(...,uint32)              -> versioned, no ports
const SEL_PUBLISH_V1    = "098d0746"; // publish(string,string,string,uint32)    -> original, no versions
const SEL_APP_COUNT     = "b55ca2c3"; // appCount()

function grab(html, name, quoted) {
  const re = quoted
    ? new RegExp(`const ${name}\\s*=\\s*"([^"]*)"`)
    : new RegExp(`const ${name}\\s*=\\s*([0-9]+)`);
  const m = html.match(re);
  return m ? m[1] : null;
}

async function rpc(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

async function main() {
  const html = fs.readFileSync(SITE, "utf8");
  const addr = grab(html, "APP_CATALOG_ADDRESS", true);
  const chain = grab(html, "APP_CATALOG_CHAIN", false);
  const rpcUrl = grab(html, "APP_CATALOG_RPC", true);

  console.log("From site/js/core/config.js:");
  console.log(`  APP_CATALOG_ADDRESS  ${addr ?? "(not found)"}`);
  console.log(`  APP_CATALOG_CHAIN    ${chain ?? "(not found)"}`);
  console.log(`  APP_CATALOG_RPC      ${rpcUrl ?? "(not found)"}\n`);

  if (!addr || /^0x0+$/i.test(addr)) {
    console.log("=> No catalog address wired (0x0 placeholder). Deploy with:");
    console.log("     node scripts/deploy-app-catalog.mjs   (writes address/chain/RPC in for you)");
    return;
  }
  if (!rpcUrl) { console.log("=> Address set but APP_CATALOG_RPC missing; can't query."); return; }

  const explorer = chain === "84532" ? "https://sepolia.basescan.org" : "https://basescan.org";
  console.log(`Checking ${addr} on ${rpcUrl} ...`);
  let code;
  try { code = await rpc(rpcUrl, "eth_getCode", [addr, "latest"]); }
  catch (e) { console.log(`=> RPC error: ${e.message}`); return; }

  if (!code || code === "0x") {
    console.log(`=> No contract at that address on this network (wrong address or chain).`);
  } else if (code.includes(SEL_PUBLISH_SHARES)) {
    let n = "?";
    try { n = BigInt(await rpc(rpcUrl, "eth_call", [{ to: addr, data: "0x" + SEL_APP_COUNT }, "latest"]) || "0x0").toString(); } catch {}
    console.log(`=> CURRENT EnclaveAppCatalog ✓ (exact resources: vramMb/gpuGflops/memMb/cpuGflops, shares derived by runners). Apps listed: ${n}`);
  } else if (code.includes(SEL_SET_APPROVAL)) {
    console.log(`=> OLDER EnclaveAppCatalog (approval-gated, but memMb-only resources — no VRAM`);
    console.log(`   requirement, so runners can't derive both shares). Redeploy:`);
    console.log(`     node scripts/deploy-app-catalog.mjs`);
  } else if (code.includes(SEL_PUBLISH_PORTS)) {
    console.log(`=> OLDER EnclaveAppCatalog (firewall ports, NO approval gating — the supervisor's`);
    console.log(`   cidStatus() deploy gate can't work against it). Redeploy:`);
    console.log(`     node scripts/deploy-app-catalog.mjs`);
  } else if (code.includes(SEL_PUBLISH_V2)) {
    console.log(`=> OLDER EnclaveAppCatalog (versions, NO firewall ports). Redeploy:`);
    console.log(`     node scripts/deploy-app-catalog.mjs`);
  } else if (code.includes(SEL_PUBLISH_V1)) {
    console.log(`=> ORIGINAL EnclaveAppCatalog (no versions). Redeploy:`);
    console.log(`     node scripts/deploy-app-catalog.mjs`);
  } else {
    console.log(`=> A contract exists here but matches no EnclaveAppCatalog revision.`);
  }
  console.log(`   Explorer: ${explorer}/address/${addr}`);
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
