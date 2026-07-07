/* ============================================================
   Deploy page — the console form (two dials, request preview)
   and the on-chain create+fund flow. Everything data-driven
   around it is a component: <c-terminal> (output),
   <c-fleet-list> / <c-volume-picker> (live capacity),
   <c-deployments> (the My Apps panel).
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/terminal/terminal.js";
import "../../components/fleet-list/fleet-list.js";
import "../../components/volume-picker/volume-picker.js";
import { appLabel, appEndpoint } from "../../components/deployments/deployments.js";
import { $, $$, esc, short, wait, fmtNum, fmtDur, hlJson, hlCode, copyText, showToast, statusCls, on } from "../core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS, IPFS_UPLOAD_URL, BASE_CHAIN, PRIVY_RDNS } from "../core/config.js";
import { Enclave, EnclaveError } from "../core/api.js";
import { CARD_GB, NODE_VCPUS, NODE_RAM_GB, CARD_TFLOPS, NODE_GFLOPS, shareRates } from "../core/pricing.js";
import { encUint, encAddr, encBytes32, encBytesTail, randHex, usdc6, encCall, DEP_SEL, DEP_CREATED_TOPIC, APPROVAL, depGet, depRate6, waitReceipt } from "../core/chain.js";
import { authenticate, connectWallet, refreshWallet, ensureBaseChain, sendTx, usdcBalanceOf, ethBalanceOf, openBuyModal } from "../core/wallet.js";
import { STORE, loadCatalog, REF_CACHE, PORTS_CACHE, MINS_CACHE, looksFriendly, resolveAppRef, validPortsCsv } from "../core/catalog.js";

/* component handles (assigned in initDeploy) */
let term = null, deps = null, fleetList = null, volPicker = null;

/* ============================================================
   Console state + request rendering
   ============================================================ */
const dep = { gpuPct: 25, cpuPct: 5, minGpuPct: 0, minCpuPct: 1, asset: "USDC", public: true, gpuEnclave: true, volumes: new Set() };  // gpuEnclave: from /availability (gpu:false = CPU-only enclave); volumes: attached model volume names
function renderAccessNote(){
  const el = $("#accessNote"); if (!el) return;
  el.innerHTML = dep.public
    ? "anyone can reach the app endpoint, for websites, APIs, servers. SSH stays owner-only."
    : "only your wallet (SIWE token) can reach the app, for private/confidential jobs.";
}

// The selected app's minimum shares for the two dials. Friendly slug:version
// refs resolve to their catalog specs; raw CIDs we can't see specs for get
// the open floor (0% GPU / 1% CPU) - the enclave still enforces the real
// minimums server-side.
function currentMins(){
  const input = ($("#cfgImage") ? $("#cfgImage").value : "").trim();
  return MINS_CACHE[input] || { gpuPct: 0, cpuPct: 1 };
}
function deployBody(){
  // `image.reference` is the Wasm app to run: a catalog slug:version resolved to
  // its ipfs://<cid> by resolveAppRef() (the enclave fetches + verifies those
  // bytes against the CID). Raw CID input is refused — deploys need the listing.
  const body = { image: { reference: resolveAppRef($("#cfgImage").value).reference } };
  body.public = dep.public;   // public endpoint (anyone) vs private (owner token only)
  // firewall: ports the app may bind (from the catalog via Use-in-Deploy; editable)
  const fw = ($("#cfgPorts") && $("#cfgPorts").value || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (fw.length && !(fw.length === 1 && fw[0] === "http")) body.firewall = { ports: fw };
  const gp = dep.gpuEnclave ? Math.min(1, Math.max(0, Math.round(dep.gpuPct) / 100)) : 0;
  const cp = Math.min(1, Math.max(0.01, Math.round(dep.cpuPct) / 100));
  body.resources = { gpuShare: gp, cpuShare: cp };   // the two dials; the app's specs set the minimums
  // GPU attestation only exists when the deployment holds a card slice.
  if (gp > 0 && dep.gpuEnclave) body.attestationPolicy = { requireGpuAttestation: true };
  const cc = ($("#cfgConfig") && $("#cfgConfig").value || "").trim();
  if (dep.volumes.size) body.volumes = [...dep.volumes];   // attached model volumes (built into configCid at deploy)
  else if (cc) body.configCid = cc;                        // per-deployment config, delivered to the app as ENCLAVE_CONFIG
  body.region = "auto";
  return body;
}
function deployFetch(b){
  const r = (b.image && b.image.reference) || "ipfs://…";
  const g = Math.round(((b.resources && b.resources.gpuShare) || 0) * 1000);
  const c = Math.round(((b.resources && b.resources.cpuShare) || 0.05) * 1000);
  const fw = (b.firewall && b.firewall.ports || []).join(",");
  const cc = b.configCid || "";
  return '// Deployments are ON-CHAIN work items (EnclaveDeployments on Base): the ledger\n'
    + '// holds the spec + funded balance, so they survive enclave updates and crashes.\n'
    + '// 1) create() from your wallet - one tx; msg.sender owns the record:\n'
    + '//    create(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, sshPubKey, configCid)\n'
    + '//    configCid: optional IPFS CID of a JSON config the enclave verifies and\n'
    + '//    hands the app as ENCLAVE_CONFIG (e.g. choose a model / set an API key).\n'
    + 'const { id } = await createOnChain("' + DEPLOYMENTS_ADDRESS + '",\n'
    + '  ["' + r + '", ' + g + ', ' + c + ', 8080, "' + fw + '", ' + !!b.public + ', "", "' + cc + '"]);\n'
    + '//    id = topics[1] of the Created event in the receipt\n'
    + '// 2) fund it - credited to the on-chain balance (funds forward to Enclave):\n'
    + '//    fundWithAuthorization(id, …EIP-3009 USDC sig…)  or  fundEth(id) payable\n'
    + '// 3) nudge the fleet (optional; the sweep claims funded work within ~1 min):\n'
    + 'await fetch("' + Enclave.base + '/claim-hint", { method: "POST",\n'
    + '  headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });\n'
    + '// 4) EnclaveDeployments.get(id).runner is the serving enclave; your app origin is\n'
    + '//    https://<first 8 hex chars of id>.' + APP_DOMAIN;
}
function deployCurl(b){
  return "# deployments are created on-chain, not by POST (see the JS tab):\n"
    + "#   1) create() + 2) fundWithAuthorization()/fundEth() from your wallet\n"
    + "# then nudge the fleet to claim it right away:\n"
    + "curl -X POST " + Enclave.base + "/claim-hint \\\n"
    + '  -H "Content-Type: application/json" \\\n'
    + "  -d '{\"id\": \"0x<deployment id>\"}'";
}
function renderDeploy(){
  const body = deployBody();
  $("#outReq").innerHTML = hlJson(body);
  $("#outFetch").innerHTML = hlCode(deployFetch(body));
  $("#outCurl").innerHTML = hlCode(deployCurl(body));
  const budget = parseFloat($("#cfgBudget").value) || 0;
  // the app's specs set the dials' floors; reflect them on the inputs live
  const mins = currentMins();
  dep.minGpuPct = mins.gpuPct; dep.minCpuPct = mins.cpuPct;
  const gIn = $("#cfgGpuShare"); if (gIn) gIn.min = String(dep.gpuEnclave ? mins.gpuPct : 0);
  const cIn = $("#cfgCpuShare"); if (cIn) cIn.min = String(mins.cpuPct);
  const gpuPct = dep.gpuEnclave ? (dep.gpuPct || 0) : 0;
  const cpuPct = dep.cpuPct || 0;
  let rate, readout;
  if (gpuPct > 100 || cpuPct > 100) {
    rate = 0; readout = "✕ a share exceeds 100% of the " + (gpuPct > 100 ? "card" : "node");
  }
  else if (dep.gpuEnclave && gpuPct < mins.gpuPct) {
    rate = 0; readout = "✕ this app needs at least a " + mins.gpuPct + "% GPU share (its specs: that much VRAM/compute on a " + CARD_GB + " GB / " + CARD_TFLOPS + " TFLOPS card)";
  }
  else if (cpuPct < mins.cpuPct) {
    rate = 0; readout = "✕ this app needs at least a " + mins.cpuPct + "% CPU share (its specs: that much RAM/compute on a " + NODE_RAM_GB + " GB / " + NODE_GFLOPS + " GFLOPS node)";
  }
  else if (gpuPct > 0 && Math.round(cpuPct) > Math.round(gpuPct)) {
    rate = 0; readout = "✕ CPU share (" + Math.round(cpuPct) + "%) can't exceed GPU share (" + Math.round(gpuPct) + "%) - a GPU app's CPU slice rides on its card's node";
  }
  else {
    const g = shareRates(gpuPct, cpuPct); rate = g.rate;
    readout = (g.gpuPct > 0
      ? "→ " + g.gpuPct + "% of card ≈ " + g.vramGb.toFixed(0) + " GB VRAM / " + Math.round(g.tflops) + " TFLOPS · "
      : "→ CPU-only · ")
      + g.cpuPct + "% of node ≈ " + fmtNum(g.ramGb) + " GB RAM / " + fmtNum(g.vcpus) + " vCPU / " + Math.round(g.gflops) + " GFLOPS · $"
      + (rate * 3600).toFixed(2) + "/hr";
  }
  const t = $("#tierOut"); if (t) t.textContent = readout;
  $("#estRuntime").textContent = rate > 0 ? fmtDur(budget / rate) : "–";
}
function switchPane(name){
  $$(".console-tabs button").forEach(b => b.classList.toggle("on", b.dataset.pane === name));
  $$(".console-body .pane").forEach(p => p.classList.toggle("on", p.dataset.pane === name));
}

/* ============================================================
   Payments — minimal ABI encoding for EnclavePay payWithAuthorization
   + payEth and the EnclaveDeployments funding pair (no web3 lib)
   ============================================================ */
const SEL_PAY_AUTH = "7d368d83";  // payWithAuthorization(bytes32,address,uint256,uint256,uint256,bytes32,bytes); verified vs viem
const SEL_PAYETH   = "00bd4dee";  // payEth(bytes32) payable; verified vs viem
// payWithAuthorization: 7 head words; `signature` is dynamic, so its head slot
// holds the tail offset (7*32) and the bytes follow as length + padded data.
const dataPayWithAuth = (ref, from, amt6, validAfter, validBefore, nonce, sig) =>
  "0x" + SEL_PAY_AUTH + encBytes32(ref) + encAddr(from) + encUint(amt6)
       + encUint(validAfter) + encUint(validBefore) + encBytes32(nonce)
       + encUint(7 * 32) + encBytesTail(sig);
const dataPayEth = (ref) => "0x" + SEL_PAYETH + encBytes32(ref);
// EnclaveDeployments funding: byte-identical parameter shape to EnclavePay's pair, but
// the credit lands in the deployment's ON-CHAIN balance6 (funds still forward
// to the payout in the same tx - nothing is custodied by the contract).
const dataFundWithAuth = (ref, from, amt6, validAfter, validBefore, nonce, sig) =>
  "0x" + DEP_SEL.fundAuth + encBytes32(ref) + encAddr(from) + encUint(amt6)
       + encUint(validAfter) + encUint(validBefore) + encBytes32(nonce)
       + encUint(7 * 32) + encBytesTail(sig);
const dataFundEth = (ref) => "0x" + DEP_SEL.fundEth + encBytes32(ref);
// USD -> wei at the enclave's quoted ETH/USD rate (an ESTIMATE for the tx amount;
// the enclave credits the actual wei at its own live Chainlink read on arrival)
function usdToWei(usd, ethUsd){
  const price = parseFloat(ethUsd);
  if (!(price > 0)) throw new EnclaveError("No live ETH/USD rate from the enclave; pay in USDC, or retry shortly.", 0);
  return BigInt(Math.round((usd / price) * 1e9)) * 1000000000n;   // 9dp of ETH precision
}

/* pay (or top up) a deployment.
   USDC: sign an EIP-3009 ReceiveWithAuthorization (EIP-712, a gas-free wallet
         signature), then ONE payWithAuthorization tx; no approve, no
         allowance left behind.
   ETH:  payEth(ref) with msg.value: ONE transaction; the enclave credits the wei
         as USDC-equivalent at its live Chainlink ETH/USD read when the event lands. */
async function payForRuntime(term, pay, fundUsdc){
  // Two receivers, one shape: the EnclavePay forwarder (legacy container flavor,
  // off-chain clock) or the EnclaveDeployments ledger (pay.contract - the credit
  // lands in the deployment's on-chain balance6, so ANY enclave can serve it).
  const ledger = !(pay && pay.forwarder);
  const to = pay && (pay.forwarder || pay.contract);
  if (!to) throw new EnclaveError("No payment instructions (neither a forwarder nor the deployments contract was returned).", 0);
  await ensureBaseChain();
  const amt6 = usdc6(fundUsdc);                       // cent-rounded 6dp USDC
  if (amt6 <= 0n) throw new EnclaveError("Fund at least $0.01 (USDC).", 0);
  const usd = (Number(amt6) / 1e6).toFixed(2);        // e.g. "10.00", what actually gets signed/paid
  if (dep.asset === "ETH"){
    if (!ledger && !pay.payEthMethod) throw new EnclaveError("This enclave doesn't accept ETH yet (older release); pay in USDC.", 0);
    if (!pay.ethUsd) throw new EnclaveError("No ETH/USD quote available right now; fund in USDC instead.", 0);
    const wei = usdToWei(Number(amt6) / 1e6, pay.ethUsd);
    const eth = (Number(wei) / 1e18).toFixed(6);
    term.line("info", "[*] " + (ledger ? "fundEth" : "payEth") + " ≈ " + eth + " ETH (≈ $" + usd + " @ $" + pay.ethUsd + "/ETH)… (wallet · one tx)");
    const ph = await sendTx(to, (ledger ? dataFundEth : dataPayEth)(pay.deploymentRef), "0x" + wei.toString(16));
    term.line("ok", "[✓] payment sent " + ph);
    term.line("dimln", ledger
      ? "    credited to the deployment's on-chain balance at the contract's live Chainlink rate; funds forward to Enclave"
      : "    ETH goes straight to Enclave; the enclave credits it at the live Chainlink rate");
    return ph;
  }
  // EIP-3009: the nonce must start with the deployment ref's first 16 bytes (the
  // receiving contract enforces this, binding the signature to THIS deployment);
  // the other 16 are random so repeat top-ups from the same wallet never collide.
  const nonce = "0x" + encBytes32(pay.deploymentRef).slice(0, 32) + randHex(16);
  const validBefore = Math.floor(Date.now() / 1000) + 3600;   // 1h to get the tx mined
  // sign against the TOKEN's own EIP-712 domain (enclave reads it from the chain;
  // fall back to Base-mainnet USDC's well-known fields if it hasn't yet)
  const dom = pay.usdcDomain || { name: "USD Coin", version: "2", chainId: BASE_CHAIN, verifyingContract: pay.usdc };
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
    },
    domain: { name: dom.name, version: dom.version, chainId: Number(dom.chainId), verifyingContract: dom.verifyingContract },
    primaryType: "ReceiveWithAuthorization",
    message: { from: Enclave.address, to: to, value: amt6.toString(),
               validAfter: "0", validBefore: String(validBefore), nonce: nonce },
  };
  term.line("info", "[*] sign a " + usd + " USDC payment authorization (EIP-3009)… (wallet · gas-free signature)");
  let sig = await Enclave.provider.request({ method: "eth_signTypedData_v4", params: [Enclave.address, JSON.stringify(typed)] });
  // some wallets return v as 0/1; USDC's ecrecover wants 27/28 (65-byte ECDSA
  // sigs only; longer EIP-1271 smart-wallet blobs pass through untouched)
  if (sig.replace(/^0x/, "").length === 130) {
    const v = parseInt(sig.slice(-2), 16);
    if (v === 0 || v === 1) sig = sig.slice(0, -2) + (v + 27).toString(16);
  }
  term.line("info", "[*] pay " + usd + " USDC · buys runtime… (wallet · one tx, no approve)");
  const ph = await sendTx(to, (ledger ? dataFundWithAuth : dataPayWithAuth)(pay.deploymentRef, Enclave.address, amt6, 0, validBefore, nonce, sig));
  term.line("ok", "[✓] payment sent " + ph);
  term.line("dimln", ledger
    ? "    credited to the deployment's on-chain balance; funds forward to Enclave - nothing is custodied"
    : "    funds go straight to Enclave; nothing is custodied");
  return ph;
}

/* ---- real deploy: create -> pay -> provisioned, all from the browser ---- */
async function runDeploy(){
  const btn = $("#deployBtn"); if (btn.disabled) return;
  switchPane("run"); term.startRun();
  // resolve a friendly slug:version -> ipfs://<cid> (may need to read the catalog first)
  const raw = $("#cfgImage").value.trim();
  if (looksFriendly(raw) && !REF_CACHE[raw] && !STORE.loaded){
    term.line("info", "[*] resolving " + raw + " from the catalog…");
    try { await loadCatalog(); } catch(e){}
  }
  const rref = resolveAppRef(raw);
  if (rref.error){ term.line("warn", "[!] " + rref.error); return; }
  if (rref.pending){ term.line("warn", "[!] couldn’t reach the catalog to resolve " + raw + " — deploys need the on-chain listing; try again in a moment."); return; }
  const fwErr = validPortsCsv($("#cfgPorts") ? $("#cfgPorts").value : "");
  if (fwErr){ term.line("warn", "[!] firewall: " + fwErr); return; }
  // pre-flight the catalog gate BEFORE any wallet action: enclaves refuse
  // yanked / unapproved / unlisted versions deterministically, so paying for
  // one just parks USDC on an unclaimable deployment.
  try {
    if (!STORE.loaded){ try { await loadCatalog(); } catch(e){} }
    const cid = String(rref.reference || "").replace(/^ipfs:\/\//, "");
    let hit = null;
    for (const a of (STORE.apps || [])) for (const v of (a.versions || [])) if (v && v.cid === cid){ hit = { a, v }; }
    if (hit && hit.v.yanked){
      term.line("warn", "[!] " + hit.a.slug + ":" + hit.v.version + " is YANKED by its publisher - enclaves will never claim it.");
      term.line("dimln", "    pick another version, or republish this CID as a new version (the catalog follows the newest listing), then deploy.");
      return;
    }
    if (hit && hit.v.approval !== APPROVAL.approved){
      term.line("warn", "[!] " + hit.a.slug + ":" + hit.v.version + " is " + (hit.v.approval === APPROVAL.rejected ? "REJECTED" : "still PENDING approval") + " - enclaves only claim approved versions.");
      return;
    }
    if (!hit && STORE.loaded && STORE.apps.length){
      term.line("warn", "[!] this CID isn't listed in the on-chain catalog - enclaves refuse unlisted apps. Publish it on the Apps page first.");
      return;
    }
  } catch(e){}
  const fund = parseFloat($("#cfgBudget").value) || 0;
  const dry = $("#dryRun") && $("#dryRun").checked;

  // ---- ON-CHAIN deploy (EnclaveDeployments): the ledger, not any one enclave,
  // holds the spec and the funded balance, so the deployment survives enclave
  // updates and crashes - runners hold expiring leases and re-claim work.
  const gpuMilli = dep.gpuEnclave ? Math.round(Math.max(0, Math.min(100, dep.gpuPct))) * 10 : 0;
  const cpuMilli = Math.round(Math.max(1, Math.min(100, dep.cpuPct))) * 10;
  const fwCsv = ($("#cfgPorts") && $("#cfgPorts").value || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const portsCsv = (fwCsv.length && !(fwCsv.length === 1 && fwCsv[0] === "http")) ? fwCsv.join(",") : "";
  const httpEntry = fwCsv.find(x => /^http:\d+$/.test(x));
  const appPort = httpEntry ? parseInt(httpEntry.split(":")[1], 10) : 8080;
  let configCid = ($("#cfgConfig") && $("#cfgConfig").value || "").trim();
  const volNames = [...dep.volumes];

  if (dry){
    term.line("warn", "// dry run: nothing is sent");
    if (volNames.length) term.line("info", "0) volumes " + JSON.stringify(volNames) + " -> the console pins {\"volumes\":[…]} to IPFS and passes its CID as configCid");
    term.line("p", "1) EnclaveDeployments.create(app, shares, ports) - one wallet tx; you own the record");
    term.line("dimln", "   create(\"" + rref.reference + "\", " + gpuMilli + ", " + cpuMilli + ", " + appPort + ", \"" + portsCsv + "\", " + dep.public + ", \"\", \"" + (volNames.length ? "<pinned config CID>" : configCid) + "\")");
    term.line("p", dep.asset === "ETH"
      ? "2) fundEth(id) with ≈ $" + fund + " of ETH - one wallet tx; credited on-chain"
      : "2) sign a " + fund + " USDC authorization (EIP-3009) + one fundWithAuthorization(id) tx - credited on-chain");
    term.line("p", "3) POST /v1/claim-hint - an enclave claims the work and serves it");
    term.line("dimln", "   the balance and spec live on Base: any enclave can take over if the runner dies");
    term.line("info", "uncheck “Dry run” to deploy for real");
    return;
  }

  btn.disabled = true; const lbl = btn.textContent; btn.textContent = "working…";
  try {
    if (!Enclave.token){
      term.line("info", "[*] connecting wallet + signing in (SIWE)…");
      await authenticate();
      term.line("ok", "[✓] signed in as " + short(Enclave.address));
    }
    // a restored session has a token but NO provider - reconnect before any tx
    if (!Enclave.provider){
      term.line("info", "[*] reconnecting wallet…");
      await connectWallet();
      term.line("ok", "[✓] wallet " + short(Enclave.address));
    }
    term.line("dimln", "    if nothing happens, check your wallet - a popup may be waiting (or queued behind an old one; open the wallet and clear pending requests)");
    await ensureBaseChain();

    // rate estimate straight from the contract (same ceil math as create) -
    // best-effort with a hard cap so a slow RPC can never stall the deploy
    let rate6 = 0n;
    try { rate6 = await Promise.race([depRate6(gpuMilli, cpuMilli), wait(6000).then(() => 0n)]); } catch(e){}
    if (rate6 > 0n){
      const rate = Number(rate6) / 1e6;
      term.line("info", "    " + fund + " USDC ≈ " + fmtDur(fund / rate) + " of runtime at $" + (rate * 3600).toFixed(2) + "/hr");
    }

    // 0) attached volumes: build + pin a config the enclave mounts. If the
    // user also typed a config CID, the volume picker takes precedence (the
    // two can't be merged client-side - a CID is opaque).
    if (volNames.length){
      term.line("p", "$ pin app config  (volumes -> IPFS -> configCid)");
      if (configCid) term.line("warn", "    (ignoring the pasted config CID - the volume picker builds the config; put volumes in your own config to combine)");
      const jsonUrl = (IPFS_UPLOAD_URL || "").replace(/\/add-wasm$/, "/add-json");
      if (!jsonUrl) throw new EnclaveError("volume attach needs the upload gateway; not configured here. Pin {\"volumes\":[…]} yourself and paste its CID.", 0);
      const cfgObj = { volumes: volNames };
      const pr = await fetch(jsonUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfgObj) });
      const pj = await pr.json().catch(() => ({}));
      if (!pr.ok || !pj.cid) throw new EnclaveError("config pin failed: " + (pj.error || ("HTTP " + pr.status)), 0);
      configCid = pj.cid;
      term.line("ok", "[✓] config pinned " + configCid + "  (mounts: " + volNames.join(", ") + " -> /models/…)");
    }

    // 1) create: one tx from YOUR wallet - msg.sender owns the on-chain record
    term.line("p", "$ EnclaveDeployments.create(…)  (wallet · one tx · you own the record)");
    term.line("info", "[*] confirm the create transaction in your wallet…");
    const cdata = encCall(DEP_SEL.create, [
      { t: "str", v: rref.reference }, { t: "uint", v: gpuMilli }, { t: "uint", v: cpuMilli },
      { t: "uint", v: appPort }, { t: "str", v: portsCsv }, { t: "bool", v: dep.public },
      { t: "str", v: "" }, { t: "str", v: configCid },
    ]);
    const chash = await sendTx(DEPLOYMENTS_ADDRESS, cdata);
    term.line("dimln", "  ↳ sent " + chash + " · waiting for confirmation…");
    const rcpt = await waitReceipt(chash);
    const clog = (rcpt.logs || []).find(l => (l.topics || [])[0] === DEP_CREATED_TOPIC
      && (l.address || "").toLowerCase() === DEPLOYMENTS_ADDRESS.toLowerCase());
    if (!clog) throw new EnclaveError("create() confirmed but no Created event found in the receipt", 0);
    const id = clog.topics[1];
    term.line("ok", "[✓] created " + id);

    // 2) fund: the credit lands in the deployment's on-chain balance
    let pricing = null;
    try { pricing = await (await fetch(Enclave.base + "/pricing", { signal: AbortSignal.timeout(8000) })).json(); } catch(e){}
    try {
      await payForRuntime(term, {
        contract: DEPLOYMENTS_ADDRESS, deploymentRef: id,
        usdcDomain: pricing && pricing.usdcDomain, usdc: (pricing && pricing.usdc) || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ethUsd: pricing && pricing.ethUsd,
      }, fund);
    } catch(e){
      const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
      term.line("warn", rejected ? "[x] funding rejected in wallet." : "[x] funding failed: " + (e.message || e));
      term.line("dimln", "    " + id + " exists on-chain but is unfunded (inert, costs nothing). Fund it any time - it starts once it has balance.");
      return;
    }

    // 3) nudge the fleet - otherwise the next sweep (<=60s) picks it up
    term.line("info", "[*] hinting enclaves to claim…");
    try {
      const h = await (await fetch(Enclave.base + "/claim-hint", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })).json();
      if (h && h.accepted === false && h.reason) term.line("dimln", "    hint declined: " + h.reason + " (the sweep may still claim it)");
    } catch(e){ term.line("dimln", "    hint failed (" + (e.message || e) + "); the sweep claims funded work within ~1 min"); }

    // 4) watch the ledger for a runner, then the runner for "running"
    let claimed = null, lastReason = "";
    for (let i = 0; i < 90 && !claimed; i++){
      await wait(2000);
      let d = null; try { d = await depGet(id); } catch(e){}
      if (d && d.runner && !/^0x0+$/.test(d.runner) && d.leaseUntil * 1000 > Date.now()) claimed = d;
      else if (i === 1) term.line("info", "[*] waiting for an enclave to claim (the lease appears on-chain)…");
      else if (i > 1 && i % 15 === 0){
        // don't wait in silence: ask the fleet WHY it isn't claiming
        try {
          const h = await (await fetch(Enclave.base + "/claim-hint", { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })).json();
          if (h && h.accepted === false && h.reason && h.reason !== lastReason){
            lastReason = h.reason;
            term.line("warn", "[!] fleet declines to claim: " + h.reason);
            if (/yanked|not.approved|rejected|delisted|unlisted|below|minimum/i.test(h.reason)){
              term.line("dimln", "    this won't resolve by waiting - fix the app version in the catalog. The deployment stays funded and is claimed automatically once deployable.");
              break;
            }
          }
        } catch(e){}
      }
    }
    if (!claimed){
      term.line("warn", "[!] no enclave has claimed yet - the deployment stays on the queue (funded work is claimed as capacity frees up). Check back on the dashboard.");
      deps.refresh(); return;
    }
    term.line("ok", "[✓] claimed by enclave operator " + short(claimed.runnerOperator) + " · lease until " + new Date(claimed.leaseUntil * 1000).toLocaleTimeString());
    const label = appLabel(id);
    term.line("dimln", "    app origin: https://" + label + "." + APP_DOMAIN + "  (first request may take a moment: the enclave fetches + verifies your wasm from IPFS)");

    const final = await pollDeployment(id);
    deps.refresh({ highlight: (final && final.id) || id });
  } catch(e){
    term.line("warn", "[x] " + (e.message || String(e)));
    if (e.status === 0) term.line("dimln", "    set a reachable endpoint above, then retry.");
  } finally {
    btn.disabled = false; btn.textContent = lbl;
    refreshWallet();
  }
}
async function pollDeployment(id){
  const done = { running: 1, failed: 1, stopped: 1, error: 1 };
  let last = null, d = null;
  for (let i = 0; i < 180; i++){
    try { d = await Enclave.getDeployment(id); }
    catch(e){ term.line("dimln", "  … " + e.message); await wait(2500); continue; }
    if (d.status !== last){ last = d.status; term.line(statusCls(d.status), "  • " + d.status); }
    if (done[d.status]){
      if (d.status === "running"){
        const ep = appEndpoint(d);
        term.line("ok", "[✓] running" + (ep ? " · " + ep : ""));
        if (d.ratePerSecondUsdc) term.line("dimln", "    rate " + d.ratePerSecondUsdc + " USDC/s · " + (d.timeRemainingSec != null ? fmtDur(d.timeRemainingSec) + " funded" : "funded"));
        term.line("warn", "→ verify the attestation before sending data");
      } else {
        term.line("warn", "  ‹ ended: " + d.status + (d.error ? " · " + d.error : "") + " ›");
      }
      return d;
    }
    await wait(2500);
  }
  term.line("dimln", "  (still provisioning; track it in the panel below)");
  return d;
}

/* ============================================================
   Live capacity: the dials' caps + the fleet / volume components
   ============================================================ */
let availPoll = null;
async function refreshAvailability(){
  const gIn = $("#cfgGpuShare"), capG = $("#gpuShareCap");
  const cIn = $("#cfgCpuShare"), capC = $("#cpuShareCap");
  if (!gIn) return;
  try {
    const a = await Enclave.getAvailability();
    dep.gpuEnclave = a.gpu !== false;               // gpu:false = CPU-only enclave (older enclaves omit the field)
    const unitG = $("#gpuShareUnit");
    if (unitG) unitG.textContent = dep.gpuEnclave ? "(% of one card · 0 = CPU-only app)" : "(CPU-only enclave · no GPU here)";
    const cardGb = (a.cardVramGb != null) ? a.cardVramGb : CARD_GB;
    const cardTf = (a.cardTflops != null) ? a.cardTflops : CARD_TFLOPS;
    const nodeRamGb = (a.nodeRamGb != null) ? a.nodeRamGb : NODE_RAM_GB;
    // both pools, live: the largest free slice of one card and the node's
    // leftover vCPU+RAM pool; maxShare = older enclaves
    const gpuFree = (a.gpuShareFree != null ? a.gpuShareFree : (a.gpu !== false ? (a.maxShare || 0) : 0));
    const cpuFree = (a.cpuShareFree != null ? a.cpuShareFree : (a.gpu === false ? (a.maxShare || 0) : 1));
    const gpuFreePct = Math.floor(gpuFree * 100), cpuFreePct = Math.floor(cpuFree * 100);
    if (dep.gpuEnclave) {
      gIn.max = String(Math.max(0, gpuFreePct));
      if (capG) capG.textContent = "· " + gpuFreePct + "% of a card free now (≈" + Math.round(gpuFree * cardGb) + " GB / " + Math.round(gpuFree * cardTf) + " TFLOPS)";
    } else {
      gIn.max = "0";
      if (capG) capG.textContent = "· GPU apps run on GPU enclaves";
      if (dep.gpuPct !== 0 && document.activeElement !== gIn){ dep.gpuPct = 0; gIn.value = "0"; }
    }
    if (cIn) cIn.max = String(Math.max(1, cpuFreePct));
    if (capC) capC.textContent = "· " + cpuFreePct + "% of the node free now (≈"
      + fmtNum(cpuFree * nodeRamGb) + " GB RAM / ≈" + fmtNum(cpuFree * ((a.nodeVcpus != null) ? a.nodeVcpus : NODE_VCPUS)) + " vCPU)";
    // clamp if the current pick now exceeds capacity, but don't yank the field the user is editing
    if (dep.gpuPct > gpuFreePct && dep.gpuEnclave && document.activeElement !== gIn){ dep.gpuPct = gpuFreePct; gIn.value = String(gpuFreePct); }
    if (cIn && dep.cpuPct > cpuFreePct && document.activeElement !== cIn){ dep.cpuPct = Math.max(1, cpuFreePct); cIn.value = String(dep.cpuPct); }
    renderDeploy();
  } catch(e){
    if (capG) capG.textContent = "· live capacity unavailable, showing whole-card max (100%)";
  }
}
// Per-enclave fleet view: the relay's /enclaves table, handed to the
// <c-fleet-list> and <c-volume-picker> components. Only the relay serves
// it - pointed directly at an enclave, both fields stay hidden.
async function refreshFleet(){
  const field = $("#fleetField"), volField = $("#volField");
  if (!field || !fleetList) return;
  try {
    const r = await fetch(Enclave.base.replace(/\/v1\/?$/, "") + "/enclaves", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("no fleet view");
    const j = await r.json();
    const rows = (j.enclaves || []).slice().sort((a, b) =>
      ((b.availability && b.availability.gpu) === true) - ((a.availability && a.availability.gpu) === true)
      || String(a.endpoint || "").localeCompare(String(b.endpoint || "")));
    fleetList.rows = rows;
    field.hidden = false;
    // Model volumes the fleet advertises (Modelwrap): union across enclaves,
    // each tagged with which enclaves carry it.
    const byName = new Map();
    for (const e of rows){
      for (const v of ((e.availability && e.availability.volumes) || [])){
        if (!v || !v.name) continue;
        const cur = byName.get(v.name) || { name: v.name, bytes: 0, onnx: false, count: 0 };
        cur.bytes = Math.max(cur.bytes, v.bytes || 0); cur.onnx = cur.onnx || !!v.onnx; cur.count++;
        byName.set(v.name, cur);
      }
    }
    const vols = [...byName.values()].sort((a,b) => a.name.localeCompare(b.name));
    if (volField) volField.hidden = !vols.length;
    if (volPicker){ volPicker.selected = dep.volumes; volPicker.volumes = vols; }
  } catch(e){ field.hidden = true; }
}
function startAvailPoll(){
  refreshAvailability(); refreshFleet();
  if (availPoll) return;
  // #deploy always exists on the apps page now — only poll while the deploy
  // view is actually visible (a reopened view is at most one tick stale)
  availPoll = setInterval(() => { const d = $("#deploy"); if (d && !d.hidden) { refreshAvailability(); refreshFleet(); } }, 20000);
}

/* ============================================================
   Wallet-dependent console chrome
   ============================================================ */
/* Privy (email) users hold only USDC bought by card - the ETH pay option is
   noise they can't use, and they can't see how much they can spend. Hide ETH
   and show a live USDC balance under the Pay-with control. */
function updatePayAssetUI(){
  const seg = $("#cfgAsset"); if (!seg) return;
  const privy = Enclave.walletRdns === PRIVY_RDNS;
  const ethBtn = seg.querySelector('button[data-asset="ETH"]');
  if (ethBtn) ethBtn.hidden = privy;
  if (privy && dep.asset === "ETH"){
    dep.asset = "USDC";
    $$("#cfgAsset button").forEach(x => x.classList.toggle("on", x.dataset.asset === "USDC"));
    renderDeploy();
  }
  updateUsdcBalance();
}
let _balSeq = 0;
async function updateUsdcBalance(){
  const el = $("#payBal"); if (!el) return;
  if (!Enclave.address || !Enclave.provider){ el.hidden = true; return; }
  const seq = ++_balSeq;
  try {
    // the card follows the selected pay asset: USDC by default, ETH when an
    // extension user flips the toggle
    const wantEth = (dep.asset === "ETH" && Enclave.walletRdns !== PRIVY_RDNS);
    const label = wantEth ? "ETH balance" : "USDC balance";
    const val = wantEth ? (await ethBalanceOf(Enclave.address)).toFixed(4) + " ETH"
                        : (await usdcBalanceOf(Enclave.address)).toFixed(2) + " USDC";
    if (seq !== _balSeq) return;
    const privy = Enclave.walletRdns === PRIVY_RDNS;
    el.innerHTML = '<div><span class="pb-k">' + label + '</span><span class="pb-v">' + esc(val) + '</span></div>' +
      (privy ? '<button class="pb-buy" id="payBuyMore" type="button">Buy more →</button>' : "");
    el.hidden = false;
    const bm = $("#payBuyMore"); if (bm) bm.onclick = () => openBuyModal();
  } catch(e){ if (seq === _balSeq) el.hidden = true; }
}

async function checkHealth(){
  const ind = $("#epState");
  if (ind){ ind.className = "ep-state"; ind.textContent = "checking…"; }
  try {
    await Enclave.health();
    if (ind){ ind.className = "ep-state ok"; ind.textContent = "reachable"; }
  } catch(e){
    if (ind){ ind.className = "ep-state down"; ind.textContent = "unreachable · set a live endpoint"; }
  }
}

/* ============================================================
   "Use in Deploy" handoff from the Apps page: apps.html stashes
   the picked version (sessionStorage + ?app= param) and lands
   here; a bare shared link with only ?app= resolves it from the
   on-chain catalog instead.
   ============================================================ */
function applyUseInDeploy(){
  const friendly = new URLSearchParams(location.search).get("app");
  if (!friendly) return;
  const inp = $("#cfgImage"); if (!inp) return;
  inp.value = friendly;
  let stash = null;
  try { stash = JSON.parse(sessionStorage.getItem("enclave_use_in_deploy") || "null"); } catch(e){}
  const applyMins = (mins, ports) => {
    dep.minGpuPct = mins.gpuPct; dep.minCpuPct = mins.cpuPct;
    dep.gpuPct = mins.gpuPct; dep.cpuPct = mins.cpuPct;
    const gi = $("#cfgGpuShare"); if (gi){ gi.min = String(mins.gpuPct); gi.value = String(mins.gpuPct); }
    const ci = $("#cfgCpuShare"); if (ci){ ci.min = String(mins.cpuPct); ci.value = String(mins.cpuPct); }
    const fp = $("#cfgPorts"); if (fp) fp.value = ports || "";
    renderDeploy();
    showToast("Deploy set to " + friendly + " (min " + mins.gpuPct + "% GPU / " + mins.cpuPct + "% CPU)"
            + (ports ? " · firewall " + ports : ""));
  };
  if (stash && stash.friendly === friendly && stash.cid){
    REF_CACHE[friendly] = "ipfs://" + stash.cid;
    PORTS_CACHE[friendly] = stash.ports || "";
    MINS_CACHE[friendly] = stash.mins;
    applyMins(stash.mins, stash.ports);
  } else {
    // shared / bookmarked link: resolve the ref from the catalog
    loadCatalog().then(() => {
      const r = resolveAppRef(friendly);
      if (r.mins) applyMins(r.mins, PORTS_CACHE[friendly]);
      else renderDeploy();
    }).catch(() => {});
  }
}

/* ============================================================
   boot
   ============================================================ */
function initDeploy(){
  if (!$("#deploy")) return;
  term = $("c-terminal");
  deps = $("c-deployments");
  fleetList = $("c-fleet-list");
  volPicker = $("c-volume-picker");

  $("#cfgGpuShare").addEventListener("input", e => { dep.gpuPct = parseFloat(e.target.value) || 0; renderDeploy(); });
  const cpuIn = $("#cfgCpuShare"); if (cpuIn) cpuIn.addEventListener("input", e => { dep.cpuPct = parseFloat(e.target.value) || 0; renderDeploy(); });
  $("#cfgAsset").addEventListener("click", e => {
    const b = e.target.closest("button[data-asset]"); if (!b) return;
    dep.asset = b.dataset.asset; $$("#cfgAsset button").forEach(x => x.classList.toggle("on", x === b));
    renderDeploy(); updateUsdcBalance();
  });
  $("#cfgAccess").addEventListener("click", e => {
    const b = e.target.closest("button[data-public]"); if (!b) return;
    dep.public = b.dataset.public === "1"; $$("#cfgAccess button").forEach(x => x.classList.toggle("on", x === b));
    renderAccessNote(); renderDeploy();
  });
  renderAccessNote();
  ["#cfgImage", "#cfgBudget", "#cfgPorts", "#cfgConfig"].forEach(s => { const el = $(s); if (el) el.addEventListener("input", renderDeploy); });
  if (volPicker) volPicker.addEventListener("change", renderDeploy);   // volume ticks change the request body
  $$(".console-tabs button").forEach(b => b.addEventListener("click", () => switchPane(b.dataset.pane)));
  $("#deployBtn").addEventListener("click", runDeploy);
  const frb = $("#fetchRunBtn"); if (frb) frb.addEventListener("click", runDeploy);   // the snippet IS the deploy flow
  $("#resetBtn").addEventListener("click", () => {
    $("#cfgImage").value = "";
    const fp0 = $("#cfgPorts"); if (fp0) fp0.value = "";
    const cc0 = $("#cfgConfig"); if (cc0) cc0.value = "";
    dep.volumes.clear();
    if (volPicker) volPicker.requestRender();
    $("#cfgBudget").value = "10";
    $("#cfgGpuShare").value = "25"; dep.gpuPct = 25;
    const cp0 = $("#cfgCpuShare"); if (cp0) cp0.value = "5"; dep.cpuPct = 5;
    dep.asset = "USDC"; dep.public = true;
    $$("#cfgAsset button").forEach(x => x.classList.toggle("on", x.dataset.asset === "USDC"));
    $$("#cfgAccess button").forEach(x => x.classList.toggle("on", x.dataset.public === "1"));
    renderAccessNote();
    term.clear();
    switchPane("req"); renderDeploy(); refreshAvailability();
  });

  // deploy console copy buttons (request body / fetch / curl panes)
  $$(".copybtn[data-copy]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.copy;
    const txt = k === "req"   ? $("#outReq").textContent
              : k === "fetch" ? $("#outFetch").textContent
              : k === "curl"  ? $("#outCurl").textContent : "";
    copyText(txt, b);
  }));

  // API endpoint field + health probe
  const ep = $("#apiBase");
  if (ep){
    ep.value = Enclave.base;
    ep.addEventListener("change", () => { Enclave.setBase(ep.value); ep.value = Enclave.base; renderDeploy(); checkHealth(); });
    ep.addEventListener("keydown", (e) => { if (e.key === "Enter") ep.blur(); });
  }

  renderDeploy();
  startAvailPoll();
  checkHealth();
  applyUseInDeploy();
}

// wallet/session signals from the shared chrome (<c-deployments> handles its
// own). Subscribed once at module load; every callee null-guards its elements,
// so it's inert while another page's <main> is mounted.
on("enclave:wallet", ({ authed }) => {
  const rh = $("#runHint");
  if (rh) rh.textContent = Enclave.address ? (authed ? "ready to deploy" : "click Deploy to sign in") : "sign in to deploy";
  updatePayAssetUI();
});

/* called by apps.js the first time the #deploy view opens on each <main>
   mount (the console is a hash-routed sub-page of Apps, not a router page) */
export function boot() {
  initDeploy();
}
