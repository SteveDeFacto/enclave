/* ============================================================
   Site-wide configuration — endpoints, chains, contract
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

/* ---- on-chain contracts (Base) ---- */
export const APP_CATALOG_ADDRESS = "0x21F2798A51F5970dD43A5D8fAdA48b1b8D59cc67"; // EnclaveAppCatalog on Base; written automatically by scripts/deploy-app-catalog.mjs
export const DEPLOYMENTS_ADDRESS = "0x267f7F792CA84482698b2f6774B028522247B6CD"; // EnclaveDeployments on Base; written automatically by scripts/deploy-deployments.mjs
export const APP_CATALOG_CHAIN   = 8453;                        // Base mainnet (kept in sync by the deploy script; 84532 = Base Sepolia)
export const APP_CATALOG_RPC     = "https://mainnet.base.org";  // preferred read endpoint (CORS-enabled; browsing needs no wallet)
/* Failover pool: reads are stateless, and every public Base RPC rate-limits by
   IP - the official mainnet.base.org hard enough that one catalog load can
   trip "over rate limit". Calls start on the last endpoint that worked and
   rotate on failure. */
export const APP_CATALOG_RPCS    = [APP_CATALOG_RPC, "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];

/* ---- IPFS ---- */
export const IPFS_UPLOAD_URL = "https://ipfs.enclave.host/add-wasm"; // validating upload gateway (server validates + pins); empty => paste-a-CID only
export const IPFS_GATEWAY    = "https://ipfs.io/ipfs/";      // where the "fetch .wasm" links resolve
export const MAX_WASM_MB     = 2048;                         // upload ceiling (also enforced server-side by Caddy request_body max_size and the add-wasm gateway)
export const MAX_WASM_BYTES  = MAX_WASM_MB * 1024 * 1024;
