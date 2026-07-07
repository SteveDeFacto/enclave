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
   template text so NanElement renders synchronously and never fetches. */
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

console.log("[build] tailwind css/src/main.css -> css/site.css");
execFileSync("npx", ["@tailwindcss/cli", "-i", "site/css/src/main.css", "-o", "site/css/site.css", "--minify"],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
fs.copyFileSync(path.join(SITE, "css/site.css"), path.join(DIST, "css/site.css"));

console.log("[build] esbuild pages (bundle + split + minify, templates inlined)");
const result = await build({
  entryPoints: ["overview", "deploy", "apps", "develop"].map(p => path.join(SITE, "js/pages", p + ".js")),
  bundle: true,
  splitting: true,                            // shared core+components -> common chunks
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  outdir: DIST,
  outbase: SITE,                              // js/pages/<page>.js keeps its path: HTML needs no rewrite
  chunkNames: "js/chunks/[name]-[hash]",
  external: ["https://*"],                    // esm.sh dynamic imports (privy sdk, tinfoil verifier) stay runtime
  plugins: [inlineTemplates],
  metafile: true,
});

console.log("[build] copy pages + static files");
for (const f of ["index.html", "deploy.html", "apps.html", "develop.html", "buy.html", "openapi.json"])
  fs.copyFileSync(path.join(SITE, f), path.join(DIST, f));
for (const d of ["assets", "privy"])
  fs.cpSync(path.join(SITE, d), path.join(DIST, d), { recursive: true });

/* size report */
const out = Object.entries(result.metafile.outputs)
  .filter(([f]) => f.endsWith(".js"))
  .map(([f, o]) => "  " + (o.bytes / 1024).toFixed(1).padStart(7) + " KB  " + path.relative(SITE, path.resolve(ROOT, f)));
const total = (fileCount, dir) => { let n = 0, b = 0; for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { n++; b += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } return `${n} files · ${(b / 1024 / 1024).toFixed(1)} MB`; };
console.log(out.join("\n"));
console.log("[build] dist/: " + total(0, DIST));
