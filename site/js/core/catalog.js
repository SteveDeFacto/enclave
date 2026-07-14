/* ============================================================
   App store · on-chain catalog (EnclaveAppCatalog on Base) + IPFS CIDs
   Apps are versioned: keyed by keccak256(publisher, slug), each with an
   append-only list of releases (own CID, label, verified/yank flags).
   Browsing reads the contract via a public RPC eth_call (no wallet).

   This module is the shared READ side + the friendly-ref caches:
   the Apps page renders from it, and the Deploy page resolves
   slug:version references and pre-flights the deploy gate with it.
   Load progress is announced with `enclave:catalog` events (detail.type:
   loading | loaded | error) - pages render, this module doesn't.
   ============================================================ */
import { APP_CATALOG_ADDRESS, IPFS_IMG_GATEWAY } from "./config.js";
import { catConfigured, appCount, catGetAppsPage, catGetVersions, catOwner, APPROVAL } from "./chain.js";
import { lsGet, lsSet, emit, on, esc } from "./util.js";
import { minPctsOf } from "./pricing.js";
import { Enclave } from "./api.js";

export const STORE = { apps:[], byId:{}, sel:{}, owner:null, filter:"approved", loaded:false, loading:false };

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
// Yanked and rejected releases are the publisher's cleanup and the owner's
// moderation surface, not the store's: normal browsers never see them (the
// enclave refuses to deploy them anyway - resolveAppRef below). The app's
// publisher and the catalog owner see everything, since these states are
// exactly what they act on (yank/approve/reject buttons).
export const appPrivileged = (app) => {
  const me = (Enclave.address || "").toLowerCase();
  return !!me && (app.publisher.toLowerCase() === me || me === STORE.owner);
};
export const verVisible = (app, v) => appPrivileged(app) || (!v.yanked && v.approval !== APPROVAL.rejected);
// indices into app.versions the viewer may see - callers keep the REAL index
// (catalog:// refs and card-action idx are positions in the on-chain list)
export const visibleVerIdxs = (app) =>
  app.versions.reduce((idxs, v, i) => (verVisible(app, v) && idxs.push(i), idxs), []);
export function defaultIdx(app){         // newest visible non-yanked release, else newest visible; -1 = none to show
  const vs = app.versions;
  for (let i = vs.length - 1; i >= 0; i--) if (!vs[i].yanked && verVisible(app, vs[i])) return i;
  for (let i = vs.length - 1; i >= 0; i--) if (verVisible(app, vs[i])) return i;
  return -1;
}
export function selIdx(app){
  const s = STORE.sel[app.appId];
  return (s != null && s >= 0 && s < app.versions.length && verVisible(app, app.versions[s])) ? s : defaultIdx(app);
}
// platform-published apps: publisher wallet == the catalog contract deployer
export const appOfficial = (app) => !!(STORE.owner && app.publisher.toLowerCase() === STORE.owner);
// the Verified filter means "owner-endorsed": an explicit setVerified flag, or official
// (owner-published is implicit endorsement - none of the platform apps carry the flag)
export const appVerified = (app) => { const i = defaultIdx(app); return i >= 0 && (app.versions[i].verified || appOfficial(app)); };

/* ---- app media (tile thumbnail + detail-page banner) ----
   Media CIDs ride inside the version's config JSON under a reserved `_media`
   key ({ thumbnail, banner }). This keeps the EnclaveAppCatalog contract
   unchanged - the trade-off (accepted) is that media is per-version, immutable,
   and re-reviewed on change, exactly like the rest of a version's config. The
   runner delivers the whole config as ENCLAVE_CONFIG, so an app just sees an
   extra `_media` key it ignores; the deploy console strips it from its preview. */
export const MEDIA_KEY = "_media";
const cleanCid = (c) => (typeof c === "string" && /^[a-zA-Z0-9]{10,100}$/.test(c.trim())) ? c.trim() : "";
export function mediaOf(version){
  if (!version || !version.config) return {};
  try {
    const m = JSON.parse(version.config)[MEDIA_KEY];
    if (m && typeof m === "object" && !Array.isArray(m))
      return { thumbnail: cleanCid(m.thumbnail), banner: cleanCid(m.banner) };
  } catch(e){}
  return {};
}
// media of an app's DEFAULT (displayed) version - what the tile + detail show
export function appMedia(app){ const i = app && app.versions ? defaultIdx(app) : -1; return i >= 0 ? mediaOf(app.versions[i]) : {}; }
// drop the reserved `_media` key from a config string (for the deploy preview /
// the publish "add version" prefill - media is edited via its own pickers)
export function stripMedia(configStr){
  if (!configStr) return "";
  try {
    const o = JSON.parse(configStr);
    if (o && typeof o === "object" && MEDIA_KEY in o){ delete o[MEDIA_KEY]; return Object.keys(o).length ? JSON.stringify(o) : ""; }
  } catch(e){}
  return configStr;
}
// fold thumbnail/banner CIDs into a config string for publishing (JSON string,
// or "" when there's neither config nor media)
export function withMedia(configStr, thumbnail, banner){
  let o = {};
  if (configStr){ try { const p = JSON.parse(configStr); if (p && typeof p === "object" && !Array.isArray(p)) o = p; } catch(e){} }
  const m = {};
  if (cleanCid(thumbnail)) m.thumbnail = thumbnail.trim();
  if (cleanCid(banner)) m.banner = banner.trim();
  if (Object.keys(m).length) o[MEDIA_KEY] = m; else delete o[MEDIA_KEY];
  return Object.keys(o).length ? JSON.stringify(o) : "";
}

/* Resolve what the user typed into an `image.reference` the enclave understands.
   Humans type "[publisher/]slug:version"; we look it up in the on-chain catalog
   and hand the enclave `catalog://<appId>/<versionIndex>` — the on-chain RECORD
   of that version. The record (not the deployer) carries everything approval
   covered: wasm CID, config, ports, specs. CIDs are NOT app references - a CID
   names bytes, and several versions (with different approved configs) can share
   bytes. Returns {reference, label?, error?, pending?}. */
export const catalogRef = (appId, index) => "catalog://" + appId + "/" + index;
export const parseCatalogRef = (ref) => {
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(String(ref || "").trim());
  return m ? { appId: m[1], index: +m[2] } : null;
};
export const REF_CACHE = {};    // friendly "slug:version" -> "catalog://<appId>/<idx>" (filled by Use-in-Deploy + lookups)
export const PORTS_CACHE = {};  // friendly "slug:version" -> that version's firewall CSV (defaults the deploy)
export const SPECS_CACHE = {};  // friendly "slug:version" -> the version's RAW specs {vramMb,gpuGflops,memMb,cpuGflops}.
                                // Raw on purpose: dial floors are minPctsOf(spec) AT READ TIME, so they always
                                // divide by the currently adopted fleet hardware - caching computed percents
                                // froze them against whatever spec was live at first resolve (the 91%-vs-92%
                                // unclaimable-deployment bug of 2026-07-14)
export const specOf = (v) => ({ vramMb: Number(v && v.vramMb) || 0, gpuGflops: Number(v && v.gpuGflops) || 0,
                                memMb: Number(v && v.memMb) || 0, cpuGflops: Number(v && v.cpuGflops) || 0 });
export const CONFIG_CACHE = {}; // friendly "slug:version" -> that VERSION's default/template config JSON (pre-fills the deploy form)
export function looksFriendly(s){ return s.includes(":") && !s.startsWith("ipfs://"); }
export function resolveAppRef(input){
  input = (input || "").trim();
  if (!input) return { reference: "", error: "Pick an app: slug:version from the Apps catalog." };
  if (input.startsWith("ipfs://") || /^(baf[a-z0-9]{10,}|Qm[1-9A-HJ-NP-Za-km-z]{20,})$/.test(input))
    return { reference: input, error: "CIDs can’t deploy - a CID names bytes, not a version (several versions can share bytes and differ in approved config). Deploy a slug:version from the Apps catalog." };
  if (!looksFriendly(input)) return { reference: input, error: "Not a slug:version reference. Deploys come from the on-chain catalog - pick an app on the Apps page." };
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
  const vi = apps[0].versions.findIndex(x => x.version === version && !x.yanked);
  const v = vi >= 0 ? apps[0].versions[vi] : null;
  if (!v) return { reference: input, label: input, error: "'" + slug + "' has no live version '" + version + "'." };
  if (v.approval !== APPROVAL.approved)
    return { reference: input, label: input, error: "'" + slug + ":" + version + "' " + (v.approval === APPROVAL.rejected ? "was rejected" : "isn’t approved yet") + " by the catalog owner; the enclave refuses to deploy it." };
  REF_CACHE[input] = catalogRef(apps[0].appId, vi);
  PORTS_CACHE[input] = v.ports || "";
  SPECS_CACHE[input] = specOf(v);         // raw specs; floors are computed at read time
  CONFIG_CACHE[input] = v.config || "";   // the version's default config template
  return { reference: REF_CACHE[input], label: input, mins: minPctsOf(SPECS_CACHE[input]) };
}

// A mid-session address-book change (js/core/addressbook.js emits
// `enclave:addresses` when APP_CATALOG_ADDRESS et al. are repointed on-chain)
// leaves our loaded catalog reading the OLD contract. Re-read against the new
// address so pages repaint - loadCatalog emits `enclave:catalog` on completion,
// which is exactly the repaint signal the Apps/Deploy pages already listen for.
on("enclave:addresses", ({ changed }) => {
  if (changed && changed.indexOf("APP_CATALOG_ADDRESS") !== -1){
    STORE.loaded = false; STORE.loading = false; STORE.owner = null;
    loadCatalog(true);
  }
});

// deployment rows resolve their catalog://<appId>/<idx> reference to the app
// record - from the live STORE or the localStorage catalog cache (either may
// be populated first, depending on which page the visitor landed on).
function appOfRef(cr){
  const lists = [];
  if (Array.isArray(STORE.apps) && STORE.apps.length) lists.push(STORE.apps);
  try {
    const raw = lsGet("enclave_catalog_" + APP_CATALOG_ADDRESS);
    if (raw){ const j = JSON.parse(raw); if (j && Array.isArray(j.apps)) lists.push(j.apps); }
  } catch(e){}
  for (const apps of lists) for (const a of apps)
    if (a && a.appId === cr.appId) return { app: a, v: (a.versions || [])[cr.index] || null };
  return null;
}
// the human app name (slug:version) for a deployment row. Legacy ipfs:// rows
// return null (the caller falls back to the truncated reference): a CID can
// belong to several versions with different approved configs - naming one
// would be a guess.
export function slugOfRef(ref){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  if (!hit) return null;
  return hit.app.slug + (hit.v && hit.v.version != null ? ":" + hit.v.version : "#" + cr.index);
}

/* ---- generated stand-in art ----
   For apps that ship no thumbnail (store tiles AND dashboard rows): an accent
   from the site palette keyed off `key`, the enclave corner brackets, and the
   app's initial. Inline SVG data URI - nothing to fetch, can never 404; the
   same key always yields the same art, so a deployment's chip matches its
   store tile. */
const ART_ACCENTS = ["#2fe6a8", "#8fa2ff", "#ff914d", "#57d7ff", "#c08aff", "#e66bd2"];
export function placeholderArt(key, initial){
  key = String(key || "?");
  let h = 5381; for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  const c = ART_ACCENTS[h % ART_ACCENTS.length];
  const ch = esc(String(initial || "?").trim().charAt(0).toUpperCase() || "?");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">'
    + '<rect width="320" height="180" fill="#0b0f16"/>'
    + '<circle cx="160" cy="90" r="115" fill="' + c + '" opacity=".05"/>'
    + '<circle cx="160" cy="90" r="62" fill="' + c + '" opacity=".07"/>'
    + '<path d="M26 42v-18h18M294 42v-18h-18M26 138v18h18M294 138v18h-18" stroke="' + c + '" stroke-width="2" fill="none" opacity=".55"/>'
    + '<text x="160" y="92" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="64" font-weight="600" fill="' + c + '" opacity=".9">' + ch + '</text>'
    + '</svg>';
  return "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
}
// CSS background-image for a deployment row's app chip: the referenced
// version's real thumbnail when the catalog knows it, else placeholder art
// keyed by the appId (so it matches the store tile). `label` seeds the art
// for legacy ipfs:// rows the catalog can't name.
export function artOfRef(ref, label){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  const m = hit && hit.v ? mediaOf(hit.v) : {};
  if (m.thumbnail) return "url('" + IPFS_IMG_GATEWAY + encodeURIComponent(m.thumbnail) + "')";
  const name = (hit && (hit.app.name || hit.app.slug)) || String(label || "?");
  return placeholderArt((cr && cr.appId) || ref || label, name);
}
