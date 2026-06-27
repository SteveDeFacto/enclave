// Mint a NAN session token via the SIWE handshake, for testing.
// Usage:  NAN_BASE=http://localhost:8080 node scripts/login.mjs
// Reuses PK if you set one, else generates a throwaway wallet.
// Prints ADDRESS, PK, and TOKEN. Use:  curl -H "Authorization: Bearer $TOKEN" ...
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const base = (process.env.NAN_BASE || "http://localhost:8080").replace(/\/+$/, "");
const pk = process.env.PK || generatePrivateKey();
const acct = privateKeyToAccount(pk);

const nonce = await fetch(`${base}/v1/auth/nonce?address=${acct.address}`).then(r => r.json());
if (!nonce.message) { console.error("nonce failed:", nonce); process.exit(1); }
const signature = await acct.signMessage({ message: nonce.message });
const login = await fetch(`${base}/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: nonce.message, signature }),
}).then(r => r.json());
if (!login.token) { console.error("login failed:", login); process.exit(1); }

console.log("ADDRESS:", acct.address);
console.log("PK:     ", pk);
console.log("TOKEN:  ", login.token);
console.log(`\nexport NAN_TOKEN="${login.token}"`);
