#!/usr/bin/env node
/* ============================================================
   Same-origin vendor bundles — vendors the two third-party
   ESM deps that the site used to hot-load from esm.sh at
   RUNTIME into self-hosted, integrity-controlled bundles under
   site/vendor/. No CDN at runtime.

   Why this matters (trust product): the attestation verifier is
   the "✓ verify it yourself in your browser" claim — the whole
   product rests on it. Loaded from esm.sh with no SRI, a
   compromised (or coerced) CDN could return code that reports
   verified:true for anything. Same story for the Privy SDK
   (an unpinned esm.sh import in the wallet path). Bundling them
   same-origin removes the un-SRI'd third-party CDN from the TCB;
   the bytes are now covered by the site's own IPFS pin +
   Caddy TLS, and pinned by version here.

     • site/vendor/verifier.js   -> @tinfoilsh/verifier (used by
       site/js/core/verify.js). Its one Node-builtin use,
       `await import('zlib')` for gunzipSync, is aliased to the
       pure-JS synchronous fflate implementation for the browser.
     • site/vendor/privy-core.js -> @privy-io/js-sdk-core (used by
       site/js/core/wallet.js, the email-wallet fallback).

   buy.html's Privy REACT bundle is a SEPARATE artifact
   (scripts/build-privy.mjs -> site/privy/); this is the smaller
   js-sdk-core used by the main wallet path, kept apart so the
   two never entangle.

   Deps install into scripts/.vendor-build/ (gitignored), pinned
   below; bump the pins and re-run to upgrade. The output
   site/vendor/ IS committed (same policy as site/privy/).

     node scripts/build-vendor.mjs
   ============================================================ */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORK = path.join(ROOT, "scripts", ".vendor-build");
const OUT = path.join(ROOT, "site", "vendor");

// Pinned. verifier MUST match the version site/js/core/verify.js expects; the
// Privy pin closes the old version-UNPINNED esm.sh import in wallet.js.
const DEPS = {
  "@tinfoilsh/verifier": "1.1.10",   // 1.1.9+ is Apache-2.0 (≤1.1.8 was AGPL — a license conflict with ours; keep ≥1.1.9)
  "@privy-io/js-sdk-core": "0.68.2",
  "fflate": "0.8.2",           // browser gunzipSync shim for the verifier's zlib use
  "jsqr": "1.4.0",             // QR decode fallback for the Send-USDC camera scan
                               // (wallet.js lazy-imports /vendor/jsqr.js when the
                               // browser's BarcodeDetector can't do qr_code, e.g.
                               // desktop Linux and Firefox). Apache-2.0.
};

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({
  name: "vendor-bundle-build", private: true, dependencies: DEPS,
}, null, 2));
console.log("[vendor] npm install (pinned deps)");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"],
  { cwd: WORK, stdio: ["ignore", "inherit", "inherit"] });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const nm = (p) => path.join(WORK, "node_modules", p);
const shared = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "global": "globalThis" },
  logLevel: "warning",
};

console.log("[vendor] esbuild @tinfoilsh/verifier -> site/vendor/verifier.js");
await build({
  ...shared,
  entryPoints: [nm("@tinfoilsh/verifier")],
  outfile: path.join(OUT, "verifier.js"),
  // the verifier's only Node builtin: `await import('zlib')` for gunzipSync.
  // fflate provides a byte-compatible synchronous gunzipSync in pure JS.
  alias: { zlib: nm("fflate/esm/browser.js") },
});

console.log("[vendor] esbuild @privy-io/js-sdk-core -> site/vendor/privy-core.js");
await build({
  ...shared,
  entryPoints: [nm("@privy-io/js-sdk-core")],
  outfile: path.join(OUT, "privy-core.js"),
});

console.log("[vendor] esbuild jsqr -> site/vendor/jsqr.js");
// jsqr ships CJS; the wrapper pins the ESM shape to a default export so the
// caller's `(await import("/vendor/jsqr.js")).default` can never drift
fs.writeFileSync(path.join(WORK, "jsqr-entry.js"),
  'import jsQR from "jsqr";\nexport default jsQR;\n');
await build({
  ...shared,
  entryPoints: [path.join(WORK, "jsqr-entry.js")],
  outfile: path.join(OUT, "jsqr.js"),
});

// Fail loud if an upgrade ever drops an export the callers destructure, so a
// broken bundle can never ship silently to the verify/wallet paths.
const must = [
  ["verifier.js", ["Verifier", "assembleAttestationBundle"]],
  ["privy-core.js", ["LocalStorage", "default"]],
  ["jsqr.js", ["default"]],
];
for (const [file, names] of must) {
  const src = fs.readFileSync(path.join(OUT, file), "utf8");
  const exp = (src.match(/export\{[^}]*\}/g) || []).join(",");
  const missing = names.filter((n) => !new RegExp(`as ${n}\\b`).test(exp) && !new RegExp(`\\b${n} as`).test(exp));
  if (missing.length) throw new Error(`${file}: bundle is missing expected export(s): ${missing.join(", ")}`);
  console.log(`[vendor] ${file}: ${fs.statSync(path.join(OUT, file)).size} bytes, exports OK ✓`);
}
