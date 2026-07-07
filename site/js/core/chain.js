/* ============================================================
   Base chain access — hand-rolled ABI codec (verified vs viem),
   a rotating pool of public RPCs for reads, and the
   EnclaveDeployments / EnclaveAppCatalog contract surface.
   No web3 library loads on the site.
   ============================================================ */
import { APP_CATALOG_ADDRESS, DEPLOYMENTS_ADDRESS, APP_CATALOG_CHAIN, APP_CATALOG_RPCS } from "./config.js";
import { EnclaveError } from "./api.js";
import { wait } from "./util.js";

/* ---- word-level encoders ---- */
export const pad32 = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const encAddr = (a) => pad32(a.replace(/^0x/, ""));
export const encUint = (n) => pad32(BigInt(n).toString(16));
export const encBytes32 = (h) => { const x = h.replace(/^0x/, "").toLowerCase(); if (x.length !== 64) throw new EnclaveError("bad payment reference", 0); return x; };
// dynamic `bytes` tail: length word, then the data right-padded to a 32-byte boundary
export const encBytesTail = (hex) => { const x = hex.replace(/^0x/, "").toLowerCase(); return encUint(x.length / 2) + x.padEnd(Math.ceil(x.length / 64) * 64, "0"); };
export const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
// USDC has 6 decimals, but we FUND in whole cents (0.01 USDC granularity): a
// sub-cent amount encodes as a tiny raw value that wallets render as "0 USDC"
// (and buys no meaningful runtime), so round to cents. NaN-safe (empty field -> 0).
export const usdc6 = (amt) => BigInt(Math.round((parseFloat(amt) || 0) * 100)) * 10000n;
export const hexBig = (h) => (!h || h === "0x") ? 0n : BigInt(h);

/* ---- EnclaveDeployments: on-chain work items (contracts/DEPLOYMENTS.md) ----
   create() from the deployer's wallet (they own the record), fund it
   (EIP-3009 USDC or ETH), and enclaves claim + serve it under expiring
   leases - so a deployment outlives any single enclave, its update, or
   its crash. */
export const DEP_SEL = { create:"1a8e502a", fundAuth:"209c0069", fundEth:"9f33dca0", get:"8eaa6ac0",
                         price:"1e897c58", cpuPrice:"3f6195cc", setActive:"6485d678" };
export const DEP_CREATED_TOPIC = "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239"; // Created(bytes32,address,string,uint16,uint16,uint256)
export const DEP_SCHEMA = [   // mirrors EnclaveDeployments.Deployment field order exactly
  {k:"id",t:"bytes32"},{k:"owner",t:"addr"},{k:"appRef",t:"str"},{k:"ports",t:"str"},
  {k:"sshPubKey",t:"str"},{k:"configCid",t:"str"},{k:"gpuMilli",t:"uint"},{k:"cpuMilli",t:"uint"},
  {k:"appPort",t:"uint"},{k:"isPublic",t:"bool"},{k:"active",t:"bool"},{k:"createdAt",t:"uint"},
  {k:"rate",t:"uint"},{k:"balance6",t:"uint"},{k:"spent6",t:"uint"},
  {k:"runner",t:"bytes32"},{k:"runnerOperator",t:"addr"},{k:"leaseUntil",t:"uint"},
];

/* ---- EnclaveAppCatalog ---- */
export const CAT_SEL = {
  appCount:"b55ca2c3", getAppsPage:"a0483de1", getVersionsPage:"2eb7c1f0", owner:"8da5cb5b",
  publishVersion:"adbf439a",   // publishVersion(...,uint32[4] res,string ports) - res = [vramMb, gpuGflops, memMb, cpuGflops]
  setActive:"9e4b5d56", yankVersion:"345c52dc", setVerified:"4ca171e5",
  setApproval:"a67613fa",
};
// Version.approval: the owner's deploy-gating ruling (unlike `verified`, a curation signal)
export const APPROVAL = { pending:0, approved:1, rejected:2 };
export const CAT_MAX = { slug:40, name:80, desc:500, version:32, cid:100, mb:1048576, gflops:10000000 };
export const APP_SCHEMA = [
  {k:"appId",t:"bytes32"},{k:"publisher",t:"addr"},{k:"slug",t:"str"},{k:"name",t:"str"},
  {k:"description",t:"str"},{k:"versionCount",t:"uint"},{k:"createdAt",t:"uint"},{k:"updatedAt",t:"uint"},{k:"active",t:"bool"},
];
export const VER_SCHEMA = [
  {k:"cid",t:"str"},{k:"version",t:"str"},{k:"vramMb",t:"uint"},{k:"gpuGflops",t:"uint"},{k:"memMb",t:"uint"},{k:"cpuGflops",t:"uint"},{k:"createdAt",t:"uint"},{k:"verified",t:"bool"},{k:"yanked",t:"bool"},{k:"ports",t:"str"},{k:"approval",t:"uint"},
];

export function catConfigured(){ return APP_CATALOG_ADDRESS && !/^0x0+$/i.test(APP_CATALOG_ADDRESS); }
export function catExplorer(){ return APP_CATALOG_CHAIN === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org"; }

/* ---- read side: JSON-RPC against a POOL of public Base RPCs ----
   Rotates to the next endpoint on transport errors and rate limits; a
   contract REVERT is deterministic and thrown immediately (retrying it 8x
   would just burn the pool). One short breather between rounds. */
let _rpcIdx = 0;
export async function baseRpc(method, params){
  let lastErr = null;
  for (let attempt = 0; attempt < APP_CATALOG_RPCS.length * 2; attempt++){
    const url = APP_CATALOG_RPCS[_rpcIdx % APP_CATALOG_RPCS.length];
    try {
      const r = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }),
        signal: AbortSignal.timeout(8000) });   // fail fast and rotate; a hung RPC must not freeze flows
      if (!r.ok) throw new EnclaveError("HTTP " + r.status, r.status);
      const j = await r.json();
      if (j.error){
        if (/revert/i.test(j.error.message || "")) throw { fatal: true, err: new EnclaveError(j.error.message, 0) };
        throw new EnclaveError(j.error.message || "rpc error", 0);
      }
      return j.result;                       // null is a valid result (e.g. pending receipt)
    } catch(e){
      if (e && e.fatal) throw e.err;
      lastErr = (e instanceof EnclaveError) ? e : new EnclaveError(e.message || String(e), 0);
      _rpcIdx++;
      if (attempt === APP_CATALOG_RPCS.length - 1) await wait(700);
    }
  }
  throw lastErr || new EnclaveError("all Base RPC endpoints failed", 0);
}
export async function ethCall(data){
  return (await baseRpc("eth_call", [{ to: APP_CATALOG_ADDRESS, data }, "latest"])) || "0x";
}
export async function depCall(data){
  return (await baseRpc("eth_call", [{ to: DEPLOYMENTS_ADDRESS, data }, "latest"])) || "0x";
}
// EnclaveDeployments.get(id) -> one Deployment struct (see DEP_SCHEMA). The tuple
// contains dynamic strings, so the return is offset-prefixed like a dynamic type.
export async function depGet(id){
  const hex = (await depCall("0x" + DEP_SEL.get + pad32(id.replace(/^0x/, "")))).replace(/^0x/, "");
  if (hex.length < 64) return null;
  const ru   = (o) => BigInt("0x" + hex.slice(o * 2, o * 2 + 64));
  const ts   = Number(ru(0));                                 // offset to the tuple head
  const obj = {};
  DEP_SCHEMA.forEach((f, fi) => {
    const w = ts + fi * 32;
    if (f.t === "str"){ const so = ts + Number(ru(w)); const len = Number(ru(so)); obj[f.k] = hexToUtf8(hex.slice((so + 32) * 2, (so + 32) * 2 + len * 2)); }
    else if (f.t === "uint") obj[f.k] = Number(ru(w));
    else if (f.t === "addr") obj[f.k] = "0x" + hex.slice(w * 2 + 24, w * 2 + 64);
    else if (f.t === "bool") obj[f.k] = ru(w) !== 0n;
    else obj[f.k] = "0x" + hex.slice(w * 2, w * 2 + 64);      // bytes32
  });
  return Number(obj.createdAt) ? obj : null;
}
// The contract's exact per-second rate (6dp USDC) for two share dials in
// 1/1000ths - mirrors _initScalars' ceil math so estimates match on-chain.
export async function depRate6(gpuMilli, cpuMilli){
  const [p, c] = await Promise.all([
    depCall("0x" + DEP_SEL.price), depCall("0x" + DEP_SEL.cpuPrice)]);
  return (BigInt(p || "0x0") * BigInt(gpuMilli) + BigInt(c || "0x0") * BigInt(cpuMilli) + 999n) / 1000n;
}

/* ---- minimal ABI codec (generic encode + struct-array decode), verified vs viem ---- */
export function encStr(s){
  const b = new TextEncoder().encode(s); let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return { body: encUint(b.length) + h.padEnd(Math.ceil(h.length / 64) * 64, "0"), words: 1 + Math.ceil(b.length / 32) };
}
// args: [{t:'str'|'uint'|'bool'|'addr'|'bytes32', v}]; head (offsets/inline) then string tails.
export function encCall(selector, args){
  let off = args.length * 32; const heads = [], bodies = [];
  for (const a of args){
    if (a.t === "str"){ const e = encStr(a.v); heads.push(encUint(off)); off += e.words * 32; bodies.push(e.body); }
    else if (a.t === "uint") heads.push(encUint(a.v));
    else if (a.t === "bool") heads.push(encUint(a.v ? 1 : 0));
    else heads.push(pad32(a.v.replace(/^0x/, "")));   // addr | bytes32
  }
  return "0x" + selector + heads.join("") + bodies.join("");
}
export function hexToUtf8(h){ const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return new TextDecoder().decode(b); }
// decode a dynamic T[] where T is a tuple of str|uint|bool|addr|bytes32 fields (per `schema`).
export function decodeStructArray(hex, schema){
  const buf = (hex || "").replace(/^0x/, "");
  if (buf.length < 64) return [];
  const ru   = (o) => BigInt("0x" + buf.slice(o * 2, o * 2 + 64));
  const radd = (o) => "0x" + buf.slice(o * 2 + 24, o * 2 + 64);
  const rb32 = (o) => "0x" + buf.slice(o * 2, o * 2 + 64);
  const rstr = (o) => { const len = Number(ru(o)); const s = (o + 32) * 2; return hexToUtf8(buf.slice(s, s + len * 2)); };
  const arrOff = Number(ru(0)), len = Number(ru(arrOff)), elems = arrOff + 32, out = [];
  for (let k = 0; k < len; k++){
    const ts = elems + Number(ru(elems + k * 32)), obj = {};
    schema.forEach((f, fi) => {
      const w = ts + fi * 32;
      if (f.t === "str") obj[f.k] = rstr(ts + Number(ru(w)));
      else if (f.t === "uint") obj[f.k] = Number(ru(w));
      else if (f.t === "addr") obj[f.k] = radd(w);
      else if (f.t === "bool") obj[f.k] = ru(w) !== 0n;
      else if (f.t === "bytes32") obj[f.k] = rb32(w);
    });
    out.push(obj);
  }
  return out;
}

/* ---- catalog reads ---- */
export async function appCount(){ return Number(hexBig(await ethCall("0x" + CAT_SEL.appCount))); }
export async function catGetAppsPage(start, n){
  return decodeStructArray(await ethCall(encCall(CAT_SEL.getAppsPage, [{t:"uint",v:start},{t:"uint",v:n}])), APP_SCHEMA);
}
export async function catGetVersions(appId, count){
  const vs = []; const PAGE = 50;
  for (let s = 0; s < count; s += PAGE)
    vs.push(...decodeStructArray(await ethCall(encCall(CAT_SEL.getVersionsPage, [{t:"bytes32",v:appId},{t:"uint",v:s},{t:"uint",v:PAGE}])), VER_SCHEMA));
  return vs;
}
export async function catOwner(){ const r = await ethCall("0x" + CAT_SEL.owner); return "0x" + (r || "").replace(/^0x/, "").slice(24).padStart(40, "0"); }

export async function waitReceipt(hash, tries){
  tries = tries || 45;
  for (let i = 0; i < tries; i++){
    let rec = null;
    try { rec = await baseRpc("eth_getTransactionReceipt", [hash]); } catch(e){}
    if (rec){ if (hexBig(rec.status) === 0n) throw new EnclaveError("transaction reverted", 0); return rec; }
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new EnclaveError("timed out waiting for confirmation (it may still land; hit refresh shortly)", 0);
}
