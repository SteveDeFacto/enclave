// vault-app - the browser side of NaN's wallet-gated encrypted volumes.
//
// This is scripts/nan-vault-client.mjs translated to a web page: same
// protocol (scripts/nan-vault.mjs - imported here, not reimplemented), same
// contract (NanVolumeAccess), same enclave endpoints. It is bundled by
// js/build.mjs into src/vault.js and served BY THE WASM APP ITSELF - nothing
// is loaded from a CDN at runtime, because any runtime-fetched script could
// exfiltrate the wallet-derived vault key or an unsealed VEK.
//
// Key material lifecycle (all RAM, all this tab):
//   - the X25519 keypair is derived from a deterministic wallet signature of
//     DERIVE_MESSAGE (personal_sign; never eth_decrypt) when the user asks;
//   - the VEK exists in page memory only after "unseal" (or a paste for the
//     owner bootstrap) and can be dropped with one click;
//   - nothing is ever written to localStorage/cookies; a reload forgets all.
//
// Trust chain for unlock (the load-bearing order):
//   1. resolve the deployment's runner from CHAIN STATE - NanDeployments
//      .get(id).runner is keccak256 of the enclave endpoint registered in
//      NanRegistry. No gateway is trusted for discovery.
//   2. verify THAT origin's attestation (@tinfoilsh/verifier): TLS must
//      terminate inside a measured CVM before any key material moves.
//   3. fetch the enclave's per-boot vault pubkey over the verified origin
//      (the deployment-scoped path), seal the VEK to it, SIWE, POST.
//   The sealed blob is useless to anything but that exact enclave boot, so
//   even a hostile network past step 2 gets nothing.

import {
  createPublicClient, createWalletClient, custom, http as viemHttp,
  getAddress, isAddress, keccak256, encodeAbiParameters, stringToBytes,
} from "viem";
import { Verifier } from "@tinfoilsh/verifier";
import { DERIVE_MESSAGE, deriveKeypair, seal, unseal } from "../../../../scripts/nan-vault.mjs";

// ---------------------------------------------------------------- helpers --

const hex = (u8) => "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const h = String(s).replace(/^0x/, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("bad hex");
  return Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));
};
const short = (a) => (a ? a.slice(0, 8) + "…" + a.slice(-6) : "");
const ZERO32 = "0x" + "0".repeat(64);
const ROLE = ["None", "Reader", "Writer"];

export const volIdOf = (owner, volume) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "string" }], [getAddress(owner), volume]));

// ------------------------------------------------------------------- ABIs --

const VOLUME_ACCESS_ABI = [
  { type: "function", name: "createVolume", stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "pubkey", type: "bytes32" }], outputs: [] },
  { type: "function", name: "grant", stateMutability: "nonpayable",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "member", type: "address" },
             { name: "role", type: "uint8" }, { name: "sealedVEK", type: "bytes" }], outputs: [] },
  { type: "function", name: "revoke", stateMutability: "nonpayable",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "member", type: "address" }], outputs: [] },
  { type: "function", name: "getVolume", stateMutability: "view",
    inputs: [{ name: "volId", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }, { name: "exists", type: "bool" },
              { name: "createdAt", type: "uint64" }, { name: "members", type: "uint256" }] },
  { type: "function", name: "getMember", stateMutability: "view",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "member", type: "address" }],
    outputs: [{ name: "role", type: "uint8" }, { name: "pubkey", type: "bytes32" },
              { name: "registered", type: "bool" }, { name: "sealedVEK", type: "bytes" },
              { name: "updatedAt", type: "uint64" }] },
  { type: "function", name: "getMemberPage", stateMutability: "view",
    inputs: [{ name: "volId", type: "bytes32" }, { name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ name: "addrs", type: "address[]" }, { name: "roles", type: "uint8[]" },
              { name: "pubs", type: "bytes32[]" }] },
];

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
      { name: "leaseUntil", type: "uint64" },
    ] }] },
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

// ------------------------------------------------------- chain resolution --

// id -> runner enclave, from chain state alone. NanDeployments.get(id).runner
// is keccak256(endpoint-string) of a NanRegistry entry; scan the registry for
// the match. Returns { endpoint, repo, dep } or throws with a reason a user
// can act on. Trust note: picking the endpoint from chain does NOT trust it -
// attestation at connect time is what gates key release.
export async function resolveRunner(pub, cfg, depId) {
  const dep = await pub.readContract({
    address: getAddress(cfg.deployments), abi: DEPLOYMENTS_ABI, functionName: "get", args: [depId] });
  if (!dep || dep.owner === "0x0000000000000000000000000000000000000000")
    throw new Error("no such deployment on NanDeployments");
  if (dep.runner === ZERO32)
    throw new Error("deployment has never been claimed - no runner to unlock");
  const live = Number(dep.leaseUntil) * 1000 > Date.now();
  const total = Number(await pub.readContract({
    address: getAddress(cfg.registry), abi: REGISTRY_ABI, functionName: "count", args: [] }));
  let hit = null;
  for (let start = 0; start < total && !hit; start += 50) {
    const page = await pub.readContract({
      address: getAddress(cfg.registry), abi: REGISTRY_ABI, functionName: "getPage",
      args: [BigInt(start), 50n] });
    hit = page.find((e) => keccak256(stringToBytes(e.endpoint)) === dep.runner) || null;
  }
  if (!hit)
    throw new Error(`runner ${dep.runner} is not in NanRegistry - cannot resolve its endpoint`);
  return { endpoint: hit.endpoint.replace(/\/+$/, ""), repo: hit.repo || cfg.repo, dep, leaseLive: live };
}

// re-exports so the checked-in bundle can be interop-tested from node (and so
// a console user can poke the exact primitives the page uses)
export { DERIVE_MESSAGE, deriveKeypair, seal, unseal, hex, unhex, keccak256 };

// ================================================================== the UI ==

const S = {
  cfg: null,          // config.json ⊕ URL params
  account: null,      // connected wallet address
  pub: null,          // viem public client (cfg.rpc)
  wallet: null,       // viem wallet client (window.ethereum)
  kp: null,           // wallet-derived X25519 keypair (RAM)
  vek: null,          // unsealed VEK (RAM)
  vol: null,          // { owner, name, id } - current volume
  run: null,          // resolveRunner result for the current deployment
  verified: null,     // endpoint whose attestation was verified this session
};

const $ = (id) => document.getElementById(id);

function log(msg, cls = "") {
  const el = $("log");
  const line = document.createElement("div");
  line.className = "ln " + cls;
  line.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
const logErr = (e) => log(`ERROR: ${e && (e.shortMessage || e.message) || e}`, "err");

function chainOf(cfg) {
  return {
    id: Number(cfg.chainId), name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  };
}

async function loadConfig() {
  let cfg = {};
  try { cfg = await fetch("./config.json").then((r) => r.json()); }
  catch { log("could not load ./config.json - using URL params only", "warn"); }
  const q = new URLSearchParams(location.search);
  for (const [k, param] of [["volumeAccess", "contract"], ["rpc", "rpc"], ["deployments", "deployments"],
                            ["registry", "registry"], ["repo", "repo"], ["chainId", "chain"]]) {
    if (q.get(param)) cfg[k] = q.get(param);
  }
  cfg.chainId = Number(cfg.chainId || 8453);
  S.cfg = cfg;
  S.pub = createPublicClient({ chain: chainOf(cfg), transport: viemHttp(cfg.rpc) });
  $("cfgContract").value = cfg.volumeAccess || "";
  $("cfgRpc").value = cfg.rpc || "";
  if (q.get("owner")) $("inOwner").value = q.get("owner");
  if (q.get("volume")) $("inVolume").value = q.get("volume");
  if (q.get("dep")) $("inDep").value = q.get("dep");
  log(`config: chain ${cfg.chainId}, ACL ${cfg.volumeAccess || "(unset - fill in above)"}`);
}

function applyConfig() {
  S.cfg.volumeAccess = $("cfgContract").value.trim();
  S.cfg.rpc = $("cfgRpc").value.trim() || S.cfg.rpc;
  S.pub = createPublicClient({ chain: chainOf(S.cfg), transport: viemHttp(S.cfg.rpc) });
  log(`config applied: ACL ${S.cfg.volumeAccess || "(unset)"} rpc ${S.cfg.rpc}`);
}

const needACL = () => {
  if (!isAddress(S.cfg.volumeAccess || "")) throw new Error("set the NanVolumeAccess contract address first (top bar)");
  return getAddress(S.cfg.volumeAccess);
};
const readACL = (fn, args) => S.pub.readContract({ address: needACL(), abi: VOLUME_ACCESS_ABI, functionName: fn, args });

async function writeACL(fn, args) {
  if (!S.wallet) throw new Error("connect a wallet first");
  const h = await S.wallet.writeContract({
    address: needACL(), abi: VOLUME_ACCESS_ABI, functionName: fn, args,
    account: S.account, chain: chainOf(S.cfg) });
  log(`${fn} tx ${short(h)} - waiting for confirmation…`);
  const rcpt = await S.pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
  if (rcpt.status !== "success") throw new Error(`${fn} reverted (${h})`);
  log(`${fn} confirmed ✓`, "ok");
}

// ------------------------------------------------------------------ wallet --

async function connect() {
  if (!window.ethereum) throw new Error("no browser wallet found (window.ethereum)");
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const want = "0x" + S.cfg.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    if (e && e.code === 4902) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: want, chainName: `Base (${S.cfg.chainId})`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [S.cfg.rpc] }] });
    } else { throw e; }
  }
  S.account = getAddress(addr);
  S.wallet = createWalletClient({ chain: chainOf(S.cfg), transport: custom(window.ethereum) });
  $("who").textContent = short(S.account);
  $("who").title = S.account;
  log(`wallet connected: ${S.account}`, "ok");
  if (!$("inOwner").value.trim()) $("inOwner").value = S.account;
}

function forgetKeys() {
  if (S.kp) S.kp.secretKey.fill(0);
  if (S.vek) S.vek.fill(0);
  S.kp = null; S.vek = null;
  $("myPub").textContent = "";
  renderVekState();
  log("key material dropped from page memory", "ok");
}

// The one wallet signature everything derives from. Deterministic (RFC-6979),
// so the same wallet always yields the same vault key; nothing is stored.
async function deriveKey() {
  if (!S.wallet) throw new Error("connect a wallet first");
  const sig = await S.wallet.signMessage({ account: S.account, message: DERIVE_MESSAGE });
  S.kp = deriveKeypair(unhex(sig));
  $("myPub").textContent = hex(S.kp.publicKey);
  log(`vault key derived - X25519 pubkey ${short(hex(S.kp.publicKey))}`, "ok");
}

// ------------------------------------------------------------------ volume --

function currentVol() {
  const owner = $("inOwner").value.trim();
  const name = $("inVolume").value.trim();
  if (!isAddress(owner)) throw new Error("volume owner must be an address");
  if (!name) throw new Error("volume name required");
  const id = volIdOf(owner, name);
  S.vol = { owner: getAddress(owner), name, id };
  $("volId").textContent = id;
  return S.vol;
}

async function refreshAccess() {
  const vol = currentVol();
  const [vOwner, exists, createdAt, members] = await readACL("getVolume", [vol.id]);
  const lines = [];
  if (!exists) {
    lines.push("volume: NOT created on-chain yet");
    $("ownerCard").style.display = "";
  } else {
    lines.push(`volume: created ${new Date(Number(createdAt) * 1000).toISOString().slice(0, 10)} · owner ${vOwner} · ${members} member(s)`);
    $("ownerCard").style.display = (S.account && getAddress(vOwner) === S.account) ? "" : "none";
  }
  if (S.account) {
    const [role, pubkey, registered, sealedVEK] = await readACL("getMember", [vol.id, S.account]);
    vol.me = { role: Number(role), pubkey, registered, sealedVEK };
    if (!registered) lines.push("you: not registered - derive your key, then Register");
    else {
      const match = S.kp ? (pubkey === hex(S.kp.publicKey) ? "matches this wallet ✓" : "DOES NOT match this wallet's derived key - re-register to rotate") : "derive your key to check";
      lines.push(`you: registered (pubkey ${short(pubkey)} - ${match}) · role ${ROLE[Number(role)]}`);
      lines.push(sealedVEK && sealedVEK !== "0x"
        ? `sealed VEK on-chain: ${(sealedVEK.length - 2) / 2} bytes - ready to unseal`
        : "sealed VEK: none yet - wait for the enclave auto-grant or an owner grant");
    }
  } else lines.push("connect a wallet to see your access");
  $("accessInfo").textContent = lines.join("\n");
  log("access refreshed");
}

async function registerKey() {
  if (!S.kp) await deriveKey();
  const vol = currentVol();
  await writeACL("register", [vol.id, hex(S.kp.publicKey)]);
  await refreshAccess();
}

async function waitGrant() {
  if (!S.kp) await deriveKey();
  const vol = currentVol();
  log("waiting for a grant (enclave auto-grant sweeps ~15s; up to 4 min)…");
  for (let i = 0; i < 40; i++) {
    const [role, , , sealedVEK] = await readACL("getMember", [vol.id, S.account]);
    if (sealedVEK && sealedVEK !== "0x") {
      log(`granted: ${ROLE[Number(role)]}`, "ok");
      await refreshAccess();
      return;
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  throw new Error("no grant after 4 minutes - is the volume unlocked on a running enclave (auto-grant on), or ask the owner");
}

async function unsealMine() {
  if (!S.kp) await deriveKey();
  const vol = currentVol();
  const [, pubkey, registered, sealedVEK] = await readACL("getMember", [vol.id, S.account]);
  if (!registered || !sealedVEK || sealedVEK === "0x") throw new Error("no sealed VEK on-chain for this wallet - register and get granted first");
  if (pubkey !== hex(S.kp.publicKey)) throw new Error("on-chain pubkey differs from this wallet's derived key - re-register to rotate, then wait for a fresh grant");
  try { S.vek = unseal(unhex(sealedVEK), S.kp.secretKey); }
  catch { throw new Error("could not unseal the VEK with this wallet's derived key (stale grant? re-register)"); }
  renderVekState();
  log("VEK unsealed into page memory ✓", "ok");
}

function renderVekState() {
  $("vekState").textContent = S.vek ? "VEK in page memory (RAM only - reload forgets it)" : "no VEK held";
  $("vekState").className = "chip " + (S.vek ? "on" : "");
}

// -------------------------------------------------------------- deployment --

async function resolveDep() {
  const depId = $("inDep").value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(depId)) throw new Error("deployment id must be the 0x… bytes32 from NanDeployments");
  log("resolving runner from chain state (NanDeployments → NanRegistry)…");
  S.run = await resolveRunner(S.pub, S.cfg, depId);
  S.run.depId = depId;
  S.verified = null;
  $("verifyState").textContent = "not verified";
  $("verifyState").className = "chip";
  const d = S.run;
  $("depInfo").textContent = [
    `runner endpoint: ${d.endpoint}`,
    `attestation repo: ${d.repo}`,
    `lease: ${d.leaseLive ? "LIVE until " + new Date(Number(d.dep.leaseUntil) * 1000).toISOString() : "EXPIRED - the deployment is between runners; retry once re-claimed"}`,
    `app: ${d.dep.appRef}`,
  ].join("\n");
  log(`runner: ${d.endpoint} (repo ${d.repo})`, "ok");
}

async function verifyEnclave() {
  if (!S.run) await resolveDep();
  const { endpoint, repo } = S.run;
  log(`verifying attestation of ${endpoint} against ${repo} - this fetches the live quote and the signed release measurement…`);
  await new Verifier({ serverURL: endpoint, configRepo: repo }).verify();
  S.verified = endpoint;
  $("verifyState").textContent = "attestation verified ✓";
  $("verifyState").className = "chip on";
  log(`attestation verified ✓ - TLS to ${endpoint} terminates inside the measured enclave`, "ok");
}

async function unlockDep() {
  if (!S.vek) throw new Error("no VEK in memory - Unseal (or paste + self-grant) first");
  if (!S.run) await resolveDep();
  const { endpoint, depId } = S.run;
  if (S.verified !== endpoint) {
    if ($("chkNoVerify").checked) log("WARNING: attestation verification SKIPPED - dev only; never do this with a real volume key", "warn");
    else await verifyEnclave();
  }
  const name = ($("inEncName").value.trim() || $("inVolume").value.trim());
  if (!name) throw new Error("encVolume name required");

  // per-boot pubkey over the verified origin; deployment-scoped so a gateway
  // in the path can only route it to the enclave that RUNS this deployment
  const vp = await fetch(`${endpoint}/v1/deployments/${encodeURIComponent(depId)}/vault-pubkey`).then((r) => r.json());
  if (!/^0x[0-9a-f]{64}$/i.test(vp.pubkey || "")) throw new Error(`bad vault-pubkey response: ${JSON.stringify(vp)}`);
  if (vp.contract && S.cfg.volumeAccess && getAddress(vp.contract) !== getAddress(S.cfg.volumeAccess))
    log(`WARNING: enclave ACL contract ${vp.contract} != configured ${S.cfg.volumeAccess}`, "warn");
  const sealed = hex(seal(S.vek, unhex(vp.pubkey)));
  log(`VEK sealed to enclave per-boot key ${short(vp.pubkey)}`);

  // SIWE names the member; the enclave's gate is the on-chain ACL
  const nonce = await fetch(`${endpoint}/v1/auth/nonce?address=${S.account}`).then((r) => r.json());
  if (!nonce.message) throw new Error(`auth nonce failed: ${JSON.stringify(nonce)}`);
  const signature = await S.wallet.signMessage({ account: S.account, message: nonce.message });
  const login = await fetch(`${endpoint}/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: nonce.message, signature }),
  }).then((r) => r.json());
  if (!login.token) throw new Error(`login failed: ${JSON.stringify(login)}`);

  const r = await fetch(`${endpoint}/v1/deployments/${encodeURIComponent(depId)}/unlock-sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ name, sealed }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`unlock-sealed ${r.status}: ${body.message || body.error || JSON.stringify(body)}`);
  $("unlockInfo").textContent =
    `status: ${body.status}` + (body.autoGrant ? " · auto-grant armed (self-registered wallets get sealed access)" : "") +
    (body.encVolumes ? `\nvolumes: ${JSON.stringify(body.encVolumes)}` : "");
  log(`unlocked '${name}' on ${short(depId)}: status=${body.status}`, "ok");
}

// ------------------------------------------------------------- owner panel --

async function createVolume() {
  const name = $("inVolume").value.trim();
  if (!name) throw new Error("volume name required");
  await writeACL("createVolume", [name]);
  await refreshAccess();
}

// Owner bootstrap: paste the VEK printed by `nan-vault pack`/`pack-blocks`,
// seal it to your OWN derived key, self-grant Writer. After this the VEK
// lives (sealed) on-chain and the paste box can be cleared.
async function selfGrant() {
  if (!S.kp) await deriveKey();
  const vol = currentVol();
  const vekHex = $("inVek").value.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(vekHex)) throw new Error("paste the 32-byte VEK hex printed by nan-vault pack");
  const [, pubkey, registered] = await readACL("getMember", [vol.id, S.account]);
  if (!registered || pubkey !== hex(S.kp.publicKey)) {
    log("registering your pubkey first…");
    await writeACL("register", [vol.id, hex(S.kp.publicKey)]);
  }
  await writeACL("grant", [vol.id, S.account, 2, hex(seal(unhex(vekHex), S.kp.publicKey))]);
  S.vek = unhex(vekHex);
  $("inVek").value = "";
  renderVekState();
  await refreshAccess();
  log("self-granted Writer - the VEK is sealed to your wallet on-chain; the paste box was cleared", "ok");
}

let _memberCursor = 0;
async function loadMembers(reset = true) {
  const vol = currentVol();
  if (reset) { _memberCursor = 0; $("memberList").innerHTML = ""; }
  const [addrs, roles, pubs] = await readACL("getMemberPage", [vol.id, BigInt(_memberCursor), 100n]);
  _memberCursor += addrs.length;
  const tbl = $("memberList");
  addrs.forEach((a, i) => {
    const tr = document.createElement("tr");
    const roleTd = `<td>${ROLE[Number(roles[i])]}</td>`;
    const pubTd = `<td class="mono" title="${pubs[i]}">${pubs[i] === ZERO32 ? "-" : short(pubs[i])}</td>`;
    tr.innerHTML = `<td class="mono" title="${a}">${short(a)}</td>${roleTd}${pubTd}<td></td>`;
    const actions = tr.lastElementChild;
    for (const [label, fn] of [
      ["grant R", () => grantMember(a, 1)],
      ["grant W", () => grantMember(a, 2)],
      ["revoke", () => writeACL("revoke", [vol.id, a]).then(() => loadMembers())],
    ]) {
      const b = document.createElement("button");
      b.textContent = label; b.className = "mini";
      b.onclick = () => fn().catch(logErr);
      actions.appendChild(b);
    }
    tbl.appendChild(tr);
  });
  $("btnMoreMembers").style.display = addrs.length === 100 ? "" : "none";
  log(`loaded ${addrs.length} member(s)${addrs.length === 100 ? " (more available)" : ""}`);
}

async function grantMember(addr, role) {
  const vol = currentVol();
  if (!S.vek) await unsealMine();   // owner unseals their own on-chain copy
  const [, mPub, mReg] = await readACL("getMember", [vol.id, getAddress(addr)]);
  if (!mReg || mPub === ZERO32) throw new Error(`${addr} has not registered a pubkey for this volume`);
  await writeACL("grant", [vol.id, getAddress(addr), role, hex(seal(S.vek, unhex(mPub)))]);
  await loadMembers();
}

async function grantManual() {
  const addr = $("inGrantAddr").value.trim();
  if (!isAddress(addr)) throw new Error("grant needs a member address");
  await grantMember(addr, Number($("selGrantRole").value));
}

// -------------------------------------------------------------------- init --

function bind(id, fn) {
  $(id).addEventListener("click", () => Promise.resolve().then(fn).catch(logErr));
}

async function init() {
  await loadConfig();
  renderVekState();
  bind("btnApplyCfg", applyConfig);
  bind("btnConnect", connect);
  bind("btnDerive", deriveKey);
  bind("btnForget", forgetKeys);
  bind("btnRefresh", refreshAccess);
  bind("btnRegister", registerKey);
  bind("btnWaitGrant", waitGrant);
  bind("btnUnseal", unsealMine);
  bind("btnResolve", resolveDep);
  bind("btnVerify", verifyEnclave);
  bind("btnUnlock", unlockDep);
  bind("btnCreate", createVolume);
  bind("btnSelfGrant", selfGrant);
  bind("btnLoadMembers", () => loadMembers(true));
  bind("btnMoreMembers", () => loadMembers(false));
  bind("btnGrantManual", grantManual);
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on("accountsChanged", () => {
      forgetKeys();
      S.account = null; S.wallet = null;
      $("who").textContent = "not connected";
      log("wallet account changed - key material dropped; reconnect", "warn");
    });
  }
  log("vault app ready - connect a wallet to begin");
}

// Expose the protocol surface for the node interop test (js/test-bundle.mjs)
// and for power users in the browser console. Guarded DOM init so the same
// bundle loads headless.
globalThis.NanVault = {
  DERIVE_MESSAGE, deriveKeypair, seal, unseal, volIdOf, hex, unhex, keccak256, resolveRunner, Verifier,
};
if (typeof document !== "undefined" && document.getElementById) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init().catch(logErr));
  else init().catch(logErr);
}
