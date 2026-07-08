/* ============================================================
   Soft-navigation router. Full-document navigations can't be
   made seamless when an extension injects content scripts
   (Chromium skips cross-document view transitions and may swap
   processes — MetaMask users saw every navigation flash), so
   internal navigation never leaves the document:

     click → fetch the page → document.startViewTransition(swap
     <main> + title) → import + boot that page's module

   The header, footer, toast, and wallet state are THE SAME live
   DOM nodes across all navigation — nothing to reload, nothing
   to flash. Same-document view transitions are a plain DOM API,
   immune to the extension limitation; browsers without support
   just swap instantly (the document never unloads, so there's
   still no flash). Hard navigations (external entry, failures)
   keep working — every page stays a complete document.
   ============================================================ */

import "./core/addressbook.js";   // resolve contract addresses from the on-chain book (no-op until one is configured)

const PAGES = {
  overview:  () => import("./pages/overview.js"),
  apps:      () => import("./pages/apps.js"),      // also hosts #publish and the deploy console (deploy.js is its lazy chunk)
  develop:   () => import("./pages/develop.js"),
  dashboard: () => import("./pages/dashboard.js"), // signed-in view: run log + My Apps
  admin:     () => import("./pages/admin.js"),     // operator console — deliberately absent from the nav
};
// URL aliases: pathnames that render ANOTHER page's document. /deploy and
// /publish are the canonical console/form URLs (share links read
// /deploy?app=hello-world_1.0.0), but both stay views of the Apps page -
// apps.js's applyView picks the view from the pathname.
const PAGE_ALIAS = { deploy: "apps", publish: "apps" };
const pageOf = (pathname) => {
  const base = pathname.split("/").pop() || "index.html";
  const name = base.replace(/\.html$/, "");
  return name === "" || name === "index" ? "overview" : ((PAGES[name] || PAGE_ALIAS[name]) ? name : null);
};
// Pretty URLs: the address bar shows extensionless paths (/apps, /dashboard) —
// hard loads of those are rewritten by the gateway's _redirects (site/_redirects,
// DNSLink/subdomain IPFS hosts) — while the router always FETCHES the real
// .html file, so soft navigation needs no rewrite support at all (raw dev
// servers, path gateways). Paths stay relative to wherever the site is
// mounted: /dashboard on enclave.host, /ipns/<key>/dashboard on a path gateway.
const dirOf = (pathname) => pathname.replace(/[^/]*$/, "");
const prettyPath = (page, refPathname) => dirOf(refPathname) + (page === "overview" ? "" : page);
const htmlName = (page) => {
  const file = PAGE_ALIAS[page] || page;                     // an alias serves its target's document
  return file === "overview" ? "index.html" : file + ".html";
};

const docCache = new Map();   // html file name -> text (warmed in idle time; aliases share their target's entry)

async function fetchPage(page) {
  const key = htmlName(page);
  if (docCache.has(key)) return docCache.get(key);
  const r = await fetch(dirOf(location.pathname) + key, { headers: { "Accept": "text/html" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const t = await r.text();
  docCache.set(key, t);
  return t;
}

async function bootPage(page) {
  const m = await PAGES[PAGE_ALIAS[page] || page]();
  if (typeof m.boot === "function") m.boot();
}

function swapFrom(doc) {
  const next = document.adoptNode(doc.querySelector("main"));
  document.querySelector("main").replaceWith(next);          // custom elements upgrade + hydrate on connect
  document.title = doc.title;
}

let navSeq = 0;
// canonicalize a .html entry in place (no reload): the file loaded, the bar
// shows the pretty path — /dashboard.html -> /dashboard
{
  const entry = pageOf(location.pathname);
  const pp = entry && prettyPath(entry, location.pathname);
  if (pp && pp !== location.pathname)
    history.replaceState(history.state, "", pp + location.search + location.hash);
}
// the page currently RENDERED — not `location`, which a popstate has already
// moved to the destination before our handler runs
let current = { pathname: location.pathname, search: location.search };

export async function navigate(href, opts) {
  opts = opts || {};
  const url = new URL(href, location.href);
  const page = pageOf(url.pathname);
  if (!page) { location.href = href; return; }               // not one of ours: hard nav
  url.pathname = prettyPath(page, url.pathname);             // the bar always shows the pretty form

  // already rendered - same document, maybe a different sub-view: an alias
  // and its target (apps ↔ deploy/publish) share one <main>, so the flip is
  // just a URL push + the view signal; no fetch, no swap. Same search only:
  // a new ?app= must re-boot the page so its prefill logic runs.
  const curPage = pageOf(current.pathname);
  if (curPage && (PAGE_ALIAS[page] || page) === (PAGE_ALIAS[curPage] || curPage) && url.search === current.search) {
    const prev = location.href;
    if (opts.push) history.pushState({ scroll: 0 }, "", url);
    current = { pathname: location.pathname, search: location.search };
    if (opts.scroll != null) scrollTo(0, opts.scroll);
    else scrollToTarget(url.hash);
    if (location.href !== prev || opts.push === false)   // pushState never fires hashchange itself;
      dispatchEvent(new HashChangeEvent("hashchange", { oldURL: prev, newURL: location.href }));
    return;                                       // pages with view routing need the signal (popstate included)
  }

  const seq = ++navSeq;
  let html;
  try { html = await fetchPage(page); }
  catch (e) { location.href = href; return; }                // network trouble: fall back to a hard nav
  if (seq !== navSeq) return;                                // superseded by a newer navigation

  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.querySelector("main")) { location.href = href; return; }

  if (opts.push !== false) {
    history.replaceState({ scroll: scrollY }, "");           // remember where we were for Back
    history.pushState({ scroll: 0 }, "", url);
  }

  const apply = () => {
    swapFrom(doc);
    current = { pathname: url.pathname, search: url.search };
    const hdr = document.querySelector("c-header");
    if (hdr) hdr.current = PAGE_ALIAS[page] || page;         // hydrated header just re-toggles the active tab (aliases light their target's)
  };
  if (document.startViewTransition) {
    try { await document.startViewTransition(apply).updateCallbackDone; } catch (e) { apply(); }
  } else apply();

  await bootPage(page);
  if (opts.scroll != null) scrollTo(0, opts.scroll);
  else scrollToTarget(url.hash);
}

function scrollToTarget(hash) {
  const el = hash && document.getElementById(hash.slice(1));
  if (el) el.scrollIntoView({ block: "start" });
  else scrollTo(0, 0);
}

/* intercept plain left-clicks on internal page links */
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a || a.target || a.hasAttribute("download")) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#")) return;               // in-page anchors (the develop page handles its own)
  const url = new URL(href, location.href);
  if (url.origin !== location.origin || !pageOf(url.pathname)) return;
  e.preventDefault();
  navigate(href, { push: true });
});

/* back/forward stay soft too */
addEventListener("popstate", (e) => {
  navigate(location.href, { push: false, scroll: e.state && e.state.scroll });
});

/* boot the page we loaded on, then warm the other pages' HTML in idle time
   so soft navigations are instant even on a cold, slow gateway */
const initial = pageOf(location.pathname) || "overview";
bootPage(initial);
setTimeout(() => {
  for (const p of Object.keys(PAGES)) {
    if (p === "admin") continue;                 // nobody navigates there by accident — don't warm it
    if (initial !== p) fetchPage(p).catch(() => {});
  }
}, 1500);
