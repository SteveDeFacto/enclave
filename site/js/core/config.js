/* ============================================================
   Site-wide configuration - endpoints, chains, contract
   addresses. One place to edit when anything is redeployed
   (scripts/sync-contract-addresses.sh rewrites the addresses).
   ============================================================ */

/* Production API gateway (mirrors openapi.json servers[0].url; the Deploy
   page lets a user point at an enclave directly and persists the override). */
export const DEFAULT_API_BASE = "https://api.enclave.host/v1";

/* Through the gateway each deployment gets its OWN origin:
   https://<label>.app.enclave.host (see appLabel in the deploy page). */
export const APP_DOMAIN = "app.enclave.host";

export const BASE_CHAIN = 8453, BASE_CHAIN_HEX = "0x2105";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/* ---- Privy embedded wallet: email-login fallback when no extension wallet
   is available. An empty PRIVY_APP_ID disables the option entirely. ---- */
export const PRIVY_APP_ID = "cmr8u8m5y00cf0djiqotqm7ag";
export const PRIVY_CLIENT_ID = "client-WY6b9c219SjvhdjLGYDriJ9xjSrbV7c4joihKRQPRm3QN";   // web app client, registered for enclave.host
export const PRIVY_RDNS = "io.privy.embedded";

/* ---- on-chain contracts (Base) ----
   The baked addresses are FALLBACKS for first paint: when
   ADDRESS_BOOK_ADDRESS is set, js/core/addressbook.js resolves the live
   values from the on-chain EnclaveAddressBook and reassigns these bindings
   (`let` exports - importers see the update), so contract redeploys reach
   the site without a rebuild. The last resolve is cached in sessionStorage
   and applied synchronously below, so repeat visits never paint stale
   addresses even for a frame. */
export const ADDRESS_BOOK_ADDRESS = "0xab214342d5A490150A4A977063A2f88E21F80907"; // EnclaveAddressBook on Base; written by scripts/deploy-address-book.mjs ("" = baked addresses only)
export let APP_CATALOG_ADDRESS = "0xaB0462E55c18E295A221e4Eaa8738F25eB0696D7"; // EnclaveAppCatalog on Base; written automatically by scripts/deploy-app-catalog.mjs
export let DEPLOYMENTS_ADDRESS = "0x0A7dE5D205c10B812AbaF0b89f3A243466bCEe01"; // EnclaveDeployments on Base; written automatically by scripts/deploy-deployments.mjs
export let REGISTRY_ADDRESS    = "";                            // EnclaveRegistry (fleet membership); resolved from the address book only
export const APP_CATALOG_CHAIN   = 8453;                        // Base mainnet (kept in sync by the deploy script; 84532 = Base Sepolia)

/* apply an address-book map ({appCatalog, deployments}) onto the live
   bindings; returns which names changed. Called by js/core/addressbook.js. */
export function __applyAddresses(map){
  const ok = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
  const changed = [];
  if (map && ok(map.appCatalog) && map.appCatalog.toLowerCase() !== APP_CATALOG_ADDRESS.toLowerCase()){
    APP_CATALOG_ADDRESS = map.appCatalog; changed.push("APP_CATALOG_ADDRESS");
  }
  if (map && ok(map.deployments) && map.deployments.toLowerCase() !== DEPLOYMENTS_ADDRESS.toLowerCase()){
    DEPLOYMENTS_ADDRESS = map.deployments; changed.push("DEPLOYMENTS_ADDRESS");
  }
  if (map && ok(map.registry) && map.registry.toLowerCase() !== REGISTRY_ADDRESS.toLowerCase()){
    REGISTRY_ADDRESS = map.registry; changed.push("REGISTRY_ADDRESS");
  }
  return changed;
}
if (ADDRESS_BOOK_ADDRESS){
  try { __applyAddresses(JSON.parse(sessionStorage.getItem("enclave_addrbook") || "null")); } catch(e){}
}
export const APP_CATALOG_RPC     = "https://base-rpc.publicnode.com";  // preferred read endpoint (CORS-enabled; browsing needs no wallet). NOTE: deploy-app-catalog.mjs rewrites this to mainnet.base.org on every catalog deploy - restore publicnode after (it rate-limits hard enough to trip one catalog load; kept in the pool as last resort)
/* Failover pool: reads are stateless, and every public Base RPC rate-limits by
   IP - the official mainnet.base.org hard enough that one catalog load can
   trip "over rate limit". Calls start on the last endpoint that worked and
   rotate on failure. */
export const APP_CATALOG_RPCS    = [APP_CATALOG_RPC, "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];

/* ---- IPFS ---- */
export const IPFS_UPLOAD_URL = "https://ipfs.enclave.host/add-wasm"; // validating upload gateway (server validates + pins); empty => paste-a-CID only
export const IPFS_IMAGE_UPLOAD_URL = "https://ipfs.enclave.host/add-image"; // validating image pin (app thumbnail/banner); empty => image upload off
export const IPFS_GATEWAY    = "https://ipfs.io/ipfs/";      // where the "fetch .wasm" links resolve
export const IPFS_IMG_GATEWAY = "https://ipfs.enclave.host/ipfs/"; // app media (thumbnail/banner) - served from our own gateway for speed/reliability
export const MAX_WASM_MB     = 2048;                         // upload ceiling (also enforced server-side by Caddy request_body max_size and the add-wasm gateway)
export const MAX_WASM_BYTES  = MAX_WASM_MB * 1024 * 1024;
export const MAX_IMAGE_MB    = 4;                            // thumbnail/banner ceiling (also enforced by the add-image gateway)
export const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
