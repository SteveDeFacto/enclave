#!/usr/bin/env node
// nan-vault-client - the wallet side of wallet-gated encrypted volumes.
//
// Drives the full lifecycle against NanVolumeAccess (the on-chain ACL) and a
// running enclave (unlock-sealed). The crypto is scripts/nan-vault.mjs - the
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
//
// Common env/flags:
//   PK / --pk <hex>                 wallet private key (hidden prompt if omitted)
//   VOLUME_ACCESS_ADDRESS / --contract <addr>
//   NETWORK base|base-sepolia (default base) · RPC_URL / --rpc <url>
//   --owner <addr>    volume owner (defaults to YOUR address for setup/grant)
//   --volume <name>   on-chain volume name
// unlock flags:
//   --url <enclave>   the enclave origin (attested TLS terminates THERE)
//   --id <deployment> --name <encVolume name> (--volume defaults to --name)
//   --repo <gh repo>  attestation config repo (default SteveDeFacto/nan)
//   --no-verify       skip attestation verification (DEV ONLY - without it you
//                     cannot know the sealed key is going into a real enclave)
//   --member <addr>   (status/grant/--wait) someone else's entry
//   --role writer     (grant) grant Writer instead of Reader
//   --wait            (register) poll until a grant lands, then confirm unseal
//
// Examples:
//   PK=0x.. node scripts/nan-vault-client.mjs setup --volume user-data --vek 0x<from nan-vault pack>
//   PK=0x.. node scripts/nan-vault-client.mjs register --owner 0x<owner> --volume user-data --wait
//   PK=0x.. node scripts/nan-vault-client.mjs unlock --url https://enclave2... --id 0x<dep> \
//             --owner 0x<owner> --name user-data

import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { createPublicClient, createWalletClient, http, getAddress, isAddress,
         keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { DERIVE_MESSAGE, deriveKeypair, seal, unseal } from "./nan-vault.mjs";

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
  if (!isAddress(a)) die("need the NanVolumeAccess address: --contract / VOLUME_ACCESS_ADDRESS");
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

async function main() {
  if (!cmd || has("--help") || cmd === "help") {
    console.error("commands: setup | register | grant | status | unlock   (see header comment for flags)");
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
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(vek)) die("--vek must be the 32-byte hex VEK from `nan-vault pack`");
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

  if (cmd === "unlock") {
    const account = await loadWallet();
    const addr = contractAddr();
    let url = (flag("--url") || process.env.NAN_BASE || "").trim().replace(/\/+$/, "") || die("unlock needs --url <enclave origin>");
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    const depId = (flag("--id") || "").trim() || die("unlock needs --id <deployment id>");
    const name = (flag("--name") || "").trim() || die("unlock needs --name <encVolume name>");
    const owner = (flag("--owner") || "").trim() || die("unlock needs --owner <volume owner>");
    const volume = (flag("--volume") || name).trim();
    const volId = volIdOf(owner, volume);

    // 1. your sealed VEK, from the public chain; opened by your wallet-derived key
    const kp = await deriveVaultKey(account);
    const [role, pubkey, registered, sealedVEK] = await read(addr, "getMember", [volId, account.address]);
    if (!registered || sealedVEK === "0x")
      die(`${account.address} holds no sealed VEK for '${volume}' (role ${ROLE[Number(role)]}). Run: register --owner ${owner} --volume ${volume} --wait`);
    if (pubkey !== hex(kp.publicKey))
      die("your on-chain pubkey differs from this wallet's derived key (registered from another wallet?) - re-run register to rotate");
    let vek;
    try { vek = unseal(unhex(sealedVEK), kp.secretKey); }
    catch { die("could not unseal your VEK with this wallet's derived key"); }
    console.log("unsealed your VEK ✓");

    // 2. attestation: prove the URL terminates inside a measured enclave BEFORE
    //    any key material goes near it. This is the load-bearing step.
    if (has("--no-verify")) {
      console.log("WARNING: --no-verify - skipping attestation; do NOT do this against production");
    } else {
      const repo = (flag("--repo") || "SteveDeFacto/nan").trim();
      const { Verifier } = await import("@tinfoilsh/verifier");
      try {
        await new Verifier({ serverURL: url, configRepo: repo }).verify();
        console.log(`attestation verified ✓ (${url} measures as ${repo})`);
      } catch (e) {
        die(`attestation FAILED for ${url}: ${e.message} - refusing to send key material (override for dev: --no-verify)`);
      }
    }

    // 3. the enclave's per-boot pubkey, fetched over the just-verified TLS.
    //    The deployment-scoped path routes correctly through the fleet gateway
    //    (the bare /v1/vault-pubkey could answer from a different enclave).
    let vp = await fetch(`${url}/v1/deployments/${encodeURIComponent(depId)}/vault-pubkey`).then((r) => r.json()).catch(() => ({}));
    if (!vp.pubkey) vp = await fetch(`${url}/v1/vault-pubkey`).then((r) => r.json());
    if (!/^0x[0-9a-f]{64}$/i.test(vp.pubkey || "")) die(`bad vault-pubkey response: ${JSON.stringify(vp)}`);
    const sealed = hex(seal(vek, unhex(vp.pubkey)));

    // 4. SIWE login (the ACL check is on-chain; this just names the member)
    const nonce = await fetch(`${url}/v1/auth/nonce?address=${account.address}`).then((r) => r.json());
    if (!nonce.message) die(`auth nonce failed: ${JSON.stringify(nonce)}`);
    const signature = await account.signMessage({ message: nonce.message });
    const login = await fetch(`${url}/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: nonce.message, signature }),
    }).then((r) => r.json());
    if (!login.token) die(`login failed: ${JSON.stringify(login)}`);

    // 5. deliver: the enclave checks isAuthorized(volId, you) on-chain, unseals,
    //    decrypts in-RAM, and starts the app once every volume is unlocked
    const r = await fetch(`${url}/v1/deployments/${encodeURIComponent(depId)}/unlock-sealed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ name, sealed }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) die(`unlock-sealed ${r.status}: ${body.message || body.error || JSON.stringify(body)}`);
    console.log(`unlocked '${name}' on ${depId}: status=${body.status}` +
      (body.autoGrant ? " (enclave now auto-grants self-registered members)" : ""));
    return;
  }

  die(`unknown command '${cmd}' (setup | register | grant | status | unlock)`);
}

main().catch((e) => { console.error("nan-vault-client:", e.shortMessage || e.message); process.exit(1); });
