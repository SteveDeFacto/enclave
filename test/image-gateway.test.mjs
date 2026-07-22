// The /add-image path of scripts/ipfs-add-gateway.py, driven over real HTTP:
// a spawned gateway (UPLOAD_KEY unset = auth off; the signed-upload token is
// covered by the api-relay tests) in front of a stub Kubo /api/v0/add. The
// focus is the strict SVG validator - with Kubo running NoFetch, this
// validator is the ONLY perimeter between publisher uploads and what
// ipfs.enclave.host can ever serve, so the reject matrix IS the security
// property. Policy under test: validate-and-REJECT, never sanitize-and-rewrite.
//
//   run: node --test test/image-gateway.test.mjs   (needs python3 on PATH)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ipfs-add-gateway.py");

let kubo, gwProc, gwPort;
const added = [];   // { filename, size } for each add the stub Kubo saw

async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}

test.before(async () => {
  kubo = http.createServer(async (req, res) => {
    let body = Buffer.alloc(0);
    for await (const c of req) body = Buffer.concat([body, c]);
    const m = /filename="([^"]*)"/.exec(body.toString("latin1"));
    added.push({ filename: m ? m[1] : "", size: body.length });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Hash: "bafkteststub" }));
  });
  await new Promise((r) => kubo.listen(0, "127.0.0.1", r));
  gwPort = await freePort();
  gwProc = spawn("python3", [GW], {
    env: { ...process.env, PORT: String(gwPort), UPLOAD_KEY: "",
           KUBO_API: `http://127.0.0.1:${kubo.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${gwPort}/healthz`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway never answered /healthz");
});
test.after(() => { gwProc?.kill("SIGKILL"); kubo?.close(); });

const post = async (bytes) => {
  const r = await fetch(`http://127.0.0.1:${gwPort}/add-image`, {
    method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } });
  return { status: r.status, body: await r.json() };
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const NS = 'xmlns="http://www.w3.org/2000/svg"';

test("raster still pins: PNG -> cid, svg:false, plain filename to Kubo", async () => {
  const r = await post(PNG);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cid, "bafkteststub");
  assert.equal(r.body.svg, false);
  assert.equal(added.at(-1).filename, "image");
});

test("a clean SVG pins: cid + svg:true, .svg filename to Kubo", async () => {
  const r = await post(Buffer.from(
    `<?xml version="1.0"?><svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"/>` +
    `<path id="p" d="M0 0h10v10z"/></defs><style>.a{fill:url(#g)}</style>` +
    `<use href="#p" class="a"/><image href="data:image/png;base64,iVBOR"/></svg>`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.svg, true);
  assert.equal(added.at(-1).filename, "image.svg");
});

test("the SVG reject matrix: script-capable and externally-referencing constructs are all 415", async () => {
  const cases = [
    ["script element",        `<svg ${NS}><script>alert(1)</script></svg>`],
    ["event handler",         `<svg ${NS} onload="alert(1)"/>`],
    ["foreignObject",         `<svg ${NS}><foreignObject/></svg>`],
    ["javascript: href",      `<svg ${NS}><a href="javascript:alert(1)"><text>x</text></a></svg>`],
    ["entity-encoded js",     `<svg ${NS}><a href="jav&#97;script:alert(1)"><text>x</text></a></svg>`],
    ["tab-split js",          `<svg ${NS}><a href="java\tscript:alert(1)"><text>x</text></a></svg>`],
    ["external href",         `<svg ${NS}><image href="https://evil.example/x.png"/></svg>`],
    ["nested svg data: URI",  `<svg ${NS}><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>`],
    ["DOCTYPE/entities",      `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}/>`],
    ["xml-stylesheet PI",     `<?xml version="1.0"?><?xml-stylesheet href="http://e/x.css"?><svg ${NS}/>`],
    ["foreign namespace",     `<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml"><div>x</div></g></svg>`],
    ["style url(external)",   `<svg ${NS}><style>.a{background:url(http://e/x)}</style></svg>`],
    ["style attr external",   `<svg ${NS}><rect style="fill:url('https://e/x')"/></svg>`],
    ["style @import",         `<svg ${NS}><style>@import "http://e/x.css";</style></svg>`],
    ["animated href",         `<svg ${NS}><a href="#x"><animate attributeName="href" values="javascript:alert(1)"/></a></svg>`],
    ["animated xlink:href",   `<svg ${NS}><animate attributeName="xlink:href" to="#z"/></svg>`],
    ["no namespace",          `<svg><path d="M0 0"/></svg>`],
    ["malformed XML",         `<svg ${NS}><path`],
  ];
  for (const [name, doc] of cases) {
    const r = await post(Buffer.from(doc));
    assert.equal(r.status, 415, `${name} must be refused (got ${r.status}: ${JSON.stringify(r.body)})`);
  }
});

test("non-image bytes name every accepted format", async () => {
  const r = await post(Buffer.from("definitely not an image, and not xml either"));
  assert.equal(r.status, 415);
  assert.match(r.body.error, /PNG, JPEG, WebP, GIF, or SVG/);
});

test("the image size cap still applies to SVG", async () => {
  const big = Buffer.concat([Buffer.from(`<svg ${NS}><path d="`), Buffer.alloc(4 * 1024 * 1024 + 100, 0x30), Buffer.from(`"/></svg>`)]);
  const before = added.length;
  // the gateway answers 413 off Content-Length WITHOUT reading the body (the
  // 2 GB wasm cap makes read-then-reject a DoS); fetch may surface the early
  // close as an error instead of the response - either way it must not pin
  let refused = false;
  try { refused = (await post(big)).status === 413; } catch { refused = true; }
  assert.ok(refused, "an over-cap SVG must be refused");
  assert.equal(added.length, before, "nothing may reach Kubo");
});
