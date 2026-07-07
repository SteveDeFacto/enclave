/* ============================================================
   <c-api-reference> — the Swagger-style API reference,
   rendered live from openapi.json: grouped operations, schema
   trees, request/response examples, runnable fetch()/cURL
   samples (the ▶ run button evaluates the displayed snippet
   against the live API with the session's address + token).
   Dispatches a document-level `enclave:api-rendered` event once the
   operations exist, so deep links (#op-…) can resolve.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { $$, esc, hlJson, hlCode, copyText, on, emit } from "../../js/core/util.js";
import { Enclave } from "../../js/core/api.js";
import { loadSpec, getSpec, deref, schemaExample, typeLabel, schemaTree, bodyExample, bodySchema, responseExample, collectOps } from "../../js/core/spec.js";

const SAMPLE_ID = "dep_3xK9f2Qa";
// samples embed the CONNECTED wallet's address so they run as-is; a full-length
// (still fake) address stands in until someone signs in - never an elided "0x…".
const EX_ADDR_FULL = "0x4E5A101112131415161718191a1B1C1D1E1Fb9c1";
const sampFill = (s) => s.replace(/0x4E5A\.\.\.b9c1/g, Enclave.address || EX_ADDR_FULL);
const opPublic = (op) => Array.isArray(op.security) && op.security.length === 0;

class ApiReference extends EnclaveElement {
  static templateUrl = new URL("./api-reference.html", import.meta.url);

  constructor() {
    super();
    this.BASE = "";           // SPEC.servers[0].url, set after loadSpec
    this.RAW = [];            // index -> raw text (for copy)
    this.SAMP = {};           // opIndex -> {curl,fetch,auth}
    this.BODY = {};           // opIndex -> {model, exampleHtml, exampleRaw}
  }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    // samples embed the connected address + token var; keep them current
    on("enclave:wallet", () => this.refreshSamples());
    loadSpec().then(spec => {
      this.BASE = spec.servers[0].url;
      this.renderApi();
      emit("enclave:api-rendered");
    }, e => {
      const m = this.querySelector(".api-main");
      if (m) m.innerHTML = '<div class="store-note">Couldn’t load openapi.json: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  buildUrl(path, op) {
    const p = path.replace(/\{(\w+)\}/g, (_, k) => k === "id" ? SAMPLE_ID : "{" + k + "}");
    const qs = [];
    (op.parameters || []).forEach(pr => {
      if (pr.in !== "query") return;
      const sd = deref(pr.schema || {}) || {};
      const explicit = ("example" in sd) || ("default" in sd) || sd.enum;
      if (!pr.required && !explicit) return;
      const v = schemaExample(pr.schema || {});
      if (v !== null && v !== undefined) qs.push(encodeURIComponent(pr.name) + "=" + encodeURIComponent(v));
    });
    return this.BASE + p + (qs.length ? "?" + qs.join("&") : "");
  }
  buildCurl(method, path, op) {
    const url = this.buildUrl(path, op), body = bodyExample(op), L = ["curl -X " + method + " " + url];
    if (!opPublic(op)) L.push('  -H "Authorization: Bearer $LOGIN_TOKEN"');
    if (body) { L.push('  -H "Content-Type: application/json"'); L.push("  -d '" + JSON.stringify(body, null, 2) + "'"); }
    return L.join(" \\\n");
  }
  buildFetch(method, path, op) {
    const url = this.buildUrl(path, op), body = bodyExample(op), H = [];
    if (!opPublic(op)) H.push('    "Authorization": `Bearer ${LOGIN_TOKEN}`');
    if (body) H.push('    "Content-Type": "application/json"');
    let o = '  method: "' + method + '"';
    if (H.length) o += ",\n  headers: {\n" + H.join(",\n") + "\n  }";
    if (body) o += ",\n  body: JSON.stringify(" + JSON.stringify(body, null, 2) + ")";
    return 'const res = await fetch("' + url + '", {\n' + o + "\n});\nconst data = await res.json();";
  }

  refreshSamples() {
    this.querySelectorAll("[data-sbox]").forEach(box => {
      const oi = box.dataset.sbox;
      if (!this.SAMP[oi]) return;
      const wrap = this.querySelector('.sampletoggle[data-sid="' + oi + '"]');
      const mode = (wrap && wrap.querySelector("button.on").dataset.mode) || "fetch";
      box.innerHTML = hlCode(sampFill(this.SAMP[oi][mode]));
    });
  }

  renderApi() {
    const SPEC = getSpec();
    const stash = (t) => (this.RAW.push(t), this.RAW.length - 1);
    const ops = collectOps();
    let oi = 0;
    const navParts = [], mainParts = [];

    SPEC.tags.forEach(tag => {
      const group = ops.filter(o => (o.op.tags || []).includes(tag.name));
      if (!group.length) return;

      navParts.push('<div class="grp">' + esc(tag.name) + "</div>");
      let groupHtml = '<section class="op-group" id="grp-' + esc(tag.name) + '">'
        + '<div class="gh"><h3>' + esc(tag.name) + "</h3><p>" + esc(tag.description || "") + "</p></div>";

      group.forEach(({ method, path, op }) => {
        const id = "op-" + (op.operationId || (method + path).replace(/\W+/g, "-"));
        const mcls = "m-" + method.toLowerCase();
        const searchStr = (method + " " + path + " " + (op.summary || "") + " " + tag.name).toLowerCase();

        navParts.push('<a data-target="' + id + '" data-search="' + esc(searchStr) + '">'
          + '<span class="mtag ' + mcls + '">' + method + "</span>"
          + '<span style="overflow:hidden;text-overflow:ellipsis;">' + esc(path) + "</span></a>");

        // ---- body of the op card ----
        let body = '<div class="op-body">';
        body += opPublic(op)
          ? '<span class="op-auth pub">auth · public</span>'
          : '<span class="op-auth">auth · SIWE bearer</span>';
        if (op.description) body += '<p class="op-long">' + esc(op.description) + "</p>";

        // parameters
        const params = op.parameters || [];
        if (params.length) {
          body += '<div class="block-lbl">Parameters</div><table class="params"><thead><tr>'
            + "<th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>";
          params.forEach(pr => {
            const r = deref(pr.schema || {}) || {};
            let enums = r.enum ? r.enum.map(e => '<span class="enumv">' + esc(e) + "</span>").join("") : "";
            body += "<tr><td class='pname'>" + esc(pr.name)
              + (pr.required ? '<span class="req-star">*</span>' : "")
              + "</td><td><span class='pin'>" + esc(pr.in) + "</span></td>"
              + "<td><span class='ptype'>" + typeLabel(pr.schema || {}) + "</span></td>"
              + "<td class='pdesc'>" + esc(pr.description || "") + (enums ? "<br>" + enums : "") + "</td></tr>";
          });
          body += "</tbody></table>";
        }

        // request body (model | example toggle)
        const bSch = bodySchema(op);
        if (bSch) {
          const ex = bodyExample(op);
          const exRaw = JSON.stringify(ex, null, 2);
          this.BODY[oi] = { model: schemaTree(bSch), exampleHtml: hlJson(ex), exampleRaw: exRaw };
          body += '<div class="block-lbl">Request body</div>'
            + '<div class="samples bodytoggle" data-bid="' + oi + '">'
            + '<button class="on" data-bmode="model">Schema</button>'
            + '<button data-bmode="example">Example</button></div>'
            + '<div class="code" data-bbox="' + oi + '"><div class="codebar"><span class="fn">application/json</span>'
            + '<button class="copybtn" data-rawid="' + stash(exRaw) + '">⧉ copy</button></div>'
            + '<div class="schema" data-bview="' + oi + '">' + schemaTree(bSch) + "</div></div>";
        }

        // responses
        const resps = op.responses || {};
        body += '<div class="block-lbl">Responses</div>';
        Object.keys(resps).forEach(code => {
          const r = resps[code];
          const cls = "rc-" + code.charAt(0);
          const ex = responseExample(r);
          body += '<div class="resp-row"><span class="resp-code ' + cls + '">' + esc(code) + "</span>"
            + '<span class="resp-desc">' + esc(r.description || "") + "</span>"
            + '<span class="resp-chev">›</span></div>';
          if (ex !== null) {
            const raw = JSON.stringify(ex, null, 2);
            body += '<div class="resp-body"><div class="code"><div class="codebar"><span class="fn">200 example</span>'
              .replace("200", esc(code))
              + '<button class="copybtn" data-rawid="' + stash(raw) + '">⧉ copy</button></div>'
              + "<pre><code>" + hlJson(ex) + "</code></pre></div></div>";
          } else {
            body += '<div class="resp-body"></div>';
          }
        });

        // code samples (fetch | cURL) - fetch is the default; ▶ run evals it live
        const curl = this.buildCurl(method, path, op), fetchS = this.buildFetch(method, path, op);
        this.SAMP[oi] = { curl, fetch: fetchS, auth: !opPublic(op) };
        body += '<div class="block-lbl">Code</div>'
          + '<div class="samples sampletoggle" data-sid="' + oi + '">'
          + '<button class="on" data-mode="fetch">fetch()</button>'
          + '<button data-mode="curl">cURL</button></div>'
          + '<div class="code"><div class="codebar"><span class="fn" data-sfn="' + oi + '">request.js</span>'
          + '<button class="runbtn" data-runsamp="' + oi + '" type="button">run</button>'
          + '<button class="copybtn" data-copysamp="' + oi + '">⧉ copy</button></div>'
          + '<pre><code data-sbox="' + oi + '">' + hlCode(sampFill(fetchS)) + "</code></pre></div>"
          + '<div data-srun="' + oi + '"></div>';

        body += "</div>"; // op-body

        groupHtml += '<div class="op" id="' + id + '" data-search="' + esc(searchStr) + '">'
          + '<div class="op-sum"><span class="mtag ' + mcls + '">' + method + "</span>"
          + '<span class="op-path">' + esc(path) + "</span>"
          + '<span class="op-desc">' + esc(op.summary || "") + "</span>"
          + '<span class="op-chev">›</span></div>' + body + "</div>";
        oi++;
      });

      groupHtml += "</section>";
      mainParts.push(groupHtml);
    });

    this.querySelector(".api-nav").innerHTML = navParts.join("");
    this.querySelector(".api-main").innerHTML = mainParts.join("");
    this.wireApi();
  }

  // ▶ run: evaluate the operation's fetch() sample as real JavaScript against the
  // live API (address + bearer token substituted from the session) and render the
  // response inline. It's literally the displayed snippet - what you see is what runs.
  async runSample(oi, btn) {
    const s = this.SAMP[oi]; if (!s) return;
    const out = this.querySelector('[data-srun="' + oi + '"]'); if (!out) return;
    if (s.auth && !Enclave.token){
      out.innerHTML = '<div class="wp-err" style="margin-top:8px">This endpoint needs auth - hit Sign in first, then run again.</div>';
      return;
    }
    const code = sampFill(s.fetch);
    const t0 = btn.textContent; btn.disabled = true; btn.textContent = "running…";
    try {
      const fn = new Function("LOGIN_TOKEN", '"use strict"; return (async () => {\n' + code + '\nreturn { status: res.status, ok: res.ok, data };\n})();');
      const r = await fn(Enclave.token || "");
      out.innerHTML = '<div class="code" style="margin-top:8px"><div class="codebar"><span class="fn">' +
        (r.ok ? "" : "⚠ ") + esc(String(r.status)) + ' response</span></div>' +
        '<pre style="margin:0;padding:13px 16px;max-height:280px;overflow:auto"><code>' + hlJson(r.data) + "</code></pre></div>";
    } catch(err){
      out.innerHTML = '<div class="wp-err" style="margin-top:8px">run failed: ' + esc(String(err && (err.message || err))) + "</div>";
    }
    btn.disabled = false; btn.textContent = t0;
  }

  wireApi() {
    const main = this.querySelector(".api-main");
    main.addEventListener("click", (e) => {
      const copy = e.target.closest(".copybtn");
      if (copy) {
        e.stopPropagation();
        if (copy.dataset.copysamp !== undefined) {
          const oi = copy.dataset.copysamp;
          const box = this.querySelector('.sampletoggle[data-sid="' + oi + '"]');
          const mode = box.querySelector("button.on").dataset.mode;
          copyText(sampFill(this.SAMP[oi][mode]), copy);
        } else if (copy.dataset.rawid !== undefined) {
          copyText(this.RAW[+copy.dataset.rawid], copy);
        }
        return;
      }
      const sampBtn = e.target.closest(".sampletoggle button");
      if (sampBtn) {
        const wrap = sampBtn.closest(".sampletoggle"); const oi = wrap.dataset.sid;
        $$("button", wrap).forEach(b => b.classList.remove("on"));
        sampBtn.classList.add("on");
        const mode = sampBtn.dataset.mode;
        main.querySelector('[data-sbox="' + oi + '"]').innerHTML = hlCode(sampFill(this.SAMP[oi][mode]));
        main.querySelector('[data-sfn="' + oi + '"]').textContent = mode === "curl" ? "terminal" : "request.js";
        return;
      }
      const run = e.target.closest(".runbtn");
      if (run){
        e.stopPropagation();
        this.runSample(run.dataset.runsamp, run);
        return;
      }
      const bodyBtn = e.target.closest(".bodytoggle button");
      if (bodyBtn) {
        const wrap = bodyBtn.closest(".bodytoggle"); const oi = wrap.dataset.bid;
        $$("button", wrap).forEach(b => b.classList.remove("on"));
        bodyBtn.classList.add("on");
        const view = main.querySelector('[data-bview="' + oi + '"]');
        if (bodyBtn.dataset.bmode === "model") {
          view.className = "schema"; view.innerHTML = this.BODY[oi].model;
        } else {
          view.className = ""; view.innerHTML = "<pre style='margin:0;padding:14px 16px'><code>" + this.BODY[oi].exampleHtml + "</code></pre>";
        }
        return;
      }
      const respRow = e.target.closest(".resp-row");
      if (respRow) {
        respRow.classList.toggle("open");
        const b = respRow.nextElementSibling;
        if (b && b.classList.contains("resp-body")) b.classList.toggle("open");
        return;
      }
      const sum = e.target.closest(".op-sum");
      if (sum) sum.parentElement.classList.toggle("open");
    });

    // nav: filter + deep link
    this.querySelector(".api-nav").addEventListener("click", (e) => {
      const a = e.target.closest("a[data-target]"); if (!a) return;
      e.preventDefault();
      const op = document.getElementById(a.dataset.target);
      if (op) { op.classList.add("open"); op.scrollIntoView({ behavior: "smooth", block: "start" }); }
    });
    this.querySelector(".api-search-input").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$(".api-main .op", this).forEach(o => { o.style.display = !q || o.dataset.search.includes(q) ? "" : "none"; });
      $$(".api-nav a", this).forEach(a => { a.classList.toggle("hidden", !!q && !a.dataset.search.includes(q)); });
      $$(".api-main .op-group", this).forEach(g => {
        const any = $$(".op", g).some(o => o.style.display !== "none");
        g.style.display = any ? "" : "none";
      });
    });
  }
}
register("c-api-reference", ApiReference);
