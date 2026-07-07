#!/usr/bin/env node
// enclave-vault-client - the wallet side of wallet-gated encrypted volumes.
//
// Drives the full lifecycle against EnclaveVolumeAccess (the on-chain ACL) and a
// running enclave (unlock-sealed). The crypto is scripts/enclave-vault.mjs - the
// same protocol the enclave and the browser app implement. Your wallet key
// NEVER leaves this process; the volume key (VEK) travels only sealed.
//
// Commands:
//   setup     owner bootstrap: createVolume (if missing) + register your pubkey
//             [+ self-grant Writer with the VEK sealed to yourself: --vek]
//   register  publish YOUR wallet's vault pubkey for a volume, then wait for the
//             enclave auto-grant (--wait) or an owner grant
//   grant     owner/operator grant: seal the VEK to a registered member
//             (--vek, or omit it to unseal your OWN on-chain copy first)
//   status    volume record + a member's entry (default: yours)
//   unlock    member unlock of a deployment's vault volume on an enclave:
//             unseal your VEK -> verify enclave attestation -> re-seal to the
//             enclave's per-boot pubkey -> SIWE login -> POST unlock-sealed
//   watch     always-on unlock agent (the FAILOVER note in EnclaveVolumeAccess.sol):
//             hold one authorized wallet, poll chain state, and re-deliver the
//             sealed VEK whenever the deployment lands on a fresh enclave boot.
//             The VEK stays in THIS process's RAM; grant the agent's wallet
//             Reader (least privilege) and run it somewhere you trust.
//
// Common env/flags:
//   PK / --pk <hex>                 wallet private key (hidden prompt if omitted)
//   VOLUME_ACCESS_ADDRESS / --contract <addr>
//   NETWORK base|base-sepolia (default base) · RPC_URL / --rpc <url>
//   --owner <addr>    volume owner (defaults to YOUR address for setup/grant)
//   --volume <name>   on-chain volume name
// unlock/watch flags:
//   --id <deployment> --name <encVolume name> (--volume defaults to --name)
//   --url <enclave>   the enclave origin (attested TLS terminates THERE);
//                     omitted = resolved from chain state (EnclaveDeployments
//                     .get(id).runner -> EnclaveRegistry endpoint - no gateway
//                     trusted for discovery; attestation still gates trust)
//   --repo <gh repo>  attestation config repo (default: the runner's own
//                     EnclaveRegistry entry, else SteveDeFacto/enclave)
//   --no-verify       skip attestation verification (DEV ONLY - without it you
//                     cannot know the sealed key is going into a real enclave)
//   --interval <sec>  (watch) poll cadence, default 30
//   --member <addr>   (status/grant/--wait) someone else's entry
//   --role writer     (grant) grant Writer instead of Reader
//   --wait            (register) poll until a grant lands, then confirm unseal
//
// Examples:
//   PK=0x.. node scripts/enclave-vault-client.mjs setup --volume user-data --vek 0x<from enclave-vault pack>
//   PK=0x.. node scripts/enclave-vault-client.mjs register --owner 0x<owner> --volume user-data --wait
//   PK=0x.. node scripts/enclave-vault-client.mjs unlock --id 0x<dep> --owner 0x<owner> --name user-data
//   PK=0x.. node scripts/enclave-vault-client.mjs watch  --id 0x<dep> --owner 0x<owner> --name user-data

import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { createPublicClient, createWalletClient, http, getAddress, isAddress,
         keccak256, encodeAbiParameters, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { DERIVE_MESSAGE, deriveKeypair, seal, unseal } from "./enclave-vault.mjs";

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base,        rpc: "https://mainnet.base.org",  explorer: "https://basescan.org" },
};
const ABI = [
  { type: "function", name: "createVolume", stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "pubkey", type: "bytes32" }], outputs: [] },
  { type: "function", name: "grant", stateMutability: "nonpayable",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "member", type: "address" },
             { name: "role", type: "uint8" }, { name: "sealedVEK", type: "bytes" }], outputs: [] },
  { type: "function", name: "getVolume", stateMutability: "view",
    inputs: [{ name: "volId", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }, { name: "exists", type: "bool" },
              { name: "createdAt", type: "uint64" }, { name: "members", type: "uint256" }] },
  { type: "function", name: "getMember", stateMutability: "view",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "member", type: "address" }],
    outputs: [{ name: "role", type: "uint8" }, { name: "pubkey", type: "bytes32" },
              { name: "registered", type: "bool" }, { name: "sealedVEK", type: "bytes" },
              { name: "updatedAt", type: "uint64" }] },
];
const ROLE = { 0: "None", 1: "Reader", 2: "Writer" };

// chain-state deployment->runner resolution (mirrors the vault app + console;
// same defaults as scripts/enclave-discover.mjs / site/js/core/config.js)
const DEPLOYMENTS_ADDRESS = process.env.DEPLOYMENTS_ADDRESS || "0x81037A2081bc000F12B8aA771bede0d36742ec4b";
const REGISTRY_ADDRESS    = process.env.REGISTRY_ADDRESS    || "0x13deE63b80353a15C6E03D54240EE463B420353F";
const DEPLOYMENTS_ABI = [
  { type: "function", name: "get", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
      { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "sshPubKey", type: "string" }, { name: "configCid", type: "string" },
      { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
      { name: "appPort", type: "uint32" },
      { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
      { name: "createdAt", type: "uint64" },
      { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" },
      { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
      { name: "leaseUntil", type: "uint64" } ] }] },
];
const REGISTRY_ABI = [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "endpoint", type: "string" }, { name: "repo", type: "string" },
      { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
      { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" },
      { name: "active", type: "bool" }] }] },
];

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const has = (name) => argv.includes(name);
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const unhex = (s) => new Uint8Array(Buffer.from(String(s).replace(/^0x/, ""), "hex"));
const die = (msg) => { console.error(`\nERROR: ${msg}\n`); process.exit(1); };

function promptSecret(query) {
  return new Promise((resolve) => {
    const rl = rlSync.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) output.write(s); };
    rl.question(query, (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
    rl.on("close", () => resolve(""));
    rl._muted = true;
  });
}

async function loadWallet() {
  let pk = (flag("--pk") || process.env.PK || "").trim();
  if (!pk && input.isTTY) pk = await promptSecret("Wallet private key (hidden): ");
  if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) die("need a wallet key: --pk / PK env (32-byte hex)");
  return privateKeyToAccount(pk);
}

const netName = (flag("--network") || process.env.NETWORK || "base").trim();
const net = NETWORKS[netName] || die(`unknown network '${netName}' (base | base-sepolia)`);
const rpc = (flag("--rpc") || process.env.RPC_URL || net.rpc).trim();
const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });

function contractAddr() {
  const a = (flag("--contract") || process.env.VOLUME_ACCESS_ADDRESS || "").trim();
  if (!isAddress(a)) die("need the EnclaveVolumeAccess address: --contract / VOLUME_ACCESS_ADDRESS");
  return getAddress(a);
}
const volIdOf = (owner, volume) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "string" }], [getAddress(owner), volume]));
const read = (addr, functionName, args) => pub.readContract({ address: addr, abi: ABI, functionName, args });

async function sendTx(account, addr, functionName, args) {
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  const h = await wallet.writeContract({ address: addr, abi: ABI, functionName, args });
  const rcpt = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
  if (rcpt.status !== "success") die(`${functionName} reverted: ${net.explorer}/tx/${h}`);
  console.log(`  ${functionName} ok: ${net.explorer}/tx/${h}`);
  return rcpt;
}

// One deterministic signature (RFC-6979) = the wallet's vault keypair, every time.
async function deriveVaultKey(account) {
  const sig = await account.signMessage({ message: DERIVE_MESSAGE });
  return deriveKeypair(unhex(sig));
}

const ZERO32 = "0x" + "0".repeat(64);

// deployment id -> its runner enclave, from chain state alone:
// EnclaveDeployments.get(id).runner is keccak256 of the endpoint string the
// enclave registered in EnclaveRegistry. Trust note: this only picks WHERE to
// connect - attestation at connect time is what gates key release.
async function resolveRunner(depId) {
  const dep = await pub.readContract({ address: getAddress(DEPLOYMENTS_ADDRESS),
    abi: DEPLOYMENTS_ABI, functionName: "get", args: [depId] });
  if (!dep || dep.owner === "0x0000000000000000000000000000000000000000")
    throw new Error("no such deployment on EnclaveDeployments");
  if (dep.runner === ZERO32) throw new Error("deployment has never been claimed - no runner");
  const leaseLive = Number(dep.leaseUntil) * 1000 > Date.now();
  const total = Number(await pub.readContract({ address: getAddress(REGISTRY_ADDRESS),
    abi: REGISTRY_ABI, functionName: "count", args: [] }));
  for (let start = 0; start < total; start += 50) {
    const page = await pub.readContract({ address: getAddress(REGISTRY_ADDRESS),
      abi: REGISTRY_ABI, functionName: "getPage", args: [BigInt(start), 50n] });
    const hit = page.find((e) => keccak256(stringToBytes(e.endpoint)) === dep.runner);
    if (hit) return { endpoint: hit.endpoint.replace(/\/+$/, ""), repo: hit.repo, leaseLive, dep };
  }
  throw new Error(`runner ${dep.runner} is not in EnclaveRegistry - cannot resolve its endpoint`);
}

// Deliver a VEK to a deployment's enclave: verify attestation of `url` (the
// load-bearing step - only then is TLS known to terminate inside the measured
// CVM), fetch its per-boot vault pubkey, seal, SIWE, POST unlock-sealed.
// Returns { body, enclavePub }. Shared by `unlock` and `watch`.
async function deliverSealed(account, { url, depId, name, repo, noVerify, vek }) {
  if (noVerify) {
    console.log("WARNING: --no-verify - skipping attestation; do NOT do this against production");
  } else {
    const { Verifier } = await import("@tinfoilsh/verifier");
    try {
      await new Verifier({ serverURL: url, configRepo: repo }).verify();
      console.log(`attestation verified ✓ (${url} measures as ${repo})`);
    } catch (e) {
      throw new Error(`attestation FAILED for ${url}: ${e.message} - refusing to send key material (override for dev: --no-verify)`);
    }
  }

  // the enclave's per-boot pubkey, fetched over the just-verified TLS.
  // The deployment-scoped path routes correctly through the fleet gateway
  // (the bare /v1/vault-pubkey could answer from a different enclave).
  let vp = await fetch(`${url}/v1/deployments/${encodeURIComponent(depId)}/vault-pubkey`).then((r) => r.json()).catch(() => ({}));
  if (!vp.pubkey) vp = await fetch(`${url}/v1/vault-pubkey`).then((r) => r.json());
  if (!/^0x[0-9a-f]{64}$/i.test(vp.pubkey || "")) throw new Error(`bad vault-pubkey response: ${JSON.stringify(vp)}`);
  const sealed = hex(seal(vek, unhex(vp.pubkey)));

  // SIWE login (the ACL check is on-chain; this just names the member)
  const nonce = await fetch(`${url}/v1/auth/nonce?address=${account.address}`).then((r) => r.json());
  if (!nonce.message) throw new Error(`auth nonce failed: ${JSON.stringify(nonce)}`);
  const signature = await account.signMessage({ message: nonce.message });
  const login = await fetch(`${url}/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: nonce.message, signature }),
  }).then((r) => r.json());
  if (!login.token) throw new Error(`login failed: ${JSON.stringify(login)}`);

  // the enclave checks isAuthorized(volId, member) on-chain, unseals, and the
  // manager decrypts in-RAM (or re-verifies on a running deployment = re-arm)
  const r = await fetch(`${url}/v1/deployments/${encodeURIComponent(depId)}/unlock-sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ name, sealed }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`unlock-sealed ${r.status}: ${body.message || body.error || JSON.stringify(body)}`);
  return { body, enclavePub: vp.pubkey.toLowerCase() };
}

// Unseal the calling wallet's own on-chain sealedVEK (shared by unlock/watch).
async function unsealOwn(account, addr, volId, { owner, volume }) {
  const kp = await deriveVaultKey(account);
  const [role, pubkey, registered, sealedVEK] = await read(addr, "getMember", [volId, account.address]);
  if (!registered || sealedVEK === "0x")
    die(`${account.address} holds no sealed VEK for '${volume}' (role ${ROLE[Number(role)]}). Run: register --owner ${owner} --volume ${volume} --wait`);
  if (pubkey !== hex(kp.publicKey))
    die("your on-chain pubkey differs from this wallet's derived key (registered from another wallet?) - re-run register to rotate");
  try { return unseal(unhex(sealedVEK), kp.secretKey); }
  catch { die("could not unseal your VEK with this wallet's derived key"); }
}

async function main() {
  if (!cmd || has("--help") || cmd === "help") {
    console.error("commands: setup | register | grant | status | unlock | watch   (see header comment for flags)");
    process.exit(cmd ? 0 : 2);
  }

  if (cmd === "setup") {
    const account = await loadWallet();
    const addr = contractAddr();
    const volume = (flag("--volume") || "").trim() || die("setup needs --volume <name>");
    const volId = volIdOf(account.address, volume);
    console.log(`volume '${volume}' owner ${account.address}\nvolId ${volId}`);
    const [, exists] = await read(addr, "getVolume", [volId]);
    if (exists) console.log("  volume exists on-chain already");
    else await sendTx(account, addr, "createVolume", [volume]);
    const kp = await deriveVaultKey(account);
    const [, curPub] = await read(addr, "getMember", [volId, account.address]);
    if (curPub === hex(kp.publicKey)) console.log("  pubkey registered already");
    else await sendTx(account, addr, "register", [volId, hex(kp.publicKey)]);
    const vek = (flag("--vek") || "").trim();
    if (vek) {
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(vek)) die("--vek must be the 32-byte hex VEK from `enclave-vault pack`");
      await sendTx(account, addr, "grant",
        [volId, account.address, 2, hex(seal(unhex(vek), kp.publicKey))]);
      console.log("  self-granted Writer (VEK sealed to your wallet-derived key; safe on-chain)");
    } else {
      console.log("  no --vek: volume + registration only (self-grant later via `grant`)");
    }
    return;
  }

  if (cmd === "register") {
    const account = await loadWallet();
    const addr = contractAddr();
    const owner = (flag("--owner") || "").trim() || die("register needs --owner <volume owner>");
    const volume = (flag("--volume") || "").trim() || die("register needs --volume <name>");
    const volId = volIdOf(owner, volume);
    const kp = await deriveVaultKey(account);
    const [role, curPub, , sealedVEK] = await read(addr, "getMember", [volId, account.address]);
    if (curPub === hex(kp.publicKey)) console.log("pubkey registered already");
    else await sendTx(account, addr, "register", [volId, hex(kp.publicKey)]);
    if (!has("--wait")) {
      if (sealedVEK && sealedVEK !== "0x") console.log(`already granted: ${ROLE[Number(role)]}`);
      else console.log("registered; access arrives when the enclave auto-grants or the owner grants you");
      return;
    }
    process.stdout.write("waiting for a grant (enclave auto-grant sweeps ~15s) ");
    for (let i = 0; i < 40; i++) {
      const [r2, , , s2] = await read(addr, "getMember", [volId, account.address]);
      if (s2 && s2 !== "0x") {
        console.log(`\ngranted: ${ROLE[Number(r2)]}`);
        try { unseal(unhex(s2), kp.secretKey); console.log("sealed VEK opens with this wallet's derived key ✓"); }
        catch { console.log("WARNING: the sealed VEK does NOT open with this wallet's key (stale grant? re-register to rotate)"); }
        return;
      }
      process.stdout.write(".");
      await new Promise((res) => setTimeout(res, 6000));
    }
    die("no grant after 4 minutes - is the volume unlocked on a running enclave (auto-grant), or ask the owner");
  }

  if (cmd === "grant") {
    const account = await loadWallet();
    const addr = contractAddr();
    const owner = (flag("--owner") || account.address).trim();
    const volume = (flag("--volume") || "").trim() || die("grant needs --volume <name>");
    const member = getAddress((flag("--member") || "").trim() || die("grant needs --member <address>"));
    const volId = volIdOf(owner, volume);
    const [, mPub, mReg] = await read(addr, "getMember", [volId, member]);
    if (!mReg || mPub === ZERO32) die(`${member} has not register()ed a pubkey for this volume yet`);
    let vek = (flag("--vek") || "").trim();
    if (!vek) {
      // no VEK on the command line: unseal your OWN on-chain copy (owner path)
      const kp = await deriveVaultKey(account);
      const [, , , mySealed] = await read(addr, "getMember", [volId, account.address]);
      if (!mySealed || mySealed === "0x") die("no --vek and no sealed VEK of your own to unseal - pass --vek");
      try { vek = hex(unseal(unhex(mySealed), kp.secretKey)); }
      catch { die("your own sealed VEK does not open with this wallet's derived key - pass --vek"); }
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(vek)) die("--vek must be 32 bytes hex");
    const role = (flag("--role") || "reader").toLowerCase() === "writer" ? 2 : 1;
    await sendTx(account, addr, "grant", [volId, member, role, hex(seal(unhex(vek), unhex(mPub)))]);
    console.log(`granted ${ROLE[role]} on '${volume}' to ${member}`);
    return;
  }

  if (cmd === "status") {
    const addr = contractAddr();
    const owner = (flag("--owner") || "").trim() || die("status needs --owner <volume owner>");
    const volume = (flag("--volume") || "").trim() || die("status needs --volume <name>");
    const volId = volIdOf(owner, volume);
    const [vOwner, exists, createdAt, members] = await read(addr, "getVolume", [volId]);
    console.log(`volId ${volId}`);
    if (!exists) return console.log("volume: NOT created on-chain");
    console.log(`owner ${vOwner} · created ${new Date(Number(createdAt) * 1000).toISOString()} · ${members} member(s)`);
    const member = (flag("--member") || process.env.MEMBER || "").trim();
    if (member) {
      const [role, pubkey, registered, sealedVEK, updatedAt] = await read(addr, "getMember", [volId, getAddress(member)]);
      console.log(`member ${member}: role=${ROLE[Number(role)]} registered=${registered} `
        + `sealedVEK=${sealedVEK === "0x" ? "none" : (sealedVEK.length - 2) / 2 + "B"} `
        + `pubkey=${pubkey === ZERO32 ? "none" : pubkey} updated=${new Date(Number(updatedAt) * 1000).toISOString()}`);
    }
    return;
  }

  if (cmd === "unlock" || cmd === "watch") {
    const account = await loadWallet();
    const addr = contractAddr();
    const depId = (flag("--id") || "").trim() || die(`${cmd} needs --id <deployment id>`);
    const name = (flag("--name") || "").trim() || die(`${cmd} needs --name <encVolume name>`);
    const owner = (flag("--owner") || "").trim() || die(`${cmd} needs --owner <volume owner>`);
    const volume = (flag("--volume") || name).trim();
    const volId = volIdOf(owner, volume);
    const noVerify = has("--no-verify");

    // your sealed VEK, from the public chain; opened by your wallet-derived key
    const vek = await unsealOwn(account, addr, volId, { owner, volume });
    console.log("unsealed your VEK ✓");

    // the enclave origin: given, or resolved from chain state (no gateway
    // trusted for discovery; attestation still gates trust at connect time)
    let url = (flag("--url") || process.env.ENCLAVE_BASE || "").trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\//.test(url)) url = "https://" + url;

    if (cmd === "unlock") {
      let repo = (flag("--repo") || "").trim();
      if (!url) {
        const run = await resolveRunner(depId);
        if (!run.leaseLive) die(`the deployment's lease has expired - it is between runners; retry once re-claimed`);
        url = run.endpoint;
        repo = repo || run.repo;
        console.log(`runner resolved from chain: ${url} (repo ${run.repo})`);
      }
      const { body } = await deliverSealed(account,
        { url, depId, name, repo: repo || "SteveDeFacto/enclave", noVerify, vek });
      console.log(`unlocked '${name}' on ${depId}: status=${body.status}` +
        (body.autoGrant ? " (enclave now auto-grants self-registered members)" : ""));
      return;
    }

    // watch: the always-on unlock agent. A fresh enclave boot has a fresh
    // per-boot vault pubkey, so "pubkey changed since last delivery" is
    // exactly the re-deliver trigger: it covers failover (new enclave),
    // enclave restart (new key, VEK gone from RAM) and supervisor re-arm.
    // Delivery is idempotent on a running deployment (the manager re-verifies
    // the VEK against the staged ciphertext).
    const interval = Math.max(10, parseInt(flag("--interval") || "30", 10)) * 1000;
    if (url) console.log(`watch: --url pins ${url} - failover to a different enclave will NOT be followed`);
    console.log(`watch: guarding '${name}' on ${depId} every ${interval / 1000}s (VEK held in this process's RAM; ctrl-c to stop)`);
    let delivered = null;   // enclave vault pubkey of the last successful delivery
    for (;;) {
      try {
        let target = url, repo = (flag("--repo") || "").trim();
        if (!target) {
          const run = await resolveRunner(depId);
          if (!run.leaseLive) throw new Error("lease expired - deployment is between runners");
          target = run.endpoint;
          repo = repo || run.repo;
        }
        const vp = await fetch(`${target}/v1/deployments/${encodeURIComponent(depId)}/vault-pubkey`)
          .then((r) => r.json()).catch(() => ({}));
        if (/^0x[0-9a-f]{64}$/i.test(vp.pubkey || "") && vp.pubkey.toLowerCase() !== delivered) {
          console.log(`watch: fresh enclave boot at ${target} - delivering the sealed VEK…`);
          const { body, enclavePub } = await deliverSealed(account,
            { url: target, depId, name, repo: repo || "SteveDeFacto/enclave", noVerify, vek });
          delivered = enclavePub;
          console.log(`watch: delivered ✓ status=${body.status}` + (body.autoGrant ? " · auto-grant armed" : ""));
        }
      } catch (e) {
        console.error(`watch: ${e.shortMessage || e.message}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  die(`unknown command '${cmd}' (setup | register | grant | status | unlock | watch)`);
}

main().catch((e) => { console.error("enclave-vault-client:", e.shortMessage || e.message); process.exit(1); });
