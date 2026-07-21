/* ============================================================
   Deploy page - the console form (two dials, request preview)
   and the on-chain create+fund flow. Validation and dry runs
   render inline; a REAL deploy soft-navigates to the dashboard
   and streams its narrative into its own run (js/core/runlog - 
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
import { $, $$, esc, short, wait, fmtNum, fmtDur, hlJson, hlCode, copyText, showToast, statusCls, on, tosAccepted, setTosAccepted } from "../core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS, BASE_CHAIN, ACCOUNTS_ENABLED } from "../core/config.js";
import { Enclave, EnclaveError } from "../core/api.js";
import { minPctsOf, serverSpec, shareRates } from "../core/pricing.js";
import { encCall, DEP_SEL, DEP_CREATED_TOPIC, APPROVAL, depGet, depRate6, depPrices6, depSchemaRev, depMaxGpuMilli, rate6Of, waitReceipt, catVersionFee } from "../core/chain.js";

// create()'s shape on the live contract (rev 1 carried a removed sshPubKey
// string): sniffed once at init; the samples and the real encode both use it.
let depRev = 2;
import { connectWallet, refreshWallet, ensureBaseChain, sendTx, usdcBalanceOf, ethBalanceOf } from "../core/wallet.js";
import { STORE, loadCatalog, REF_CACHE, PORTS_CACHE, SPECS_CACHE, CONFIG_CACHE, looksFriendly, resolveAppRef, catalogRef, parseCatalogRef, publisherOfRef } from "../core/catalog.js";

/* component handles (assigned in initDeploy) */
let fleetList = null, volPicker = null;
let prices6 = null;   // the contract's live prices; estimates fall back to constants until read
/* the My Apps panel lives on the dashboard now; resolve it at call time
   (present after the deploy flow navigates there, absent otherwise) */
const depsPanel = () => document.querySelector("c-deployments");

/* ============================================================
   Console state + request rendering
   ============================================================ */
const dep = { gpuPct: 25, cpuPct: 5, minGpuPct: 0, minCpuPct: 1, asset: "USDC", public: true, gpuEnclave: true, volumes: new Set(), waf: false, wafAvail: false };  // gpuEnclave: from /availability (gpu:false = CPU-only enclave); volumes: the picker's ticks - a MIRROR of the App config JSON's `volumes` key, never a second source; wafAvail: fleet aggregate advertises the options envelope (waf:true = every live runner enforces it - the Protection field only shows then)

/* The Protection controls -> the create() options envelope's `waf` object
   (null = off/unavailable). Mirrors the runner's parse rules (supervisor
   parseDepOptions): rps + burst always ride together, maxBodyMb and the
   scanner preset only when set - so what the user sees here is exactly what
   the claim gate will accept. */
function wafSpec(){
  if (!dep.waf || !dep.wafAvail) return null;
  const num = (sel, min, max, dflt) => {
    const v = parseFloat(($(sel) && $(sel).value) || "");
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
  };
  const w = { rps: num("#wafRps", 0.1, 10000, 10) };
  w.burst = Math.round(num("#wafBurst", 1, 100000, Math.max(5, Math.ceil(w.rps * 4))));
  const body = num("#wafBody", 0.001, 1024, 0);
  if (body > 0) w.maxBodyMb = body;
  if ($("#wafScan") && $("#wafScan").checked) w.blockScanners = true;
  return w;
}
function renderAccessNote(){
  const el = $("#accessNote"); if (!el) return;
  el.innerHTML = dep.public
    ? "anyone can reach the app endpoint, for websites, APIs, servers; management stays owner-only."
    : "only your wallet (SIWE token) can reach the app, for private/confidential jobs.";
}

// The selected app's minimum shares for the two dials. Friendly slug:version
// refs resolve to their catalog specs; raw CIDs we can't see specs for get
// the open floor (0% GPU / 1% CPU) - the enclave still enforces the real
// minimums server-side.
function currentMins(){
  const input = ($("#cfgImage") ? $("#cfgImage").value : "").trim();
  const spec = SPECS_CACHE[input];
  return spec ? minPctsOf(spec) : { gpuPct: 0, cpuPct: 1 };   // computed NOW, against the adopted fleet hardware
}
/* The "App config" box shows the picked VERSION's config - the JSON the app
   receives as ENCLAVE_CONFIG, straight from the on-chain record the owner
   approved. Read-only: it rides the version, not the deployment (its
   `volumes` key names the model volumes to mount; the picker mirrors it).
   Returns { obj } (null = empty) or { err } (malformed record). */
function readCfgConfig(){
  const raw = ($("#cfgConfig") && $("#cfgConfig").value || "").trim();
  if (!raw) return { obj: null };
  try {
    const o = JSON.parse(raw);
    if (!o || Array.isArray(o) || typeof o !== "object") return { err: "app config must be a JSON object, e.g. {\"api_key\":\"…\"}" };
    return { obj: o };
  } catch(e){ return { err: "app config isn't valid JSON (" + e.message + ")" }; }
}
let lastVols = [];   // the volumes of the picked version's config (the ticks mirror these)
/* textarea -> picker: the ticks mirror the config JSON's `volumes` key
   (typed edits, applied templates, reset). Invalid JSON keeps the last
   agreed ticks - there's nothing readable to mirror yet. */
function syncVolsFromCfg(){
  const cfg = readCfgConfig();
  if (cfg.err) return;
  const names = (cfg.obj && Array.isArray(cfg.obj.volumes)) ? [...new Set(cfg.obj.volumes.map(String))] : [];
  lastVols = names;
  if (names.length === dep.volumes.size && names.every(n => dep.volumes.has(n))) return;
  dep.volumes.clear(); names.forEach(n => dep.volumes.add(n));
  if (volPicker) volPicker.requestRender();
}
function deployBody(){
  // `image.reference` is the app to run: a catalog slug:version resolved to
  // its catalog://<appId>/<idx> RECORD by resolveAppRef(). The record carries
  // everything approval covered (wasm CID, config, ports); CIDs are refused.
  const body = { image: { reference: resolveAppRef($("#cfgImage").value).reference } };
  body.public = dep.public;   // public endpoint (anyone) vs private (owner token only)
  const gp = dep.gpuEnclave ? Math.min(1, Math.max(0, Math.round(dep.gpuPct) / 100)) : 0;
  const cp = Math.min(1, Math.max(0.01, Math.round(dep.cpuPct) / 100));
  body.resources = { gpuShare: gp, cpuShare: cp };   // the two dials; the app's specs set the minimums
  // GPU attestation only exists when the deployment holds a card slice.
  if (gp > 0 && dep.gpuEnclave) body.attestationPolicy = { requireGpuAttestation: true };
  body.region = "auto";
  const w = wafSpec();
  if (w) body.waf = w;   // deployer protection: rides create()'s options envelope, enforced at the enclave's /x proxy
  return body;
}
function deployFetch(b){
  const r = (b.image && b.image.reference) || "catalog://<appId>/<versionIndex>";
  const g = Math.round(((b.resources && b.resources.gpuShare) || 0) * 1000);
  const c = Math.round(((b.resources && b.resources.cpuShare) || 0.05) * 1000);
  const env = b.waf ? JSON.stringify(JSON.stringify({ waf: b.waf })) : '""';   // the options envelope, as a JS string literal
  return '// Deployments are ON-CHAIN work items (EnclaveDeployments on Base): the ledger\n'
    + '// holds the spec + funded balance, so they survive enclave updates and crashes.\n'
    + '// 1) create() from your wallet - one tx; msg.sender owns the record:\n'
    + '//    create(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, ' + (depRev >= 2 ? "" : "sshPubKey, ") + 'configCid)\n'
    + '//    appRef names the on-chain catalog VERSION record - it carries the wasm,\n'
    + '//    config (ENCLAVE_CONFIG + volumes) and ports the owner approved; CID refs\n'
    + '//    are refused and ports/appPort ride along untrusted. The last field carries\n'
    + '//    "" or a deployment-options envelope like {"waf":{…}} (per-IP rate limit +\n'
    + '//    request filter, enforced by the enclave before traffic reaches the app).\n'
    + 'const { id } = await createOnChain("' + DEPLOYMENTS_ADDRESS + '",\n'
    + '  ["' + r + '", ' + g + ', ' + c + ', 8080, "", ' + !!b.public + ', ' + (depRev >= 2 ? env : '"", ' + env) + ']);\n'
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
/* A paid app's per-second publisher fee (USDC 6dp), keyed by the resolved
   catalog:// reference. create() adds the fee ON TOP of the platform rate, so
   every $/hr readout here must add it too. Filled asynchronously (fees live
   outside the Version tuple); renderDeploy repaints when a fee lands. Numbers
   for display math only - deployOnChain re-reads the exact BigInt right
   before the signature. */
const FEE6_CACHE = {};
function currentFee6(){
  const raw = ($("#cfgImage") && $("#cfgImage").value || "").trim();
  const ref = REF_CACHE[raw], cr = ref && parseCatalogRef(ref);
  if (!cr) return 0;
  if (FEE6_CACHE[ref] != null) return FEE6_CACHE[ref];
  FEE6_CACHE[ref] = 0;   // placeholder: one fetch per record, repaint on arrival
  catVersionFee(cr.appId, cr.index)
    .then(f => { if (f > 0n){ FEE6_CACHE[ref] = Number(f); renderDeploy(); } })
    .catch(() => { delete FEE6_CACHE[ref]; });
  return 0;
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
    const s = serverSpec();
    rate = 0; readout = "✕ this app needs at least a " + mins.gpuPct + "% GPU share (its specs: that much VRAM/compute on the fleet's " + s.cardVramGb + " GB / " + s.cardTflops + " TFLOPS card)";
  }
  else if (cpuPct < mins.cpuPct) {
    const s = serverSpec();
    rate = 0; readout = "✕ this app needs at least a " + mins.cpuPct + "% CPU share (its specs: that much RAM/compute on the fleet's " + s.nodeRamGb + " GB / " + s.nodeGflops + " GFLOPS node)";
  }
  else if (gpuPct > 0 && Math.round(cpuPct) > Math.round(gpuPct)) {
    rate = 0; readout = "✕ CPU share (" + Math.round(cpuPct) + "%) can't exceed GPU share (" + Math.round(gpuPct) + "%) - a GPU app's CPU slice rides on its card's node";
  }
  else {
    const g = shareRates(gpuPct, cpuPct);
    // money comes from the CONTRACT's prices + ceil math (cached read) -
    // client constants drift; the hardware figures below stay client-side.
    // A paid app's publisher fee rides on top, exactly as create() adds it.
    const fee = currentFee6() / 1e6;
    rate = (prices6 ? Number(rate6Of(prices6, g.gpuPct * 10, g.cpuPct * 10)) / 1e6 : g.rate) + fee;
    readout = (g.gpuPct > 0
      ? "→ " + g.gpuPct + "% of card ≈ " + g.vramGb.toFixed(0) + " GB VRAM / " + Math.round(g.tflops) + " TFLOPS · "
      : "→ CPU-only · ")
      + g.cpuPct + "% of node ≈ " + fmtNum(g.ramGb) + " GB RAM / " + fmtNum(g.vcpus) + " vCPU / " + Math.round(g.gflops) + " GFLOPS · $"
      + (rate * 3600).toFixed(2) + "/hr"
      + (fee > 0 ? " (incl. $" + (fee * 3600).toFixed(2) + "/hr to the app's publisher)" : "");
  }
  const t = $("#tierOut"); if (t) t.textContent = readout;
  // capacity is a WAIT, not an error: a pick above what's free right now is
  // still worth creating (it queues on-chain; queued demand is also what the
  // fleet scales on) - but say so clearly before any wallet step
  const capW = $("#capWarn");
  if (capW){
    const q = rate > 0 ? queuedVerdict(gpuPct, cpuPct) : null;
    capW.hidden = !q;
    if (q) capW.textContent = "⚠ this size isn't free right now ("
      + (gpuPct > 0 ? freePct.gpu + "% of a card · " + q.cpuFreeHere + "% of its node free" : freePct.cpuAny + "% of the node free")
      + ") - you can still deploy: the app is created on-chain, waits as Queued, and starts automatically the moment capacity frees up. Queued time is never billed; the balance only burns while the app runs.";
  }
  $("#estRuntime").textContent = rate > 0 ? fmtDur(budget / rate) : "–";
}
// seg toggles are aria-pressed buttons: keep the state attribute in step with .on
const segSet = (x, on) => { x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); };
function switchPane(name, focus){
  $$(".console-tabs button").forEach(b => {
    const on = b.dataset.pane === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  $$(".console-body .pane").forEach(p => p.classList.toggle("on", p.dataset.pane === name));
}
/* pre-flight feedback (validation, dry runs) renders inline under the run
   row - the full output console lives on the dashboard, where a real deploy
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
  // resolve a friendly slug:version -> its catalog://<appId>/<idx> record (may need the catalog first)
  const raw = $("#cfgImage").value.trim();
  if (looksFriendly(raw) && !REF_CACHE[raw] && !STORE.loaded){
    note([["info", "[*] resolving " + raw + " from the catalog…"]]);
    try { await loadCatalog(); } catch(e){}
  }
  const rref = resolveAppRef(raw);
  // resolveAppRef IS the pre-flight: it refuses unknown apps, yanked and
  // unapproved versions (and CID input) with the same rules the enclave's
  // claim gate applies to the catalog record - nothing else to re-scan.
  if (rref.error) return note([["warn", "[!] " + rref.error]]);
  if (rref.pending) return note([["warn", "[!] couldn’t reach the catalog to resolve " + raw + " - deploys need the on-chain listing; try again in a moment."]]);
  const fund = parseFloat($("#cfgBudget").value) || 0;
  const dry = $("#dryRun") && $("#dryRun").checked;

  // ---- ON-CHAIN deploy (EnclaveDeployments): the ledger, not any one enclave,
  // holds the spec and the funded balance, so the deployment survives enclave
  // updates and crashes - runners hold expiring leases and re-claim work.
  const gpuMilli = dep.gpuEnclave ? Math.round(Math.max(0, Math.min(100, dep.gpuPct))) * 10 : 0;
  const cpuMilli = Math.round(Math.max(1, Math.min(100, dep.cpuPct))) * 10;
  const ports = ($("#cfgPorts") && $("#cfgPorts").value || "");
  const { portsCsv, appPort } = portsSpec(ports);

  // HARD floor, the last line before a wallet signature: runners divide the
  // app's specs by their probed hardware and refuse anything below the result,
  // and a created record's shares are IMMUTABLE - an under-provisioned
  // deployment sits "Queued" forever, claimable by nobody, its funding
  // unrecoverable. The dial UI enforces the same floor; this catches every
  // other path here (stale prefill, races, hand-edited fields).
  const fmins = SPECS_CACHE[raw] ? minPctsOf(SPECS_CACHE[raw]) : null;
  if (fmins && fmins.gpuPct > 0 && gpuMilli < fmins.gpuPct * 10)
    return note([["warn", !dep.gpuEnclave
      ? "[!] " + raw + " needs a GPU (min " + fmins.gpuPct + "% of a card) and the fleet has no GPU enclave live - this deployment would never be claimed."
      : "[!] " + raw + " needs at least a " + fmins.gpuPct + "% GPU share on this fleet's hardware - " + (gpuMilli / 10) + "% would never be claimed. Raise the GPU dial."]]);
  if (fmins && cpuMilli < fmins.cpuPct * 10)
    return note([["warn", "[!] " + raw + " needs at least a " + fmins.cpuPct + "% CPU share on this fleet's hardware - " + (cpuMilli / 10) + "% would never be claimed. Raise the CPU dial."]]);

  // HARD ceiling, the floors' mirror: create() refuses gpuMilli above the
  // operator-set on-chain cap (pre-cap contracts read as 1000 = uncapped).
  // Publishing an app whose specs exceed the cap stays legal - only DEPLOYS
  // are gated - so say which of the two the user actually hit.
  const capMsg = await gpuCapRefusal(gpuMilli, fmins ? fmins.gpuPct : null);
  if (capMsg) return note([["warn", "[!] " + capMsg]]);

  if (dry){
    const wafDry = wafSpec();
    const envDry = wafDry ? JSON.stringify(JSON.stringify({ waf: wafDry })) : "\"\"";
    const plan = [["warn", "// dry run: nothing is sent"]];
    plan.push(["info", "0) config + volumes + ports ride the version's on-chain record (approved with it) - nothing is pinned or passed at deploy"]);
    if (wafDry) plan.push(["info", "0b) protection rides the create() options envelope - the enclave's proxy enforces it per requester IP, the app never sees blocked traffic"]);
    const dryFee = currentFee6();
    if (dryFee > 0) plan.push(["info", "0c) this app charges a publisher fee of $" + (dryFee * 3600 / 1e6).toFixed(2) + "/hr - create() snapshots it and every funding pays the publisher's cut straight to their wallet"]);
    plan.push(["p", "1) EnclaveDeployments.create(app, shares) - one wallet tx; you own the record"],
      ["dimln", "   create(\"" + rref.reference + "\", " + gpuMilli + ", " + cpuMilli + ", " + appPort + ", \"" + portsCsv + "\", " + dep.public + (depRev >= 2 ? ", " + envDry + ")" : ", \"\", " + envDry + ")")],
      ["p", dep.asset === "ETH"
        ? "2) fundEth(id) with ≈ $" + fund + " of ETH - one wallet tx; credited on-chain"
        : "2) sign a " + fund + " USDC authorization (EIP-3009) + one fundWithAuthorization(id) tx - credited on-chain"],
      ["p", "3) POST /v1/claim-hint - an enclave claims the work and serves it"],
      ["dimln", "   the balance and spec live on Base: any enclave can take over if the runner dies"],
      ["info", "uncheck “Dry run” to deploy for real"]);
    return note(plan);
  }

  // the ToS gate (dry runs stay open - they send nothing). Both entry points
  // funnel through here: the Deploy button and the fetch pane's `run`.
  const tos = $("#tosAgree");
  if (!(tos && tos.checked))
    return note([["warn", "[!] real deploys need the Terms of Service box ticked (payments are crypto-only, non-custodial and final; uptime isn’t guaranteed)"]]);

  // capacity gate: a size the fleet can't start right now proceeds only
  // through the queue-confirm modal's explicit checkbox
  if (!(await confirmQueuedDeploy(gpuMilli / 10, cpuMilli / 10))) return;

  btn.disabled = true; const lbl = btn.textContent; btn.textContent = "working…";
  try {
    await deployOnChain({ reference: rref.reference, gpuMilli, cpuMilli, ports,
      isPublic: dep.public, fundUsd: fund, asset: dep.asset, waf: wafSpec() });
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
   spec: { reference (catalog://<appId>/<idx>), gpuMilli, cpuMilli,
   ports (csv, informational - the version's record is what enclaves apply),
   isPublic, fundUsd, asset, waf }. Config/volumes ride the version's on-chain
   record; deploys carry NO app config (a config CID stays refused). The one
   deploy-time field is the options ENVELOPE: spec.waf (per-IP rate limit +
   request filter) rides create()'s last string as {"waf":{…}}, interpreted by
   the enclave's proxy and never shown to the app. */
export async function deployOnChain(spec){
  // the on-chain share-cap gate runs BEFORE the dashboard redirect: a deploy
  // create() would refuse must be refused where the user is standing (the
  // console form, the store's quick-deploy) - not narrated into a run log
  // they were just navigated to. Both callers re-check earlier for richer
  // UI; this is the shared backstop for the races they can't see.
  const capMsg = await gpuCapRefusal(spec.gpuMilli);
  if (capMsg) return showToast("Deploy refused: " + capMsg);
  // The version's publisher fee is snapshotted INTO the record by create():
  // resolve it fresh from the catalog right before the signature (fail
  // closed - an under-declared fee makes a record no runner will ever
  // claim, its funding unrecoverable, same as under-provisioned shares).
  let fee6 = 0n, feeTo = null;
  const cref = parseCatalogRef(spec.reference);
  if (cref){
    try { fee6 = await catVersionFee(cref.appId, cref.index); }
    catch(e){ return showToast("Deploy refused: couldn't read the app's publisher fee from the catalog - try again shortly."); }
    if (fee6 > 0n){
      feeTo = publisherOfRef(spec.reference);
      if (!feeTo) return showToast("Deploy refused: the app's publisher wallet isn't loaded yet - open the Apps page and retry.");
      if ((await depSchemaRev()) < 4)
        return showToast("Deploy refused: this app charges a publisher fee, which the live deployments ledger predates.");
    }
  }
  const fund = spec.fundUsd;
  const { portsCsv, appPort } = portsSpec(spec.ports);
  const asset = spec.asset || "USDC";
  let w = null, detached = false;
  try {
    // the run log lives on the dashboard: get there BEFORE the first wallet
    // step so the whole narrative streams where the user is looking (the
    // document never unloads - this async flow survives the soft navigation)
    await navigate("dashboard");
    w = runlog.startRun();
    // NO SIWE sign-in here: the create tx and the funding signature ARE the
    // proof of key ownership - a connected wallet is all the flow needs
    if (!Enclave.provider){
      w.line("info", "[*] connecting wallet…");
      await connectWallet();
      w.line("ok", "[✓] wallet " + short(Enclave.address));
    }
    w.line("dimln", "    if nothing happens, check your wallet - a popup may be waiting (or queued behind an old one; open the wallet and clear pending requests)");
    await ensureBaseChain();

    // capacity heads-up BEFORE the first signature (fresh read: the store's
    // quick-deploy modal reaches here without the console's 20s poll). Not a
    // gate - the create is still right - but nobody should sign expecting an
    // instant boot when the fleet is full for this size.
    try {
      adoptFreePct(await Enclave.getAvailability());
      if (queuedVerdict(spec.gpuMilli / 10, spec.cpuMilli / 10))
        w.line("warn", "[!] the fleet is full for this size right now - after funding, the deployment waits as Queued and starts automatically the moment capacity frees up (queued time is never billed; the balance only burns while the app runs)");
    } catch(e){}

    // rate estimate straight from the contract (same ceil math as create) -
    // best-effort with a hard cap so a slow RPC can never stall the deploy
    let rate6 = 0n;
    try { rate6 = await Promise.race([depRate6(spec.gpuMilli, spec.cpuMilli), wait(6000).then(() => 0n)]); } catch(e){}
    if (rate6 > 0n){
      const rate = Number(rate6 + fee6) / 1e6;   // the publisher's cut rides on top, exactly as create() adds it
      w.line("info", "    " + fund + " USDC ≈ " + fmtDur(fund / rate) + " of runtime at $" + (rate * 3600).toFixed(2) + "/hr");
      if (fee6 > 0n)
        w.line("info", "    includes the app's publisher fee: $" + (Number(fee6) * 3600 / 1e6).toFixed(2) + "/hr, paid to " + short(feeTo) + " out of each funding");
    }

    // 1) create: one tx from YOUR wallet - msg.sender owns the on-chain record.
    // No config step: the appRef names the catalog version RECORD, and the
    // enclave takes config/volumes/ports straight from it (approval covered
    // them; a config CID stays refused). The last string carries "" or the
    // deployment-options envelope - platform settings like the per-IP WAF,
    // interpreted by the runner's proxy, never handed to the app.
    const envelope = spec.waf ? JSON.stringify({ waf: spec.waf }) : "";
    if (envelope) w.line("info", "    protection on: " + envelope + " (enforced per requester IP by the enclave's proxy)");
    w.line("p", "$ EnclaveDeployments.create(…)  (wallet · one tx · you own the record)");
    w.line("info", "[*] confirm the create transaction in your wallet…");
    // encode whichever create() shape the live contract speaks (depSchemaRev
    // sniffs once): rev 1 took a now-removed sshPubKey string before
    // configCid; rev 4 grew the publisher-fee snapshot (recipient, fee/sec)
    const rev = (depRev = await depSchemaRev());
    const cdata = encCall(rev >= 4 ? DEP_SEL.create : rev >= 2 ? DEP_SEL.createV3 : DEP_SEL.createV1, [
      { t: "str", v: spec.reference }, { t: "uint", v: spec.gpuMilli }, { t: "uint", v: spec.cpuMilli },
      { t: "uint", v: appPort }, { t: "str", v: portsCsv }, { t: "bool", v: !!spec.isPublic },
      ...(rev >= 2 ? [] : [{ t: "str", v: "" }]), { t: "str", v: envelope },
      ...(rev >= 4 ? [{ t: "addr", v: feeTo || "0x" + "0".repeat(40) }, { t: "uint", v: fee6 }] : []),
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
      else if (i > 1 && i % 3 === 0){
        // Re-hint every ~6s until an enclave claims (was every 30s). The FIRST
        // hint usually races ahead of the funding tx being visible to the
        // fleet's (load-balanced) RPC node and is declined; a slow re-hint would
        // strand a funded deploy on the sweep path, where a GPU enclave sits out
        // the 120s CPU-first grace before it will take CPU work. Cheap + idempotent
        // (a claiming enclave just answers "evaluating"); we surface the decline
        // reason only when it CHANGES, so this stays quiet in the log.
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
      w.line("warn", "[!] no enclave has claimed yet - the deployment stays on the queue (funded work is claimed as capacity frees up, and queued time is never billed). It appears below the moment one does.");
      const dp0 = depsPanel(); if (dp0) dp0.refresh(); return;
    }
  }
  w.line("ok", "[✓] claimed by enclave operator " + short(claimed.runnerOperator) + " · lease until " + new Date(claimed.leaseUntil * 1000).toLocaleTimeString());
  const label = appLabel(id);
  w.line("dimln", "    app origin: https://" + label + "." + APP_DOMAIN + "  (first request may take a moment: the enclave fetches + verifies your wasm from IPFS)");
  if (!Enclave.authed()){
    // tokenless flows read the LEDGER (create/fund/claim all show), but the
    // runner's live status stream is an owner-session read - the app itself
    // is already booting and reachable at the origin above
    w.line("dimln", "    claimed and funded - the app boots now. Open the app origin above, or unlock live status/logs on the row below (one gas-free signature).");
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
// Last-seen free capacity in whole percent (null = no availability read yet /
// fetch failed, so nobody warns on unknown). A pick ABOVE these is legal - the
// record queues on-chain and the autoscaler reads queued funded demand as its
// scale signal - but the user must know they're buying a queue slot, not an
// instant boot: renderDeploy shows #capWarn and deployOnChain narrates it.
// A GPU app's CPU slice rides its card's node, so it checks cpuOnGpuNode.
const freePct = { gpu: null, cpuAny: null, cpuOnGpuNode: null };
function adoptFreePct(a){
  const gpuFree = (a.gpuShareFree != null ? a.gpuShareFree : (a.gpu !== false ? (a.maxShare || 0) : 0));
  const cpuFree = (a.cpuShareFree != null ? a.cpuShareFree : (a.gpu === false ? (a.maxShare || 0) : 1));
  freePct.gpu = Math.floor(gpuFree * 100);
  freePct.cpuAny = Math.floor(cpuFree * 100);
  freePct.cpuOnGpuNode = a.gpuEnclaveCpuShareFree != null ? Math.floor(a.gpuEnclaveCpuShareFree * 100) : freePct.cpuAny;
  return { gpuFree, cpuFree };
}
// null when capacity is unknown; otherwise the queue-wait verdict for a pick
function queuedVerdict(gpuPct, cpuPct){
  if (freePct.gpu == null) return null;
  const overG = gpuPct > 0 && gpuPct > freePct.gpu;
  const cpuFreeHere = gpuPct > 0 ? freePct.cpuOnGpuNode : freePct.cpuAny;
  const overC = cpuPct > cpuFreeHere;
  return (overG || overC) ? { overG, overC, cpuFreeHere } : null;
}
/* The commit-time capacity gate, shared by the console's Deploy button and
   the store's quick-deploy modal. #capWarn under the dials is ambient; THIS
   is the deliberate stop: a size the fleet can't start right now only
   proceeds through an explicit checkbox, because the user is about to sign
   final, non-withdrawable funding for a deployment that will sit Queued.
   Fresh /availability read at click time (the 20s poll may be stale, and
   quick-deploy may never have polled). Resolves true to proceed -
   immediately when the size fits or capacity is unknown - false on cancel. */
/* The on-chain per-deployment GPU-share cap as a refusal message (null =
   fits; pre-cap contracts read as uncapped). Shared like confirmQueuedDeploy
   so every entry point shows it WHERE THE USER IS - the console form's note,
   the quick-deploy modal, deployOnChain's pre-navigation toast - instead of
   first redirecting to the dashboard for a create() that would only revert.
   `minGpuPct` (when known) picks the honest message: an app whose MINIMUM
   exceeds the cap is publishable but undeployable, not a dial problem. */
export async function gpuCapRefusal(gpuMilli, minGpuPct){
  const cap = await depMaxGpuMilli();
  if (!(gpuMilli > cap)) return null;
  return minGpuPct != null && minGpuPct * 10 > cap
    ? "this app needs at least a " + minGpuPct + "% GPU share, but the platform currently caps deployments at " + (cap / 10) + "% of a card - it can't be deployed right now."
    : "the platform caps GPU deployments at " + (cap / 10) + "% of a card - lower the GPU share (asked: " + (gpuMilli / 10) + "%).";
}

export async function confirmQueuedDeploy(gpuPct, cpuPct){
  try { adoptFreePct(await Enclave.getAvailability()); } catch(e){}
  const q = queuedVerdict(gpuPct, cpuPct);
  if (!q) return true;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "qd-overlay"; host.id = "capConfirm";
    const freeLine = gpuPct > 0
      ? freePct.gpu + "% of a card / " + q.cpuFreeHere + "% of its node are free right now; this deployment asks for " + gpuPct + "% / " + cpuPct + "%"
      : freePct.cpuAny + "% of the node is free right now; this deployment asks for " + cpuPct + "%";
    host.innerHTML =
      '<div class="qd-card capq" role="dialog" aria-modal="true" aria-label="Not enough free capacity">' +
        '<div class="qd-h">⚠ The fleet is full for this size</div>' +
        '<p class="qd-sub">' + esc(freeLine) + '. You can still deploy: the deployment is created on-chain, waits as <b>Queued</b>, and starts automatically the moment capacity frees up.</p>' +
        '<p class="qd-sub">Queued time is never billed - the balance only burns while the app runs. But payments are final: the funding stays on the deployment until it runs, it cannot be withdrawn back to your wallet.</p>' +
        '<label class="qd-tos"><input type="checkbox" class="capq-ck" /> <span>I understand this deployment will <b>wait in the queue</b> - possibly for a while - and start on its own once capacity frees up.</span></label>' +
        '<div class="qd-actions">' +
          '<button class="btn btn-primary capq-go" type="button" disabled>▸ Queue for Deployment</button>' +
          '<button class="btn capq-cancel" type="button">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(host);
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    const done = (ok) => { host.remove(); document.removeEventListener("keydown", onKey); resolve(ok); };
    document.addEventListener("keydown", onKey);
    const ck = host.querySelector(".capq-ck"), go = host.querySelector(".capq-go");
    ck.addEventListener("change", () => { go.disabled = !ck.checked; });
    go.addEventListener("click", () => done(true));
    host.querySelector(".capq-cancel").addEventListener("click", () => done(false));
    host.addEventListener("click", (e) => { if (e.target === host) done(false); });
  });
}
async function refreshAvailability(){
  const gIn = $("#cfgGpuShare"), capG = $("#gpuShareCap");
  const cIn = $("#cfgCpuShare"), capC = $("#cpuShareCap");
  if (!gIn) return;
  try {
    const a = await Enclave.getAvailability();
    dep.gpuEnclave = a.gpu !== false;               // gpu:false = CPU-only enclave (older enclaves omit the field)
    // Protection (options envelope): only offered when the aggregate says the
    // WHOLE fleet enforces it - a runner that predates the envelope refuses
    // the deployment at claim, so a mixed fleet must not sell the option.
    dep.wafAvail = a.waf === true;
    const wf = $("#wafField");
    if (wf){ wf.hidden = !dep.wafAvail; if (!dep.wafAvail) dep.waf = false; }
    const unitG = $("#gpuShareUnit");
    if (unitG) unitG.textContent = dep.gpuEnclave ? "(% of one card · 0 = CPU-only app)" : "(CPU-only enclave · no GPU here)";
    // getAvailability() adopted this payload into the share math already;
    // read the capacity captions off the same adopted numbers
    const spec = serverSpec();
    const cardGb = spec.cardVramGb, cardTf = spec.cardTflops, nodeRamGb = spec.nodeRamGb;
    // both pools, live: the largest free slice of one card and the node's
    // leftover vCPU+RAM pool; maxShare = older enclaves. The dials are NOT
    // capped at what's free - a bigger pick queues on-chain until capacity
    // frees (renderDeploy warns) - only the structural spec floors gate.
    const { gpuFree, cpuFree } = adoptFreePct(a);
    if (dep.gpuEnclave) {
      // the dial's hard top is the ON-CHAIN per-deployment cap, not what's
      // free (a pick above free capacity queues; a pick above the cap is
      // refused by create() itself)
      const capPct = Math.min(100, Math.floor((await depMaxGpuMilli()) / 10));
      gIn.max = String(capPct);
      if (capG) capG.textContent = "· " + freePct.gpu + "% of a card free now (≈" + Math.round(gpuFree * cardGb) + " GB / " + Math.round(gpuFree * cardTf) + " TFLOPS)"
        + (capPct < 100 ? " · platform cap: " + capPct + "% per deployment" : "");
    } else {
      gIn.max = "0";
      if (capG) capG.textContent = "· GPU apps run on GPU enclaves";
      if (dep.gpuPct !== 0 && document.activeElement !== gIn){ dep.gpuPct = 0; gIn.value = "0"; }
    }
    if (cIn) cIn.max = "100";
    if (capC) capC.textContent = "· " + freePct.cpuAny + "% of the node free now (≈"
      + fmtNum(cpuFree * nodeRamGb) + " GB RAM / ≈" + fmtNum(cpuFree * spec.nodeVcpus) + " vCPU)";
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
        const cur = byName.get(v.name) || { name: v.name, bytes: 0, onnx: false, gguf: false, sd: false, count: 0 };
        cur.bytes = Math.max(cur.bytes, v.bytes || 0); cur.onnx = cur.onnx || !!v.onnx; cur.gguf = cur.gguf || !!v.gguf; cur.sd = cur.sd || !!v.sd; cur.count++;
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
  // #deploy always exists on the apps page now - only poll while the deploy
  // view is actually visible (a reopened view is at most one tick stale)
  availPoll = setInterval(() => { const d = $("#deploy"); if (d && !d.hidden) { refreshAvailability(); refreshFleet(); } }, 20000);
}

/* ============================================================
   Wallet-dependent console chrome
   ============================================================ */
/* Live balance for the selected pay asset under the Pay-with control. When
   the order checkout is live (ACCOUNTS_ENABLED), a "Buy runtime" link offers
   the card path: it parks the console's configured spec for the checkout
   page and navigates there. The direct wallet-pay flow around it is
   untouched - this is an alternative, not a replacement. */
let _balSeq = 0;
async function updateUsdcBalance(){
  const el = $("#payBal"); if (!el) return;
  if (!Enclave.address || !Enclave.provider){ el.hidden = true; return; }
  const seq = ++_balSeq;
  try {
    // the card follows the selected pay asset: USDC by default, ETH when the
    // user flips the toggle
    const wantEth = (dep.asset === "ETH");
    const label = wantEth ? "ETH balance" : "USDC balance";
    const val = wantEth ? (await ethBalanceOf(Enclave.address)).toFixed(4) + " ETH"
                        : (await usdcBalanceOf(Enclave.address)).toFixed(2) + " USDC";
    if (seq !== _balSeq) return;
    el.innerHTML = '<div><span class="pb-k">' + label + '</span><span class="pb-v">' + esc(val) + '</span></div>' +
      (ACCOUNTS_ENABLED ? '<button class="pb-buy" id="payBuyRuntime" type="button">Buy runtime →</button>' : "");
    el.hidden = false;
    const br = $("#payBuyRuntime");
    if (br) br.onclick = () => {
      try {
        const raw = ($("#cfgImage") && $("#cfgImage").value || "").trim();
        sessionStorage.setItem("enclave_checkout_spec", JSON.stringify({
          appRef: raw ? resolveAppRef(raw).reference : "",
          gpuShare: (dep.gpuEnclave ? Math.round(dep.gpuPct) : 0) / 100,
          cpuShare: Math.max(1, Math.round(dep.cpuPct)) / 100,
          appPort: 8080, isPublic: dep.public !== false,
        }));
      } catch(e){}
      navigate("checkout", { push: true });
    };
  } catch(e){ if (seq === _balSeq) el.hidden = true; }
}

async function checkHealth(){
  const ind = $("#epState");
  if (ind){ ind.className = "ep-state"; ind.textContent = "checking…"; }
  try {
    const h = await Enclave.health();
    if (ind){
      ind.className = "ep-state ok";
      // the RELAY answers even with zero enclaves: the API is reachable and
      // deploys still work (they queue on the ledger) - say that, don't cry wolf
      ind.textContent = (h && h.enclaves === 0)
        ? "reachable · no live enclaves (deploys queue on-chain)"
        : "reachable";
    }
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
  const raw = new URLSearchParams(location.search).get("app");
  if (!raw) return;
  // ?app= accepts slug:version AND the share-link form slug_version (the "_"
  // keeps the URL un-percent-encoded; the LAST one splits, so slugs with
  // underscores survive - versions carry none)
  const friendly = raw.includes(":") ? raw : raw.replace(/_(?=[^_]*$)/, ":");
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
      syncVolsFromCfg();   // a template carrying {"volumes":[…]} ticks the picker
    }
    renderDeploy();
    showToast("Deploy set to " + friendly + " (min " + mins.gpuPct + "% GPU / " + mins.cpuPct + "% CPU)"
            + (ports ? " · open ports " + ports : "") + (config ? " · config template applied" : ""));
  };
  // the stash must carry the version's RAW specs (not computed percents): the
  // floors are recomputed HERE against the currently adopted fleet hardware -
  // percents minted on the Apps page could predate the availability fetch.
  // A stash without specs (older tab) falls through to the catalog re-resolve.
  if (stash && stash.friendly === friendly && stash.appId != null && stash.index != null && stash.spec){
    REF_CACHE[friendly] = catalogRef(stash.appId, stash.index);
    PORTS_CACHE[friendly] = stash.ports || "";
    SPECS_CACHE[friendly] = stash.spec;
    CONFIG_CACHE[friendly] = stash.config || "";
    applyMins(minPctsOf(stash.spec), stash.ports, stash.config);
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
  if (fleetList) {
    // the component's ↻ button: the dials' caps and the fleet table show the
    // same capacity, so refresh both (named refs = idempotent re-init)
    fleetList.addEventListener("refresh", refreshAvailability);
    fleetList.addEventListener("refresh", refreshFleet);
  }

  $("#cfgGpuShare").addEventListener("input", e => { dep.gpuPct = parseFloat(e.target.value) || 0; renderDeploy(); });
  const cpuIn = $("#cfgCpuShare"); if (cpuIn) cpuIn.addEventListener("input", e => { dep.cpuPct = parseFloat(e.target.value) || 0; renderDeploy(); });
  $("#cfgAsset").addEventListener("click", e => {
    const b = e.target.closest("button[data-asset]"); if (!b) return;
    dep.asset = b.dataset.asset; $$("#cfgAsset button").forEach(x => segSet(x, x === b));
    renderDeploy(); updateUsdcBalance();
  });
  $("#cfgAccess").addEventListener("click", e => {
    const b = e.target.closest("button[data-public]"); if (!b) return;
    dep.public = b.dataset.public === "1"; $$("#cfgAccess button").forEach(x => segSet(x, x === b));
    renderAccessNote(); renderDeploy();
  });
  renderAccessNote();
  const cfgWaf = $("#cfgWaf");
  if (cfgWaf){
    cfgWaf.addEventListener("click", e => {
      const b = e.target.closest("button[data-waf]"); if (!b) return;
      dep.waf = b.dataset.waf === "1"; $$("#cfgWaf button").forEach(x => segSet(x, x === b));
      const opts = $("#wafOpts"); if (opts) opts.hidden = !dep.waf;
      renderDeploy();
    });
    ["#wafRps", "#wafBurst", "#wafBody"].forEach(s => { const el = $(s); if (el) el.addEventListener("input", renderDeploy); });
    const ws = $("#wafScan"); if (ws) ws.addEventListener("change", renderDeploy);
  }
  ["#cfgImage", "#cfgBudget", "#cfgPorts"].forEach(s => { const el = $(s); if (el) el.addEventListener("input", renderDeploy); });
  // the config box mirrors the picked VERSION's config (read-only): its
  // `volumes` key drives the ticks, and neither is deployer-editable — a
  // different config/volume set means publishing (and approving) a new version
  const cc = $("#cfgConfig"); if (cc) cc.addEventListener("input", () => { syncVolsFromCfg(); renderDeploy(); });
  if (volPicker) volPicker.addEventListener("change", () => {
    dep.volumes.clear(); lastVols.forEach(n => dep.volumes.add(n));
    volPicker.requestRender();
    showToast("Volumes are set by the version's config (covered by its approval) - pick a version that attaches what you need, or publish a new one");
    renderDeploy();
  });
  $$(".console-tabs button").forEach(b => b.addEventListener("click", () => switchPane(b.dataset.pane)));
  // roving tabindex on the tablist: arrows/Home/End move focus AND select
  const tl = $(".console-tabs");
  if (tl) tl.addEventListener("keydown", e => {
    const bs = $$(".console-tabs button"), i = bs.indexOf(document.activeElement);
    const j = e.key === "ArrowRight" ? (i + 1) % bs.length
            : e.key === "ArrowLeft"  ? (i - 1 + bs.length) % bs.length
            : e.key === "Home" ? 0 : e.key === "End" ? bs.length - 1 : -1;
    if (i < 0 || j < 0) return;
    e.preventDefault(); switchPane(bs[j].dataset.pane, true);
  });
  // ToS assent is shared with the store's quick-deploy modal (same
  // localStorage key, per terms version) - accepted once = pre-checked here
  const tos = $("#tosAgree");
  if (tos){
    tos.checked = tosAccepted();
    tos.addEventListener("change", () => { setTosAccepted(tos.checked); if (tos.checked) note([]); });
  }
  $("#deployBtn").addEventListener("click", runDeploy);
  const frb = $("#fetchRunBtn"); if (frb) frb.addEventListener("click", runDeploy);   // the snippet IS the deploy flow
  $("#resetBtn").addEventListener("click", () => {
    $("#cfgImage").value = "";
    const fp0 = $("#cfgPorts"); if (fp0) fp0.value = "";
    const cc0 = $("#cfgConfig"); if (cc0) cc0.value = "";
    syncVolsFromCfg();   // empty config = no volumes; the ticks follow
    $("#cfgBudget").value = "10";
    $("#cfgGpuShare").value = "25"; dep.gpuPct = 25;
    const cp0 = $("#cfgCpuShare"); if (cp0) cp0.value = "5"; dep.cpuPct = 5;
    dep.asset = "USDC"; dep.public = true;
    $$("#cfgAsset button").forEach(x => segSet(x, x.dataset.asset === "USDC"));
    $$("#cfgAccess button").forEach(x => segSet(x, x.dataset.public === "1"));
    dep.waf = false;
    $$("#cfgWaf button").forEach(x => segSet(x, x.dataset.waf === "0"));
    const wo = $("#wafOpts"); if (wo) wo.hidden = true;
    const wr = $("#wafRps"); if (wr) wr.value = "10";
    const wb = $("#wafBurst"); if (wb) wb.value = "40";
    const wm = $("#wafBody"); if (wm) wm.value = "";
    const ws0 = $("#wafScan"); if (ws0) ws0.checked = true;
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
  depSchemaRev().then(r => { depRev = r; renderDeploy(); }).catch(() => {});
  startAvailPoll();
  checkHealth();
  applyUseInDeploy();
}

// wallet/session signals from the shared chrome (<c-deployments> handles its
// own). Subscribed once at module load; every callee null-guards its elements,
// so it's inert while another page's <main> is mounted.
on("enclave:wallet", () => {
  updateUsdcBalance();
});

/* called by apps.js the first time the #deploy view opens on each <main>
   mount (the console is a hash-routed sub-page of Apps, not a router page) */
export function boot() {
  initDeploy();
}
