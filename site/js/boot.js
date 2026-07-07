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
  apps:      () => import("./pages/apps.js"),      // also hosts #publish and #deploy (deploy.js is its lazy chunk)
  develop:   () => import("./pages/develop.js"),
  dashboard: () => import("./pages/dashboard.js"), // signed-in view: run log + My Apps
};
const pageOf = (pathname) => {
  const base = pathname.split("/").pop() || "index.html";
  const name = base.replace(/\.html$/, "");
  return name === "" || name === "index" ? "overview" : (PAGES[name] ? name : null);
};

const docCache = new Map();   // url pathname -> html text (warmed in idle time)

async function fetchPage(url) {
  const key = url.pathname;
  if (docCache.has(key)) return docCache.get(key);
  const r = await fetch(url.pathname + url.search, { headers: { "Accept": "text/html" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const t = await r.text();
  docCache.set(key, t);
  return t;
}

async function bootPage(page) {
  const m = await PAGES[page]();
  if (typeof m.boot === "function") m.boot();
}

function swapFrom(doc) {
  const next = document.adoptNode(doc.querySelector("main"));
  document.querySelector("main").replaceWith(next);          // custom elements upgrade + hydrate on connect
  document.title = doc.title;
}

let navSeq = 0;
// the page currently RENDERED — not `location`, which a popstate has already
// moved to the destination before our handler runs
let current = { pathname: location.pathname, search: location.search };

export async function navigate(href, opts) {
  opts = opts || {};
  const url = new URL(href, location.href);
  const page = pageOf(url.pathname);
  if (!page) { location.href = href; return; }               // not one of ours: hard nav

  // already rendered: just handle the fragment
  if (url.pathname === current.pathname && url.search === current.search) {
    const prev = location.href;
    if (opts.push) history.pushState({ scroll: 0 }, "", url);
    if (opts.scroll != null) scrollTo(0, opts.scroll);
    else scrollToTarget(url.hash);
    if (location.href !== prev)                   // pushState never fires hashchange itself;
      dispatchEvent(new HashChangeEvent("hashchange", { oldURL: prev, newURL: location.href }));
    return;                                       // pages with hash-routed views need the signal
  }

  const seq = ++navSeq;
  let html;
  try { html = await fetchPage(url); }
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
    if (hdr) hdr.current = page;                             // hydrated header just re-toggles the active tab
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
    const path = p === "overview" ? "index.html" : p + ".html";
    if (pageOf(location.pathname) !== p)
      fetchPage(new URL(path, location.href)).catch(() => {});
  }
}, 1500);
