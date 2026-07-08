/* ============================================================
   Deploy page — the console form (two dials, request preview)
   and the on-chain create+fund flow. Validation and dry runs
   render inline; a REAL deploy soft-navigates to the dashboard
   and streams its narrative into its own run (js/core/runlog —
   <c-deployments>' live strips and row Output panels follow it;
   deploys are concurrent, so fleets stream side by side).
   <c-fleet-list> / <c-volume-picker> show live capacity.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/fleet-list/fleet-list.js";
import "../../components/volume-picker/volume-picker.js";
import { appLabel, appEndpoint } from "../../components/deployments/deployments.js";
import { runlog } from "../core/runlog.js";
import { payForRuntime } from "../core/fund.js";
import { navigate } from "../boot.js";
import { $, $$, esc, short, wait, fmtNum, fmtDur, hlJson, hlCode, copyText, showToast, statusCls, on } from "../core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS, IPFS_UPLOAD_URL, BASE_CHAIN, PRIVY_RDNS } from "../core/config.js";
import { Enclave, EnclaveError } from "../core/api.js";
import { CARD_GB, NODE_VCPUS, NODE_RAM_GB, CARD_TFLOPS, NODE_GFLOPS, shareRates } from "../core/pricing.js";
import { encCall, DEP_SEL, DEP_CREATED_TOPIC, APPROVAL, depGet, depRate6, depPrices6, rate6Of, waitReceipt } from "../core/chain.js";
import { authenticate, connectWallet, refreshWallet, ensureBaseChain, sendTx, usdcBalanceOf, ethBalanceOf, openBuyModal } from "../core/wallet.js";
import { STORE, loadCatalog, REF_CACHE, PORTS_CACHE, MINS_CACHE, CONFIG_CACHE, looksFriendly, resolveAppRef, validPortsCsv } from "../core/catalog.js";

/* component handles (assigned in initDeploy) */
let fleetList = null, volPicker = null;
let prices6 = null;   // the contract's live prices; estimates fall back to constants until read
/* the My Apps panel lives on the dashboard now; resolve it at call time
   (present after the deploy flow navigates there, absent otherwise) */
const depsPanel = () => document.querySelector("c-deployments");

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
/* The "App config" textarea: JSON the app receives as ENCLAVE_CONFIG. The
   console pins it to IPFS at deploy and passes the CID as create()'s
   configCid - users type config, never CIDs. Volumes picked in the volume
   picker merge into the same object (its `volumes` key). Returns
   { obj } (null = empty) or { err } (malformed / not a JSON object). */
function readCfgConfig(){
  const raw = ($("#cfgConfig") && $("#cfgConfig").value || "").trim();
  if (!raw) return { obj: null };
  try {
    const o = JSON.parse(raw);
    if (!o || Array.isArray(o) || typeof o !== "object") return { err: "app config must be a JSON object, e.g. {\"api_key\":\"…\"}" };
    return { obj: o };
  } catch(e){ return { err: "app config isn't valid JSON (" + e.message + ")" }; }
}
/* the typed config + picked volumes, merged the way deploy will pin it */
function mergedCfg(cfgObj, volNames){
  const merged = { ...(cfgObj || {}) };
  if (volNames && volNames.length){
    const own = Array.isArray(merged.volumes) ? merged.volumes : [];
    merged.volumes = [...new Set([...own, ...volNames])];
  }
  return merged;
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
  // app config + picked volumes: ONE JSON, pinned to IPFS at deploy - its CID
  // becomes the on-chain configCid, delivered to the app as ENCLAVE_CONFIG
  const cfg = readCfgConfig();
  if (cfg.err) body.config = "⚠ " + cfg.err;
  else {
    const merged = mergedCfg(cfg.obj, [...dep.volumes]);
    if (Object.keys(merged).length) body.config = merged;
  }
  body.region = "auto";
  return body;
}
function deployFetch(b){
  const r = (b.image && b.image.reference) || "ipfs://…";
  const g = Math.round(((b.resources && b.resources.gpuShare) || 0) * 1000);
  const c = Math.round(((b.resources && b.resources.cpuShare) || 0.05) * 1000);
  const fw = (b.firewall && b.firewall.ports || []).join(",");
  // the console pins the App config JSON to IPFS at deploy; by hand it's
  // `ipfs add config.json` (or POST /add-json) and the CID goes here
  const cc = b.config ? "<CID of your config JSON - ipfs add config.json>" : "";
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
    const g = shareRates(gpuPct, cpuPct);
    // money comes from the CONTRACT's prices + ceil math (cached read) —
    // client constants drift; the hardware figures below stay client-side
    rate = prices6 ? Number(rate6Of(prices6, g.gpuPct * 10, g.cpuPct * 10)) / 1e6 : g.rate;
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
/* pre-flight feedback (validation, dry runs) renders inline under the run
   row — the full output console lives on the dashboard, where a real deploy
   navigates before its first wallet step. lines: [cls, text][] */
function note(lines){
  const el = $("#deployNote"); if (!el) return;
  el.hidden = !lines.length;
  el.innerHTML = lines.map(l => '<span class="ln ' + l[0] + '">' + esc(l[1]) + '</span>').join("");
}

/* ---- real deploy: create -> pay -> provisioned, all from the browser ---- */
async function runDeploy(){
  const btn = $("#deployBtn"); if (btn.disabled) return;
  note([]);
  // resolve a friendly slug:version -> ipfs://<cid> (may need to read the catalog first)
  const raw = $("#cfgImage").value.trim();
  if (looksFriendly(raw) && !REF_CACHE[raw] && !STORE.loaded){
    note([["info", "[*] resolving " + raw + " from the catalog…"]]);
    try { await loadCatalog(); } catch(e){}
  }
  const rref = resolveAppRef(raw);
  if (rref.error) return note([["warn", "[!] " + rref.error]]);
  if (rref.pending) return note([["warn", "[!] couldn’t reach the catalog to resolve " + raw + " — deploys need the on-chain listing; try again in a moment."]]);
  const fwErr = validPortsCsv($("#cfgPorts") ? $("#cfgPorts").value : "");
  if (fwErr) return note([["warn", "[!] open ports: " + fwErr]]);
  // pre-flight the catalog gate BEFORE any wallet action: enclaves refuse
  // yanked / unapproved / unlisted versions deterministically, so paying for
  // one just parks USDC on an unclaimable deployment.
  try {
    if (!STORE.loaded){ try { await loadCatalog(); } catch(e){} }
    const cid = String(rref.reference || "").replace(/^ipfs:\/\//, "");
    let hit = null;
    for (const a of (STORE.apps || [])) for (const v of (a.versions || [])) if (v && v.cid === cid){ hit = { a, v }; }
    if (hit && hit.v.yanked)
      return note([["warn", "[!] " + hit.a.slug + ":" + hit.v.version + " is YANKED by its publisher - enclaves will never claim it."],
                   ["dimln", "    pick another version, or republish this CID as a new version (the catalog follows the newest listing), then deploy."]]);
    if (hit && hit.v.approval !== APPROVAL.approved)
      return note([["warn", "[!] " + hit.a.slug + ":" + hit.v.version + " is " + (hit.v.approval === APPROVAL.rejected ? "REJECTED" : "still PENDING approval") + " - enclaves only claim approved versions."]]);
    if (!hit && STORE.loaded && STORE.apps.length)
      return note([["warn", "[!] this CID isn't listed in the on-chain catalog - enclaves refuse unlisted apps. Publish it on the Apps page first."]]);
  } catch(e){}
  const fund = parseFloat($("#cfgBudget").value) || 0;
  const dry = $("#dryRun") && $("#dryRun").checked;

  // ---- ON-CHAIN deploy (EnclaveDeployments): the ledger, not any one enclave,
  // holds the spec and the funded balance, so the deployment survives enclave
  // updates and crashes - runners hold expiring leases and re-claim work.
  const gpuMilli = dep.gpuEnclave ? Math.round(Math.max(0, Math.min(100, dep.gpuPct))) * 10 : 0;
  const cpuMilli = Math.round(Math.max(1, Math.min(100, dep.cpuPct))) * 10;
  const ports = ($("#cfgPorts") && $("#cfgPorts").value || "");
  const { portsCsv, appPort } = portsSpec(ports);
  // the App config textarea: JSON only, refused loudly BEFORE any wallet step
  const cfg = readCfgConfig();
  if (cfg.err) return note([["warn", "[!] " + cfg.err]]);
  const volNames = [...dep.volumes];
  const cfgObj = mergedCfg(cfg.obj, volNames);
  const hasCfg = Object.keys(cfgObj).length > 0;

  if (dry){
    const plan = [["warn", "// dry run: nothing is sent"]];
    if (hasCfg) plan.push(["info", "0) app config " + JSON.stringify(cfgObj) + " -> the console pins it to IPFS and passes its CID as configCid"]);
    plan.push(["p", "1) EnclaveDeployments.create(app, shares, ports) - one wallet tx; you own the record"],
      ["dimln", "   create(\"" + rref.reference + "\", " + gpuMilli + ", " + cpuMilli + ", " + appPort + ", \"" + portsCsv + "\", " + dep.public + ", \"\", \"" + (hasCfg ? "<pinned config CID>" : "") + "\")"],
      ["p", dep.asset === "ETH"
        ? "2) fundEth(id) with ≈ $" + fund + " of ETH - one wallet tx; credited on-chain"
        : "2) sign a " + fund + " USDC authorization (EIP-3009) + one fundWithAuthorization(id) tx - credited on-chain"],
      ["p", "3) POST /v1/claim-hint - an enclave claims the work and serves it"],
      ["dimln", "   the balance and spec live on Base: any enclave can take over if the runner dies"],
      ["info", "uncheck “Dry run” to deploy for real"]);
    return note(plan);
  }

  btn.disabled = true; const lbl = btn.textContent; btn.textContent = "working…";
  try {
    await deployOnChain({ reference: rref.reference, gpuMilli, cpuMilli, ports,
      isPublic: dep.public, config: cfg.obj, volumes: volNames, fundUsd: fund, asset: dep.asset });
  } finally {
    btn.disabled = false; btn.textContent = lbl;
  }
}

/* logical "open ports" csv -> the create() call's portsCsv + appPort */
function portsSpec(raw){
  const fwCsv = String(raw || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const portsCsv = (fwCsv.length && !(fwCsv.length === 1 && fwCsv[0] === "http")) ? fwCsv.join(",") : "";
  const httpEntry = fwCsv.find(x => /^http:\d+$/.test(x));
  return { portsCsv, appPort: httpEntry ? parseInt(httpEntry.split(":")[1], 10) : 8080 };
}

/* The on-chain deploy flow, shared by the console form above and the store's
   quick-deploy modal (apps.js imports this): soft-navigate to the dashboard,
   then create -> fund -> claim-hint -> watch, narrating into ITS OWN run
   (concurrent-safe: every call gets its own runlog writer, so a fleet of
   deploys stream side by side). Resolves once funding lands - the claim/
   status watch continues detached, freeing the caller for the next deploy.
   spec: { reference, gpuMilli, cpuMilli, ports (csv), isPublic,
   config (JSON object - pinned to IPFS here, volumes merge in) OR
   configCid (a pre-pinned CID, programmatic callers), volumes, fundUsd,
   asset } */
export async function deployOnChain(spec){
  const fund = spec.fundUsd;
  const volNames = spec.volumes || [];
  let configCid = spec.configCid || "";
  const { portsCsv, appPort } = portsSpec(spec.ports);
  const asset = spec.asset || "USDC";
  let w = null, detached = false;
  try {
    // the run log lives on the dashboard: get there BEFORE the first wallet
    // step so the whole narrative streams where the user is looking (the
    // document never unloads — this async flow survives the soft navigation)
    await navigate("dashboard.html");
    w = runlog.startRun();
    if (!Enclave.token){
      w.line("info", "[*] connecting wallet + signing in (SIWE)…");
      await authenticate();
      w.line("ok", "[✓] signed in as " + short(Enclave.address));
    }
    // a restored session has a token but NO provider - reconnect before any tx
    if (!Enclave.provider){
      w.line("info", "[*] reconnecting wallet…");
      await connectWallet();
      w.line("ok", "[✓] wallet " + short(Enclave.address));
    }
    w.line("dimln", "    if nothing happens, check your wallet - a popup may be waiting (or queued behind an old one; open the wallet and clear pending requests)");
    await ensureBaseChain();

    // rate estimate straight from the contract (same ceil math as create) -
    // best-effort with a hard cap so a slow RPC can never stall the deploy
    let rate6 = 0n;
    try { rate6 = await Promise.race([depRate6(spec.gpuMilli, spec.cpuMilli), wait(6000).then(() => 0n)]); } catch(e){}
    if (rate6 > 0n){
      const rate = Number(rate6) / 1e6;
      w.line("info", "    " + fund + " USDC ≈ " + fmtDur(fund / rate) + " of runtime at $" + (rate * 3600).toFixed(2) + "/hr");
    }

    // 0) app config: the typed JSON + picked volumes merge into ONE object,
    // pinned to IPFS here - its CID rides create() and the enclave verifies
    // the bytes before handing them to the app as ENCLAVE_CONFIG. A
    // pre-pinned spec.configCid (programmatic callers) passes through when
    // there's nothing to pin; typed config wins if both arrive (a CID is
    // opaque - it can't be merged client-side).
    const cfgObj = mergedCfg(spec.config, volNames);
    if (Object.keys(cfgObj).length){
      w.line("p", "$ pin app config  (JSON -> IPFS -> configCid)");
      if (configCid) w.line("warn", "    (a pre-pinned config CID was also passed - the config object wins; pin the merge yourself to combine)");
      const jsonUrl = (IPFS_UPLOAD_URL || "").replace(/\/add-wasm$/, "/add-json");
      if (!jsonUrl) throw new EnclaveError("app config needs the upload gateway; not configured here. Pin the JSON yourself (ipfs add config.json) and deploy with its CID via the API or CLI (--config-cid).", 0);
      const pr = await fetch(jsonUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfgObj) });
      const pj = await pr.json().catch(() => ({}));
      if (!pr.ok || !pj.cid) throw new EnclaveError("config pin failed: " + (pj.error || ("HTTP " + pr.status)), 0);
      configCid = pj.cid;
      const vols = Array.isArray(cfgObj.volumes) ? cfgObj.volumes : [];
      w.line("ok", "[✓] config pinned " + configCid + (vols.length ? "  (mounts: " + vols.join(", ") + " -> /models/…)" : ""));
    }

    // 1) create: one tx from YOUR wallet - msg.sender owns the on-chain record
    w.line("p", "$ EnclaveDeployments.create(…)  (wallet · one tx · you own the record)");
    w.line("info", "[*] confirm the create transaction in your wallet…");
    const cdata = encCall(DEP_SEL.create, [
      { t: "str", v: spec.reference }, { t: "uint", v: spec.gpuMilli }, { t: "uint", v: spec.cpuMilli },
      { t: "uint", v: appPort }, { t: "str", v: portsCsv }, { t: "bool", v: !!spec.isPublic },
      { t: "str", v: "" }, { t: "str", v: configCid },
    ]);
    const chash = await sendTx(DEPLOYMENTS_ADDRESS, cdata);
    w.line("dimln", "  ↳ sent " + chash + " · waiting for confirmation…");
    const rcpt = await waitReceipt(chash);
    const clog = (rcpt.logs || []).find(l => (l.topics || [])[0] === DEP_CREATED_TOPIC
      && (l.address || "").toLowerCase() === DEPLOYMENTS_ADDRESS.toLowerCase());
    if (!clog) throw new EnclaveError("create() confirmed but no Created event found in the receipt", 0);
    const id = clog.topics[1];
    w.setId(id);   // name the run explicitly: bytes32 ids read exactly like the tx hashes already in the log
    w.line("ok", "[✓] created " + id);

    // 2) fund: the credit lands in the deployment's on-chain balance
    let pricing = null;
    try { pricing = await (await fetch(Enclave.base + "/pricing", { signal: AbortSignal.timeout(8000) })).json(); } catch(e){}
    try {
      await payForRuntime({
        contract: DEPLOYMENTS_ADDRESS, deploymentRef: id,
        usdcDomain: pricing && pricing.usdcDomain, usdc: (pricing && pricing.usdc) || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ethUsd: pricing && pricing.ethUsd,
      }, fund, asset, w.line);
    } catch(e){
      const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
      w.line("warn", rejected ? "[x] funding rejected in wallet." : "[x] funding failed: " + (e.message || e));
      w.line("dimln", "    " + id + " exists on-chain but is unfunded (inert, costs nothing). Fund it any time - it starts once it has balance.");
      return;
    }

    // 3+4) nudge the fleet, then watch the claim and the runner's status -
    // DETACHED: deployOnChain resolves here (the wallet work is done), so the
    // caller frees for the NEXT deploy of a fleet while this run's writer
    // keeps streaming into its own strip / row panel
    watchClaimAndRun(id, null, w)
      .catch(e => w.line("warn", "[x] " + (e.message || String(e))))
      .finally(() => { w.end(); refreshWallet(); });
    detached = true;
  } catch(e){
    if (w) w.line("warn", "[x] " + (e.message || String(e)));
    if (w && e.status === 0) w.line("dimln", "    set a reachable API endpoint on the deploy console, then retry.");
  } finally {
    if (!detached && w) w.end();
    refreshWallet();
  }
}

/* Steps 3+4 of every deploy story - shared by the live flow above and a
   resumed watch (resumeDeployWatch): nudge the fleet, watch the ledger for a
   lease, follow the runner to "running", and land the row in the My Apps
   panel. `dPre` (a fresh depGet) skips the claim wait when the ledger already
   shows a live lease; `w` is the run's bound writer (its dead() aborts us if
   the run is ended from outside). */
async function watchClaimAndRun(id, dPre, w){
  const leased = (d) => d && d.runner && !/^0x0+$/.test(d.runner) && d.leaseUntil * 1000 > Date.now();
  let claimed = leased(dPre) ? dPre : null;
  if (!claimed){
    // nudge the fleet - otherwise the next sweep (<=60s) picks it up
    w.line("info", "[*] hinting enclaves to claim…");
    try {
      const h = await (await fetch(Enclave.base + "/claim-hint", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })).json();
      if (h && h.accepted === false && h.reason) w.line("dimln", "    hint declined: " + h.reason + " (the sweep may still claim it)");
    } catch(e){ w.line("dimln", "    hint failed (" + (e.message || e) + "); the sweep claims funded work within ~1 min"); }

    let lastReason = "";
    for (let i = 0; i < 90 && !claimed; i++){
      if (w.dead && w.dead()) return;
      await wait(2000);
      let d = null; try { d = await depGet(id); } catch(e){}
      if (leased(d)) claimed = d;
      else if (i === 1) w.line("info", "[*] waiting for an enclave to claim (the lease appears on-chain)…");
      else if (i > 1 && i % 15 === 0){
        // don't wait in silence: ask the fleet WHY it isn't claiming
        try {
          const h = await (await fetch(Enclave.base + "/claim-hint", { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })).json();
          if (h && h.accepted === false && h.reason && h.reason !== lastReason){
            lastReason = h.reason;
            w.line("warn", "[!] fleet declines to claim: " + h.reason);
            if (/yanked|not.approved|rejected|delisted|unlisted|below|minimum/i.test(h.reason)){
              w.line("dimln", "    this won't resolve by waiting - fix the app version in the catalog. The deployment stays funded and is claimed automatically once deployable.");
              break;
            }
          }
        } catch(e){}
      }
    }
    if (!claimed){
      w.line("warn", "[!] no enclave has claimed yet - the deployment stays on the queue (funded work is claimed as capacity frees up). It appears below the moment one does.");
      const dp0 = depsPanel(); if (dp0) dp0.refresh(); return;
    }
  }
  w.line("ok", "[✓] claimed by enclave operator " + short(claimed.runnerOperator) + " · lease until " + new Date(claimed.leaseUntil * 1000).toLocaleTimeString());
  const label = appLabel(id);
  w.line("dimln", "    app origin: https://" + label + "." + APP_DOMAIN + "  (first request may take a moment: the enclave fetches + verifies your wasm from IPFS)");
  if (!Enclave.authed()){
    // a resumed watch can outlive the session: the claim is on-chain (shown
    // above), but the runner's live status comes from the authed API
    w.line("dimln", "    sign in above to follow the runner's live status; the panel below fills in once you do.");
    const dp1 = depsPanel(); if (dp1) dp1.refresh(); return;
  }
  const final = await pollDeployment(id, w);
  const dp = depsPanel(); if (dp) dp.refresh({ highlight: (final && final.id) || id });
}
async function pollDeployment(id, w){
  const done = { running: 1, failed: 1, stopped: 1, error: 1 };
  let last = null, d = null;
  for (let i = 0; i < 180; i++){
    if (w.dead && w.dead()) return d;
    try { d = await Enclave.getDeployment(id); }
    catch(e){ w.line("dimln", "  … " + e.message); await wait(2500); continue; }
    if (d.status !== last){ last = d.status; w.line(statusCls(d.status), "  • " + d.status); }
    if (done[d.status]){
      if (d.status === "running"){
        const ep = appEndpoint(d);
        w.line("ok", "[✓] running" + (ep ? " · " + ep : ""));
        if (d.ratePerSecondUsdc) w.line("dimln", "    rate " + d.ratePerSecondUsdc + " USDC/s · " + (d.timeRemainingSec != null ? fmtDur(d.timeRemainingSec) + " funded" : "funded"));
        w.line("warn", "→ verify the attestation before sending data");
      } else {
        w.line("warn", "  ‹ ended: " + d.status + (d.error ? " · " + d.error : "") + " ›");
      }
      return d;
    }
    await wait(2500);
  }
  w.line("dimln", "  (still provisioning; track it in the panel below)");
  return d;
}

/* Resume the WATCH half of a deploy that a page unload cut off (a refresh
   mid-deploy): the async flow died with the old document, but the ledger
   didn't. Recover the deployment id - the run record's, or the create tx's
   receipt when the reload beat the "created" line - re-read the on-chain
   state, and keep narrating into the SAME recorded run. Reads only: no
   wallet step ever re-runs here. The dashboard's <c-deployments> calls this
   when it mounts and finds an interrupted run. */
export async function resumeDeployWatch(run){
  const w = runlog.resume(run);
  if (!w) return;                                       // something is already writing this run
  try {
    w.line("dimln", "// resumed after a reload - re-reading the ledger (nothing is re-sent or re-signed)");
    let id = /^0x[0-9a-f]{64}$/i.test(run.id || "") ? run.id.toLowerCase() : null;
    let d = null;
    if (id){ try { d = await depGet(id); } catch(e){} }
    if (!d){
      // no readable record under run.id: the reload may have hit before the
      // "created" line (no id recorded), or an older log stored the create TX
      // HASH as the id (bytes32 ids and tx hashes look identical). Either
      // way, the create tx's receipt names the real id.
      const sent = [...run.lines].reverse().map(l => /↳ sent (0x[0-9a-f]{64})/i.exec(l[1])).find(Boolean);
      const tx = (sent && sent[1]) || id;
      id = null;
      if (tx){
        try {
          const rcpt = await waitReceipt(tx, 5);
          const clog = (rcpt.logs || []).find(l => (l.topics || [])[0] === DEP_CREATED_TOPIC
            && (l.address || "").toLowerCase() === DEPLOYMENTS_ADDRESS.toLowerCase());
          if (clog) id = clog.topics[1];
        } catch(e){}
      }
      if (id){ try { d = await depGet(id); } catch(e){} }
    }
    if (!id){
      w.line("warn", "[!] this run was cut off before a create transaction confirmed - nothing reached the ledger. If your wallet shows a sent create(), refresh here in a minute; otherwise just deploy again (nothing was paid).");
      return;
    }
    w.setId(id);
    if (!d){
      w.line("warn", "[x] couldn't read " + id + " from the ledger right now - refresh in a moment.");
      return;
    }
    if (!d.active){
      w.line("warn", "  ‹ this deployment is stopped on the ledger (setActive(false) / terminated) ›");
      return;
    }
    if (!(d.balance6 > 0 || d.spent6 > 0)){
      w.line("warn", "[!] created, but no funding has landed on-chain - the reload likely hit before (or during) the funding step.");
      w.line("dimln", "    " + id + " sits inert (costs nothing). Fund it any time - enclaves claim it the moment it has balance.");
      return;
    }
    await watchClaimAndRun(id, d, w);
  } catch(e){
    w.line("warn", "[x] " + (e.message || String(e)));
  } finally {
    w.end();
  }
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
        const cur = byName.get(v.name) || { name: v.name, bytes: 0, onnx: false, gguf: false, count: 0 };
        cur.bytes = Math.max(cur.bytes, v.bytes || 0); cur.onnx = cur.onnx || !!v.onnx; cur.gguf = cur.gguf || !!v.gguf; cur.count++;
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
  const applyMins = (mins, ports, config) => {
    dep.minGpuPct = mins.gpuPct; dep.minCpuPct = mins.cpuPct;
    dep.gpuPct = mins.gpuPct; dep.cpuPct = mins.cpuPct;
    const gi = $("#cfgGpuShare"); if (gi){ gi.min = String(mins.gpuPct); gi.value = String(mins.gpuPct); }
    const ci = $("#cfgCpuShare"); if (ci){ ci.min = String(mins.cpuPct); ci.value = String(mins.cpuPct); }
    const fp = $("#cfgPorts"); if (fp) fp.value = ports || "";
    // the app's default config template pre-fills the App config box
    // (pretty-printed when it parses); the deployer edits, deploy pins the result
    if (config){
      const ta = $("#cfgConfig");
      if (ta){ try { ta.value = JSON.stringify(JSON.parse(config), null, 2); } catch(e){ ta.value = config; } }
    }
    renderDeploy();
    showToast("Deploy set to " + friendly + " (min " + mins.gpuPct + "% GPU / " + mins.cpuPct + "% CPU)"
            + (ports ? " · open ports " + ports : "") + (config ? " · config template applied" : ""));
  };
  if (stash && stash.friendly === friendly && stash.cid){
    REF_CACHE[friendly] = "ipfs://" + stash.cid;
    PORTS_CACHE[friendly] = stash.ports || "";
    MINS_CACHE[friendly] = stash.mins;
    CONFIG_CACHE[friendly] = stash.config || "";
    applyMins(stash.mins, stash.ports, stash.config);
  } else {
    // shared / bookmarked link: resolve the ref from the catalog
    loadCatalog().then(() => {
      const r = resolveAppRef(friendly);
      if (r.mins) applyMins(r.mins, PORTS_CACHE[friendly], CONFIG_CACHE[friendly]);
      else renderDeploy();
    }).catch(() => {});
  }
}

/* ============================================================
   boot
   ============================================================ */
function initDeploy(){
  if (!$("#deploy")) return;
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
    note([]);
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
  depPrices6().then(p => { prices6 = p; renderDeploy(); }).catch(() => {});
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
