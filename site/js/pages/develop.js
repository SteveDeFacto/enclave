/* ============================================================
   Develop page — sub-tabs (Guide | CLI | API reference) and the
   guide's chapter scroll-spy. The reference itself is
   <c-api-reference>; code blocks in the guide/CLI are
   <c-code> components (which own their copy buttons).
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/code/code.js";
import "../../components/api-reference/api-reference.js";
import { $, $$ } from "../core/util.js";
import { downloadSpec } from "../../components/footer/footer.js";

/* ============================================================
   Guide chapter scroll-spy
   ============================================================ */
function initDocs(){
  const sec = $("#docs"); if (!sec) return;
  const links = $$(".docs-nav a", sec);
  const byEl = new Map();
  links.forEach(a => {
    const el = document.getElementById((a.getAttribute("href") || "").slice(1));
    if (el) byEl.set(el, a);
  });
  if (!("IntersectionObserver" in window) || !byEl.size) return;
  const spy = new IntersectionObserver((entries) => {
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
let devTab = "guide";                                        // develop sub-tab: guide | cli | api
const DEV_PANES = { guide: "docs", cli: "cli", api: "api" }; // tab -> pane section id
function devTabOf(id){                                       // which sub-tab holds this element?
  const el = id && document.getElementById(id); if (!el || !el.closest) return null;
  if (el.closest("#api")) return "api";
  if (el.closest("#cli")) return "cli";
  if (el.closest("#docs")) return "guide";
  return null;
}
function setDevTab(tab){
  devTab = tab;
  Object.entries(DEV_PANES).forEach(([t, id]) => { const s = document.getElementById(id); if (s) s.hidden = t !== tab; });
  $$("#devTabs a").forEach(a => a.classList.toggle("on", a.dataset.devtab === tab));
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
  try { history.replaceState(null, "", "#" + (id || DEV_PANES[tab])); } catch(e){}
}
function initDevTabs(){
  // in-page anchor navigation switches panes as needed (the old single-page
  // router's develop half, scoped to this page)
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]'); if (!a) return;
    const href = a.getAttribute("href"); if (!href || href.length < 2) return;
    e.preventDefault();
    gotoAnchor(href.slice(1), true);
  });
  const id0 = (location.hash || "").slice(1);
  gotoAnchor(id0 || "docs");
}

/* ============================================================
   boot
   ============================================================ */
const run = (fn) => { try { fn(); } catch (e) { console.warn("[develop] " + (fn.name || "step") + " failed:", e); } };
run(initDocs);
run(initDevTabs);   // pane visibility + guide anchors work before the spec arrives
const dl = $("#dlSpec"); if (dl) dl.addEventListener("click", downloadSpec);

// a deep link into the reference (#op-… / #grp-…) only resolves once
// <c-api-reference> has rendered the operations
document.addEventListener("nan:api-rendered", () => {
  const id0 = (location.hash || "").slice(1);
  if (id0 && (id0.startsWith("op-") || id0.startsWith("grp-"))) run(() => gotoAnchor(id0));
});
