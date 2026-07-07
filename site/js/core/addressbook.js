/* ============================================================
   Address-book resolution — reads the on-chain EnclaveAddressBook
   (config.ADDRESS_BOOK_ADDRESS) and updates config.js's live
   address bindings, so contract redeploys reach the site without
   a rebuild. Resolves once at boot, caches to sessionStorage
   (config.js applies the cache synchronously on the next visit),
   and re-polls every 5 minutes; changes emit `enclave:addresses`.

   Self-contained eth_call + ABI decode (config.js can't lean on
   chain.js — chain.js imports config.js).
   ============================================================ */
import { ADDRESS_BOOK_ADDRESS, APP_CATALOG_RPCS, __applyAddresses } from "./config.js";
import { emit } from "./util.js";

const SEL_ALL = "0x10c4e8b0";          // all() -> (bytes32[], address[]); verified vs viem
const POLL_MS = 300000;

async function ethCall(){
  let err = null;
  for (const rpc of APP_CATALOG_RPCS){
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ADDRESS_BOOK_ADDRESS, data: SEL_ALL }, "latest"] }),
        signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j && typeof j.result === "string" && j.result.length > 2) return j.result;
      err = new Error((j && j.error && j.error.message) || "empty result");
    } catch(e){ err = e; }
  }
  throw err || new Error("no RPC answered");
}

/* decode (bytes32[] keys, address[] values); keys are ascii right-padded */
function decodeAll(hex){
  const h = hex.replace(/^0x/, "");
  const word = (i) => h.slice(i * 64, i * 64 + 64);
  const at = (byteOff) => byteOff / 32;                     // word index from byte offset
  const kOff = at(parseInt(word(0), 16)), vOff = at(parseInt(word(1), 16));
  const n = parseInt(word(kOff), 16);
  const out = {};
  for (let i = 0; i < n; i++){
    const keyHex = word(kOff + 1 + i);
    let key = "";
    for (let b = 0; b < 64; b += 2){ const c = parseInt(keyHex.slice(b, b + 2), 16); if (!c) break; key += String.fromCharCode(c); }
    const value = "0x" + word(vOff + 1 + i).slice(24);
    if (key && !/^0x0{40}$/.test(value)) out[key] = value;
  }
  return out;
}

async function resolve(){
  const book = decodeAll(await ethCall());
  try { sessionStorage.setItem("enclave_addrbook", JSON.stringify(book)); } catch(e){}
  const changed = __applyAddresses(book);
  if (changed.length){
    console.info("[addressbook] updated: " + changed.join(", "));
    emit("enclave:addresses", { changed, book });
  }
  return book;
}

if (ADDRESS_BOOK_ADDRESS){
  resolve().catch((e) => console.warn("[addressbook] resolve failed (using baked addresses):", e.message || e));
  setInterval(() => resolve().catch(() => {}), POLL_MS);
}
