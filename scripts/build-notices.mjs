#!/usr/bin/env node
/* ============================================================
   Third-party attribution — generates THIRD-PARTY-NOTICES.md.

   Why: the artifacts we DISTRIBUTE embed permissively-licensed
   code whose licenses (MIT/ISC/BSD/Apache-2.0) require the
   copyright + permission notices to travel with copies, and
   esbuild's minification strips them from the shipped bundles.
   This file is that notice: per-package copyright lines (+ any
   Apache NOTICE contents), then one canonical text per license
   family — the standard compact form (grouping per-package
   copyright lines over one license text satisfies MIT/BSD/ISC;
   Apache additionally wants NOTICE contents, included inline).

   Covered trees (the distributed surfaces):
     • root production deps    -> supervisor/CLI (enclave images,
       installer builds)             [package-lock, dev filtered]
     • scripts/.vendor-build/  -> site/vendor bundles
   The .vendor-build tree is a gitignored npm workdir; run its
   builder first if missing (build-vendor.mjs).

   Re-run after ANY dependency or pin change:
     node scripts/build-notices.mjs
   ============================================================ */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "THIRD-PARTY-NOTICES.md");

// name@version -> { license, copyrights: [..], notice } (first sighting wins;
// the same package vendored twice carries the same license text)
const pkgs = new Map();

function licenseFileOf(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(f) && fs.statSync(path.join(dir, f)).isFile()) {
      if (/^notice/i.test(f)) continue;   // NOTICE handled separately
      return path.join(dir, f);
    }
  }
  return null;
}
function noticeFileOf(dir) {
  for (const f of fs.readdirSync(dir))
    if (/^notice(\.|$)/i.test(f) && fs.statSync(path.join(dir, f)).isFile()) return path.join(dir, f);
  return null;
}

function addPackage(dir) {
  let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { return; }
  if (!p.name || !p.version) return;
  const key = `${p.name}@${p.version}`;
  if (pkgs.has(key)) return;
  let license = p.license || (Array.isArray(p.licenses) && p.licenses[0]?.type) || "UNKNOWN";
  if (typeof license === "object") license = license.type || "UNKNOWN";
  const copyrights = [];
  const lf = licenseFileOf(dir);
  if (lf) for (const line of fs.readFileSync(lf, "utf8").split("\n"))
    if (/^\s*(\(c\)\s*)?copyright/i.test(line) && copyrights.length < 4) copyrights.push(line.trim());
  if (!copyrights.length && p.author)
    copyrights.push(`Copyright (c) ${typeof p.author === "string" ? p.author : p.author.name || ""}`.trim());
  const nf = noticeFileOf(dir);
  const notice = nf ? fs.readFileSync(nf, "utf8").trim() : null;
  pkgs.set(key, { license, copyrights, notice, licenseFile: lf });
}

// walk one node_modules tree; `keep` filters by the package's node_modules-relative path
function walkTree(nmDir, keep = () => true) {
  if (!fs.existsSync(nmDir)) { console.warn(`[notices] SKIPPING missing tree ${nmDir} (run its builder first)`); return; }
  const scopes = fs.readdirSync(nmDir).filter((d) => !d.startsWith("."));
  for (const d of scopes) {
    const entries = d.startsWith("@")
      ? fs.readdirSync(path.join(nmDir, d)).map((s) => path.join(d, s))
      : [d];
    for (const rel of entries) {
      const dir = path.join(nmDir, rel);
      if (!fs.existsSync(path.join(dir, "package.json"))) continue;
      if (!keep(rel)) continue;
      addPackage(dir);
      // nested node_modules (version conflicts)
      const nested = path.join(dir, "node_modules");
      if (fs.existsSync(nested)) walkTree(nested, () => true);
    }
  }
}

// root tree: production deps only, from the lockfile's dev flags
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const prodPaths = new Set();
for (const [k, v] of Object.entries(lock.packages || {})) {
  if (!k || v.dev) continue;                                   // "" = the root project itself
  prodPaths.add(k.replace(/^node_modules\//, ""));
}
walkTree(path.join(ROOT, "node_modules"), (rel) => prodPaths.has(rel));
walkTree(path.join(ROOT, "relay", "node_modules"));
walkTree(path.join(ROOT, "scripts", ".vendor-build", "node_modules"));

// group by license id
const byLicense = new Map();
for (const [key, info] of [...pkgs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const arr = byLicense.get(info.license) || [];
  arr.push({ key, ...info });
  byLicense.set(info.license, arr);
}

// Licenses where per-package copyright lines + one canonical text suffice.
// Anything OUTSIDE this set (LGPL, MPL, vendor "community" licenses, UNKNOWN)
// gets its FULL in-package license file inlined per package — those licenses
// carry package-specific terms (e.g. the Reown/WalletConnect community
// license requires shipping a copy of itself; LGPL-3.0 requires its text
// accompany the combined work), so a family summary is not enough.
const PERMISSIVE = new Set(["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "0BSD",
  "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "CC-BY-4.0",
  "(MIT OR Apache-2.0)", "(MIT OR CC0-1.0)", "(Apache-2.0 AND MIT)", "(MIT AND BSD-3-Clause)"]);

// canonical texts: lifted verbatim from a representative package in-tree so we
// never paraphrase a license. Families we don't have a canonical for fall back
// to a per-package pointer.
const CANONICAL_SOURCES = {
  "MIT": "node_modules/express",
  "ISC": "node_modules/semver",
  "Apache-2.0": "node_modules/@tinfoilsh/verifier",
  "BSD-3-Clause": null,
  "BSD-2-Clause": null,
  "0BSD": null,
  "BlueOak-1.0.0": null,
};
function canonicalText(lic) {
  const rel = CANONICAL_SOURCES[lic];
  if (!rel) return null;
  const lf = licenseFileOf(path.join(ROOT, rel));
  return lf ? fs.readFileSync(lf, "utf8").trim() : null;
}

let md = `# Third-party notices

Enclave (see [LICENSE](LICENSE)) distributes artifacts that embed the
third-party packages below — in the site's JavaScript bundles
(\`site/vendor/\`, the built page chunks), the enclave
container images, and the CLI's installed dependencies. Each package remains
under its own license; this file carries the copyright and permission notices
that minified bundles cannot. Regenerate with \`node scripts/build-notices.mjs\`
after any dependency change.

`;
const flat = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length);
md += `Packages: ${pkgs.size} · Licenses: ${flat.map(([l, v]) => `${l} ×${v.length}`).join(" · ")}\n\n`;
// attribution lines specific licenses require verbatim in the product notices
if ([...pkgs.keys()].some((k) => k.startsWith("@reown/") || k.startsWith("@walletconnect/")))
  md += `Portions © 2025 Reown, Inc. All Rights Reserved\n\n`;
for (const [lic, arr] of flat) {
  md += `## ${lic}\n\n`;
  const inlineFull = !PERMISSIVE.has(lic);
  const seenTexts = new Set();   // identical license files across sibling packages (same vendor) print once
  for (const p of arr) {
    md += `- **${p.key}**`;
    if (p.copyrights.length) md += ` — ${p.copyrights.join(" · ")}`;
    md += `\n`;
    if (p.notice) md += `\n  <details><summary>NOTICE</summary>\n\n  \`\`\`\n${p.notice.split("\n").map((l) => "  " + l).join("\n")}\n  \`\`\`\n  </details>\n`;
    if (inlineFull) {
      const text = p.licenseFile ? fs.readFileSync(p.licenseFile, "utf8").trim() : null;
      if (!text) md += `  (no license file in the package — see its upstream repository)\n`;
      else if (!seenTexts.has(text)) {
        seenTexts.add(text);
        md += `\n  <details><summary>license text (${p.key}${arr.length > 1 ? " — shared by identical sibling packages above/below" : ""})</summary>\n\n\`\`\`\n${text}\n\`\`\`\n  </details>\n`;
      }
    }
  }
  if (!inlineFull) {
    const text = canonicalText(lic);
    md += text
      ? `\n<details><summary>${lic} license text</summary>\n\n\`\`\`\n${text}\n\`\`\`\n</details>\n\n`
      : `\n(For the full ${lic} text, see the LICENSE file shipped inside each package above.)\n\n`;
  } else md += `\n`;
}
// LGPL-3.0 is a supplement to GPL-3.0 and asks that both accompany the work;
// the package inlines the LGPL text, the GPL base text is at the FSF.
if ([...byLicense.keys()].some((l) => /LGPL/.test(l)))
  md += `\n> LGPL-3.0 supplements the GNU GPL v3; the GPL text accompanies it at https://www.gnu.org/licenses/gpl-3.0.txt\n`;
fs.writeFileSync(OUT, md);
console.log(`[notices] ${OUT}: ${pkgs.size} packages, ${Math.round(md.length / 1024)} KB`);
