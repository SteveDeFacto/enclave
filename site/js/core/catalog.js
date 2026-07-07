/* ============================================================
   App store · on-chain catalog (EnclaveAppCatalog on Base) + IPFS CIDs
   Apps are versioned: keyed by keccak256(publisher, slug), each with an
   append-only list of releases (own CID, label, verified/yank flags).
   Browsing reads the contract via a public RPC eth_call (no wallet).

   This module is the shared READ side + the friendly-ref caches:
   the Apps page renders from it, and the Deploy page resolves
   slug:version references and pre-flights the deploy gate with it.
   Load progress is announced with `enclave:catalog` events (detail.type:
   loading | loaded | error) — pages render, this module doesn't.
   ============================================================ */
import { APP_CATALOG_ADDRESS } from "./config.js";
import { catConfigured, appCount, catGetAppsPage, catGetVersions, catOwner, APPROVAL } from "./chain.js";
import { lsGet, lsSet, emit } from "./util.js";
import { minPctsOf } from "./pricing.js";

export const STORE = { apps:[], byId:{}, sel:{}, owner:null, filter:"all", loaded:false, loading:false };

// firewall entry: http (default web app) | http:N | tcp:N | udp:N, N in 1-19999 (labels; <1024 always remapped)
// (8080/8091 are infra-reserved; the enclave enforces the same rules server-side)
export const FW_ENTRY_RE = /^(http|http:\d{1,5}|tcp:\d{1,5}|udp:\d{1,5})$/;
export function validPortsCsv(s){
  const parts = String(s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const p of parts){
    if (!FW_ENTRY_RE.test(p)) return "bad port spec '" + p + "' (use http[:N], tcp:N, udp:N)";
    const n = p.includes(":") ? +p.split(":")[1] : 0;
    if (n && (n < 1 || n > 19999 || n === 8080 || n === 8091)) return "port " + n + " not allowed (1-19999, excluding 8080/8091)";
  }
  return null;
}

// The last good catalog is cached in localStorage (stale-while-revalidate):
// paint it instantly, refresh behind it, and a failed refresh keeps the page
// usable instead of replacing it with an error wall.
export function catCacheGet(){
  try { const c = JSON.parse(lsGet("enclave_catalog_" + APP_CATALOG_ADDRESS) || "null");
        return (c && Array.isArray(c.apps)) ? c : null; } catch(e){ return null; }
}
export function catCacheSet(apps){ lsSet("enclave_catalog_" + APP_CATALOG_ADDRESS, JSON.stringify({ at: Date.now(), apps })); }

export async function loadCatalog(force){
  if (!catConfigured()){ STORE.loaded = true; emit("enclave:catalog", { type: "loaded" }); return; }
  if (STORE.loading || (STORE.loaded && !force)) return;
  STORE.loading = true;
  if (STORE.owner === null)   // fetch alongside the catalog read, not after it: badges need it
    catOwner().then(o => { STORE.owner = o.toLowerCase(); emit("enclave:catalog", { type: "loaded" }); }).catch(() => {});
  if (!STORE.loaded){
    const cached = catCacheGet();
    if (cached){
      STORE.apps = cached.apps; STORE.byId = {}; cached.apps.forEach(a => STORE.byId[a.appId] = a);
      STORE.loaded = true; emit("enclave:catalog", { type: "loaded", stale: true });
    } else emit("enclave:catalog", { type: "loading" });
  }
  try {
    const n = await appCount();
    const apps = []; const PAGE = 50;
    for (let s = 0; s < n; s += PAGE) apps.push(...await catGetAppsPage(s, PAGE));
    await Promise.all(apps.map(async a => { a.versions = await catGetVersions(a.appId, a.versionCount); }));
    STORE.apps = apps; STORE.byId = {}; apps.forEach(a => STORE.byId[a.appId] = a);
    STORE.loaded = true;
    catCacheSet(apps);
  } catch(e){
    emit("enclave:catalog", { type: "error", message: e.message || String(e) });
    STORE.loading = false; return;
  }
  STORE.loading = false; emit("enclave:catalog", { type: "loaded" });
}

/* ---- version selection helpers ---- */
export function defaultIdx(app){                                   // newest non-yanked release, else newest
  for (let i = app.versions.length - 1; i >= 0; i--) if (!app.versions[i].yanked) return i;
  return app.versions.length - 1;
}
export function selIdx(app){
  const s = STORE.sel[app.appId];
  return (s != null && s >= 0 && s < app.versions.length) ? s : defaultIdx(app);
}
// platform-published apps: publisher wallet == the catalog contract deployer
export const appOfficial = (app) => !!(STORE.owner && app.publisher.toLowerCase() === STORE.owner);
// the Verified filter means "owner-endorsed": an explicit setVerified flag, or official
// (owner-published is implicit endorsement - none of the platform apps carry the flag)
export const appVerified = (app) => { const i = defaultIdx(app); return i >= 0 && (app.versions[i].verified || appOfficial(app)); };

/* Resolve what the user typed into an `image.reference` the enclave understands.
   Humans type "[publisher/]slug:version"; we look it up in the on-chain catalog
   and hand the enclave the app's `ipfs://<cid>` (unique because version labels are
   unique per app). Raw CIDs are NOT accepted as input — deploys need the app's
   on-chain metadata (specs, ports, approval), so unlisted bytes must be published
   first. Returns {reference, label?, error?, pending?}. */
export const REF_CACHE = {};    // friendly "slug:version" -> "ipfs://<cid>" (filled by Use-in-Deploy + lookups)
export const PORTS_CACHE = {};  // friendly "slug:version" -> that version's firewall CSV (defaults the deploy)
export const MINS_CACHE = {};   // friendly "slug:version" -> minimum dial positions { gpuPct, cpuPct } from its specs
export function looksFriendly(s){ return s.includes(":") && !s.startsWith("ipfs://"); }
export function resolveAppRef(input){
  input = (input || "").trim();
  if (!input) return { reference: "", error: "Pick an app: slug:version from the Apps catalog." };
  if (input.startsWith("ipfs://") || /^(baf[a-z0-9]{10,}|Qm[1-9A-HJ-NP-Za-km-z]{20,})$/.test(input))
    return { reference: input, error: "Raw CIDs can’t deploy — the enclave needs the app’s on-chain specs and approval. Publish it to the catalog first, then deploy its slug:version." };
  if (!looksFriendly(input)) return { reference: input, error: "Not a slug:version reference. Deploys come from the on-chain catalog — pick an app on the Apps page." };
  if (REF_CACHE[input]) return { reference: REF_CACHE[input], label: input };
  let pub = null, rest = input;
  const slash = input.indexOf("/");
  if (slash >= 0){ pub = input.slice(0, slash).trim().toLowerCase(); rest = input.slice(slash + 1); }
  const colon = rest.lastIndexOf(":");
  const slug = rest.slice(0, colon).trim(), version = rest.slice(colon + 1).trim();
  if (!STORE.loaded) return { reference: input, label: input, pending: true };   // catalog not read yet
  let apps = (STORE.apps || []).filter(a => a.slug === slug && a.active);
  if (pub) apps = apps.filter(a => a.publisher.toLowerCase() === pub);
  if (!apps.length) return { reference: input, label: input, error: "No catalog app '" + slug + "'" + (pub ? " by " + pub : "") + "." };
  if (apps.length > 1) return { reference: input, label: input, error: "Several publishers have '" + slug + "'; qualify it: <publisher>/" + slug + ":" + version };
  const v = apps[0].versions.find(x => x.version === version && !x.yanked);
  if (!v) return { reference: input, label: input, error: "'" + slug + "' has no live version '" + version + "'." };
  if (v.approval !== APPROVAL.approved)
    return { reference: input, label: input, error: "'" + slug + ":" + version + "' " + (v.approval === APPROVAL.rejected ? "was rejected" : "isn’t approved yet") + " by the catalog owner; the enclave refuses to deploy it." };
  REF_CACHE[input] = "ipfs://" + v.cid;
  PORTS_CACHE[input] = v.ports || "";
  MINS_CACHE[input] = minPctsOf(v);   // the version's specs -> the dials' floors
  return { reference: REF_CACHE[input], label: input, mins: MINS_CACHE[input] };
}

// deployment rows show the human app name (slug:version) when the catalog can
// resolve the CID - from the live STORE or the localStorage catalog cache -
// falling back to the truncated ipfs:// reference.
export function slugOfRef(ref){
  const cid = String(ref || "").replace(/^ipfs:\/\//, "").trim();
  if (!cid) return null;
  const lists = [];
  if (Array.isArray(STORE.apps) && STORE.apps.length) lists.push(STORE.apps);
  try {
    const raw = lsGet("enclave_catalog_" + APP_CATALOG_ADDRESS);
    if (raw){ const j = JSON.parse(raw); if (j && Array.isArray(j.apps)) lists.push(j.apps); }
  } catch(e){}
  for (const apps of lists) for (const a of apps){
    const vs = (a && a.versions) || [];
    for (const v of vs) if (v && v.cid === cid) return a.slug + (v.version != null ? ":" + v.version : "");
  }
  return null;
}
