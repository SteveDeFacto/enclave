#!/usr/bin/env node
/* ============================================================
   Site bundler — turns the browser-native source tree (site/)
   into a deployable bundle (site/dist/):

     • Tailwind compiles css/src/main.css  -> css/site.css
       (kept in site/ too, so serving site/ raw still works in dev)
     • esbuild bundles the four page modules with code splitting:
       shared core + components land in hashed js/chunks/*, the
       entry names stay stable so the HTML never changes
     • every component's paired .html template is INLINED into
       its class at build time (static _tpl = "…"), so production
       pages make zero template fetches and the header exists at
       first paint without the sessionStorage warm-up
     • pages, openapi.json, assets/, privy/ are copied through

   Dev flow is unchanged: site/ itself is valid, unbundled ES
   modules — serve it directly and templates load via fetch.
   Deploy ships dist/ (see site/deploy.sh).
   ============================================================ */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SITE = path.join(ROOT, "site");
const DIST = path.join(SITE, "dist");

/* inline each component's .html template into its js: the source keeps the
   LWC-style `static templateUrl = new URL("./x.html", import.meta.url)`
   pairing (fetched at runtime in dev); the bundle replaces it with the
   template text so EnclaveElement renders synchronously and never fetches. */
const inlineTemplates = {
  name: "inline-templates",
  setup(b) {
    b.onLoad({ filter: /[\\/]components[\\/][^\\/]+[\\/][^\\/]+\.js$/ }, async (args) => {
      let src = await fs.promises.readFile(args.path, "utf8");
      src = src.replace(
        /static templateUrl = new URL\("\.\/([\w.-]+\.html)", import\.meta\.url\);/g,
        (_, name) => {
          const tpl = fs.readFileSync(path.join(path.dirname(args.path), name), "utf8");
          return `static _tpl = ${JSON.stringify(tpl)};`;
        });
      if (src.includes("templateUrl = new URL"))
        throw new Error(args.path + ": template pattern not inlined (unexpected shape)");
      return { contents: src, loader: "js" };
    });
  },
};

console.log("[build] clean dist/");
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "css"), { recursive: true });

console.log("[build] contract artifacts (admin console deploy bytecode + selectors)");
execFileSync("node", [path.join(ROOT, "scripts", "build-contract-artifacts.mjs")],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });

console.log("[build] tailwind css/src/main.css -> css/site.css");
execFileSync("npx", ["@tailwindcss/cli", "-i", "site/css/src/main.css", "-o", "site/css/site.css", "--minify"],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
fs.copyFileSync(path.join(SITE, "css/site.css"), path.join(DIST, "css/site.css"));

console.log("[build] esbuild (router entry + code-split pages, templates inlined)");
const result = await build({
  entryPoints: [path.join(SITE, "js/boot.js")],   // the soft-nav router dynamic-imports each page module
  bundle: true,
  splitting: true,                            // each page + shared core/components -> chunks
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  outdir: DIST,
  outbase: SITE,                              // js/boot.js keeps its path: HTML needs no rewrite
  chunkNames: "js/chunks/[name]-[hash]",
  external: ["https://*"],                    // esm.sh dynamic imports (privy sdk, tinfoil verifier) stay runtime
  plugins: [inlineTemplates],
  metafile: true,
});

/* ---- build-time prerender ("SSR") ----
   Expand every <c-*> element in the page HTML using its component template:
   {attr} bindings substituted, <slot> replaced by the authored children,
   nested components expanded recursively, and the host marked data-ssr so
   EnclaveElement HYDRATES (wires events, fills async data) instead of
   re-rendering. Result: the header and all static chrome are plain HTML —
   visible at first paint even before (or without) any JavaScript. */
const TPL = {};
for (const n of fs.readdirSync(path.join(SITE, "components"))) {
  const f = path.join(SITE, "components", n, n + ".html");
  if (fs.existsSync(f)) TPL[n] = fs.readFileSync(f, "utf8").trim();
}
/* Painted inline right after the baked header, DURING parse (before first
   paint): if a wallet session exists in localStorage, render the button's
   exact final connected state. Without this, a signed-in user sees the
   static "Sign in →" flash through the header on every navigation until
   hydration + the wallet round-trip (~300ms with MetaMask) restores it. */
const WALLET_PAINT = `<script>(function(){try{
var s=JSON.parse(localStorage.getItem("enclave_session")||"null");if(!s||!s.address)return;
var dt=document.querySelector('.nav-links a[data-view="dashboard"]');if(dt)dt.hidden=false;
var who=s.email?(s.email.length>24?s.email.slice(0,21)+"…":s.email):(s.address.slice(0,6)+"…"+s.address.slice(-4));
var b=document.getElementById("walletBtn");if(!b)return;
b.classList.add("connected");b.textContent="";
var d=document.createElement("span");d.className="wdot";b.appendChild(d);
b.appendChild(document.createTextNode(who));
b.dataset.painted="1";
}catch(e){}})();</script>`;

/* deploy-skew self-heal: for ~5 min after a deploy the DNSLink edges serve
   MIXED trees - a fresh page can reference chunk hashes an edge hasn't
   converged on yet (new chunks can't ride the union archive backwards), so a
   module 404s and the page half-dies until "it randomly works again". Catch
   both failure shapes (static <script>/<link> load errors at capture;
   dynamic import() rejections via unhandledrejection) and schedule ONE
   guarded reload - by then the edge has almost always converged. */
const SKEW_HEAL = `<script>(function(){
var heal=function(){try{
  var k="enclave_skew_reload",last=+sessionStorage.getItem(k)||0;
  if(Date.now()-last<240000)return;
  sessionStorage.setItem(k,String(Date.now()));
  setTimeout(function(){location.reload();},8000);
}catch(e){}};
addEventListener("error",function(e){
  var t=e.target;
  if(t&&(t.tagName==="SCRIPT"||(t.tagName==="LINK"&&t.rel==="modulepreload")))heal();
},true);
addEventListener("unhandledrejection",function(e){
  if(/dynamically imported module|Failed to fetch|error loading/i.test(String(e.reason)))heal();
});
})();</script>`;

function bake(html) {
  let pos = 0, guard = 0;
  while (guard++ < 2000) {
    const idx = html.indexOf("<c-", pos);
    if (idx === -1) break;
    const tagEnd = html.indexOf(">", idx);
    const open = html.slice(idx, tagEnd + 1);
    const name = /^<c-([a-z-]+)/.exec(open)[1];
    const attrStr = open.slice(3 + name.length, -1);
    if (attrStr.includes("data-ssr") || !TPL[name]) { pos = idx + 3; continue; }
    const close = "</c-" + name + ">";
    const end = html.indexOf(close, tagEnd + 1);
    if (end === -1) throw new Error("unclosed <c-" + name + ">");
    const inner = html.slice(tagEnd + 1, end);
    const attrs = {};
    for (const m of attrStr.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] ?? "";
    let out = TPL[name];
    for (const [k, v] of Object.entries(attrs)) out = out.split("{" + k + "}").join(v);
    out = out.replace("<slot></slot>", inner.trim());
    if (name === "header" && attrs.current)   // the active-tab class the component toggles at runtime
      out = out.replace(`data-view="${attrs.current}"`, `data-view="${attrs.current}" class="active"`);
    html = html.slice(0, idx) + `<c-${name}${attrStr} data-ssr>` + out + close + html.slice(end + close.length);
    // don't advance: re-scan from here so components nested inside the
    // expansion (e.g. <c-wallet-button> in the header) get baked too
    pos = idx;
  }
  if (guard >= 2000) throw new Error("bake(): runaway expansion");
  html = html.replace("</c-header>", "</c-header>\n" + WALLET_PAINT);
  return html;
}

console.log("[build] copy pages (components prerendered) + static files");
/* preload the module graph each page actually needs at load: the router
   entry + its static chunks, plus that page's own code-split chunk (a
   dynamic import esbuild can't see from the HTML) */
const outs = result.metafile.outputs;
const chunksOf = (outFile, seen = new Set()) => {
  seen.add(outFile);
  for (const imp of (outs[outFile]?.imports || [])) {
    if (imp.kind !== "import-statement" || seen.has(imp.path)) continue;
    chunksOf(imp.path, seen);
  }
  return seen;
};
const bootOut = Object.keys(outs).find(f => outs[f].entryPoint && outs[f].entryPoint.endsWith("js/boot.js"));
const PAGE_HTML = { overview: "index.html", apps: "apps.html", develop: "develop.html", dashboard: "dashboard.html", admin: "admin.html" };   // deploy.html is a redirect stub now
const preloads = {};
for (const [outFile, o] of Object.entries(outs)) {
  const page = o.entryPoint && /js[\\/]pages[\\/](\w+)\.js$/.exec(o.entryPoint)?.[1];
  if (!page) continue;
  const files = new Set([...chunksOf(bootOut), ...chunksOf(outFile)]);
  files.delete(bootOut);                       // the <script src> itself needs no preload
  preloads[PAGE_HTML[page]] = [...files]
    .map(c => `<link rel="modulepreload" href="${path.relative(DIST, path.resolve(ROOT, c)).replace(/\\/g, "/")}" />`).join("\n");
}
for (const f of ["index.html", "deploy.html", "apps.html", "develop.html", "dashboard.html", "admin.html", "buy.html", "openapi.json"]) {
  let s = fs.readFileSync(path.join(SITE, f), "utf8");
  if (f.endsWith(".html") && f !== "buy.html") {
    s = bake(s);
    // components are prerendered, so first paint is already the final layout:
    // rendering must NOT wait for the script (that wait was visible on cold,
    // slow fetches — a header-less page until JS arrived)
    s = s.replace(' blocking="render"', "");
  }
  if (preloads[f]) s = s.replace('<script type="module" src="js/boot.js">', preloads[f] + '\n<script type="module" src="js/boot.js">');
  // buy.html ships RAW - byte-identical to source. Its only import is the
  // stable-named /privy/entry.js (no hashed chunks -> no skew to heal), and
  // SKEW_HEAL's reload-on-"Failed to fetch" is fatal mid-checkout: an
  // ad-blocked Stripe telemetry fetch rejects with exactly that message and
  // the watcher would reload the popup 8s later, killing the session.
  if (f.endsWith(".html") && f !== "buy.html") s = s.replace("<head>", "<head>\n" + SKEW_HEAL);   // must be first: it watches every later load
  fs.writeFileSync(path.join(DIST, f), s);
}
for (const d of ["assets", "privy", ".well-known"])
  fs.cpSync(path.join(SITE, d), path.join(DIST, d), { recursive: true });
// pretty URLs: the gateway's rewrite rules ride the pin itself
fs.copyFileSync(path.join(SITE, "_redirects"), path.join(DIST, "_redirects"));
// Google's favicon crawler needs a fetchable file, and legacy fetchers ask
// for /favicon.ico blindly - it must exist at the site root
fs.copyFileSync(path.join(SITE, "favicon.ico"), path.join(DIST, "favicon.ico"));
/* nested console/form URLs (/apps/deploy, /apps/publish): the SAME apps
   document one directory deep, with <base href="../"> injected so its
   relative asset/link URLs still resolve from the site root. The base is
   itself RELATIVE, so path-gateway subpath mounts keep working; the router
   reads document.baseURI, so it always knows the real root. */
fs.mkdirSync(path.join(DIST, "apps"), { recursive: true });
const appsNested = fs.readFileSync(path.join(DIST, "apps.html"), "utf8")
  .replace("<head>", '<head>\n<base href="../" />');
for (const v of ["deploy", "publish"])
  fs.writeFileSync(path.join(DIST, "apps", v + ".html"), appsNested);
// the apps/ DIRECTORY now exists in the DAG, which SHADOWS the /apps ->
// /apps.html rewrite (_redirects only fires for absent paths): give the
// directory an index so /apps resolves to the store, not a gateway listing
fs.writeFileSync(path.join(DIST, "apps", "index.html"), appsNested);

/* size report */
const out = Object.entries(result.metafile.outputs)
  .filter(([f]) => f.endsWith(".js"))
  .map(([f, o]) => "  " + (o.bytes / 1024).toFixed(1).padStart(7) + " KB  " + path.relative(SITE, path.resolve(ROOT, f)));
const total = (fileCount, dir) => { let n = 0, b = 0; for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { n++; b += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } return `${n} files · ${(b / 1024 / 1024).toFixed(1)} MB`; };
console.log(out.join("\n"));
console.log("[build] dist/: " + total(0, DIST));
