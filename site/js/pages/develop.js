/* ============================================================
   Develop page - sub-tabs (Guide | CLI | API reference) and the
   guide's chapter scroll-spy. The reference itself is
   <c-api-reference>; code blocks in the guide/CLI are
   <c-code> components (which own their copy buttons).
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/code/code.js";
import "../../components/code-tabs/code-tabs.js";
import "../../components/api-reference/api-reference.js";
import { $, $$ } from "../core/util.js";
import { downloadSpec } from "../../components/footer/footer.js";
import { hydrateLivePrices } from "../core/live-prices.js";
import { hydrateLiveSpecs } from "../core/live-specs.js";

/* ============================================================
   Guide chapter scroll-spy
   ============================================================ */
let spy = null;
function initDocs(){
  const sec = $("#docs"); if (!sec) return;
  if (spy) spy.disconnect();                       // fresh <main> per router entry: re-observe the new nodes
  const links = $$(".docs-nav a", sec);
  const byEl = new Map();
  links.forEach(a => {
    const el = document.getElementById((a.getAttribute("href") || "").slice(1));
    if (el) byEl.set(el, a);
  });
  if (!("IntersectionObserver" in window) || !byEl.size) return;
  spy = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      links.forEach(l => l.classList.remove("on"));
      const a = byEl.get(en.target); if (a) a.classList.add("on");
    });
  }, { rootMargin: "-15% 0px -75% 0px" });
  byEl.forEach((_a, el) => spy.observe(el));
}

/* ============================================================
   Sub-tabs: Guide | CLI | API reference (all on this page; the
   tab bar switches which pane section is visible)
   ============================================================ */
let devTab = "guide";                                        // develop sub-tab: guide | cli | mcp | api
const DEV_PANES = { guide: "docs", cli: "cli", mcp: "mcp", api: "api" }; // tab -> pane section id
function devTabOf(id){                                       // which sub-tab holds this element?
  const el = id && document.getElementById(id); if (!el || !el.closest) return null;
  if (el.closest("#api")) return "api";
  if (el.closest("#mcp")) return "mcp";
  if (el.closest("#cli")) return "cli";
  if (el.closest("#docs")) return "guide";
  return null;
}
function setDevTab(tab){
  devTab = tab;
  Object.entries(DEV_PANES).forEach(([t, id]) => { const s = document.getElementById(id); if (s) s.hidden = t !== tab; });
  $$("#devTabs a").forEach(a => {
    const on = a.dataset.devtab === tab;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
  });
}
function gotoAnchor(id, smooth){
  const tab = devTabOf(id) || devTab;
  setDevTab(tab);
  const paneAnchor = !id || id === DEV_PANES[tab] || id === "develop";
  if (!paneAnchor){
    const el = document.getElementById(id);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }
  else if (window.scrollTo) window.scrollTo({ top: 0, behavior: "auto" });   // pane anchors land at the top, tab bar in view
  // the default Guide pane keeps the URL clean (develop.html, no #docs);
  // other panes and deep anchors stay in the hash so they survive a reload
  const frag = id || DEV_PANES[tab];
  const clean = frag === DEV_PANES.guide || frag === "develop";
  // NOTE: history URLs resolve against document.baseURI - and the router pins
  // <base> to the SITE ROOT, so a bare "#frag" would wipe the pathname
  // (/develop#x became /#x). Anchor the fragment to the current path.
  try { history.replaceState(null, "", location.pathname + location.search + (clean ? "" : "#" + frag)); } catch(e){}
}
/* ============================================================
   boot - module-load-once listeners are guarded on #devTabs so
   they're inert while another page's <main> is mounted (the
   soft-nav router keeps this document alive across pages).
   ============================================================ */
const run = (fn) => { try { fn(); } catch (e) { console.warn("[develop] " + (fn.name || "step") + " failed:", e); } };

// in-page anchor navigation switches panes as needed (the old single-page
// router's develop half). The soft-nav router ignores '#' hrefs, so there's
// no double handling.
document.addEventListener("click", (e) => {
  if (!document.getElementById("devTabs")) return;   // not on the develop page right now
  const a = e.target.closest('a[href^="#"]'); if (!a) return;
  const href = a.getAttribute("href"); if (!href || href.length < 2) return;
  e.preventDefault();
  gotoAnchor(href.slice(1), true);
});

// a deep link into the reference (#op-… / #grp-…) only resolves once
// <c-api-reference> has rendered the operations
document.addEventListener("enclave:api-rendered", () => {
  if (!document.getElementById("devTabs")) return;
  const id0 = (location.hash || "").slice(1);
  if (id0 && (id0.startsWith("op-") || id0.startsWith("grp-"))) run(() => gotoAnchor(id0));
});

/* called by the router every time this page's <main> is swapped in */
export function boot() {
  run(initDocs);
  run(() => gotoAnchor((location.hash || "").slice(1) || "docs"));   // pane visibility before the spec arrives
  run(hydrateLivePrices);   // the docs quote real $/hr rates - refresh them from the contract
  run(hydrateLiveSpecs);    // …and real fleet hardware - refresh it from /availability
  // #dlSpec is a real <a href="openapi.json" download> (no-JS fallback); JS serves the freshly loaded spec instead
  const dl = $("#dlSpec"); if (dl) dl.addEventListener("click", e => { e.preventDefault(); downloadSpec(); });
}
