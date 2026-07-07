/* ============================================================
   Shared helpers — DOM, escaping, highlighters, storage,
   formatting, clipboard, toasts. No page-specific state.
   ============================================================ */
export const $  = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
export const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---- persisted settings (guarded; degrades if storage is blocked) ---- */
export function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
export function lsSet(k,v){ try { localStorage.setItem(k,v); } catch(e){} }

export const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
export const wait = (ms) => new Promise(r => setTimeout(r, ms));
export const blen = (s) => new TextEncoder().encode(s || "").length;
export function fmtNum(n){ return (Math.round(n * 10) / 10).toString(); }   // drop trailing .0
export function fmtDur(s){
  s = Math.floor(s); if (!isFinite(s) || s <= 0) return "–";
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

/* ---- pretty JSON -> highlighted HTML ---- */
export function hlJson(v, ind) {
  ind = ind || 0;
  const pad = "  ".repeat(ind), pad1 = "  ".repeat(ind + 1);
  if (v === null) return '<span class="tok-bool">null</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="tok-punc">[]</span>';
    return '<span class="tok-punc">[</span>\n'
      + v.map(x => pad1 + hlJson(x, ind + 1)).join('<span class="tok-punc">,</span>\n')
      + '\n' + pad + '<span class="tok-punc">]</span>';
  }
  if (typeof v === "object") {
    const ks = Object.keys(v);
    if (!ks.length) return '<span class="tok-punc">{}</span>';
    return '<span class="tok-punc">{</span>\n'
      + ks.map(k => pad1
          + '<span class="tok-key">"' + esc(k) + '"</span><span class="tok-punc">: </span>'
          + hlJson(v[k], ind + 1)
        ).join('<span class="tok-punc">,</span>\n')
      + '\n' + pad + '<span class="tok-punc">}</span>';
  }
  if (typeof v === "string")  return '<span class="tok-str">"' + esc(v) + '"</span>';
  if (typeof v === "number")  return '<span class="tok-num">' + v + '</span>';
  if (typeof v === "boolean") return '<span class="tok-bool">' + v + '</span>';
  return esc(String(v));
}

/* ---- highlight a code string (string-aware) ---- */
export function hlCode(src) {
  const n = src.length;
  const isW  = c => /[A-Za-z_$]/.test(c);
  const isWd = c => /[A-Za-z0-9_$]/.test(c);
  const isD  = c => /[0-9]/.test(c);
  const KW   = new Set(["const","let","var","await","async","function","return","new","of","in","if","else","for","while","typeof"]);
  const METH = new Set(["GET","POST","PATCH","DELETE","PUT","curl"]);
  const BOOL = new Set(["true","false","null","undefined"]);
  let out = "", i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i; while (j < n && src[j] !== "\n") j++;
      out += '<span class="tok-com">' + esc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let j = i + 1;
      while (j < n) { if (src[j] === "\\") { j += 2; continue; } if (src[j] === q) { j++; break; } j++; }
      out += '<span class="tok-str">' + esc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (isD(c) || (c === "." && isD(src[i + 1]))) {
      let j = i; while (j < n && /[0-9._a-fxA-FX]/.test(src[j])) j++;
      out += '<span class="tok-num">' + esc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (isW(c)) {
      let j = i; while (j < n && isWd(src[j])) j++;
      const w = src.slice(i, j);
      const cls = KW.has(w) ? "tok-key" : METH.has(w) ? "tok-meth" : BOOL.has(w) ? "tok-bool" : "";
      out += cls ? '<span class="' + cls + '">' + esc(w) + '</span>' : esc(w);
      i = j; continue;
    }
    out += esc(c); i++;
  }
  return out;
}

/* ---- deployment status → tone class (terminal lines, status badges) ---- */
export function statusCls(st){
  if (st === "running") return "ok";
  if (st === "failed" || st === "error") return "warn";
  if (st === "terminated" || st === "stopping" || st === "stopped" || st === "expired" || st === "canceled") return "";  // neutral gray: a normal end state
  return "info";
}

/* ---- toast: dispatched as an event, rendered by <c-toast> (the
   LWC ShowToastEvent pattern) ---- */
export function showToast(msg) {
  document.dispatchEvent(new CustomEvent("enclave:toast", { detail: { message: msg } }));
}

/* ---- clipboard ---- */
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.top = "-9999px"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta); done();
}
export function copyText(text, btn) {
  const done = () => {
    if (btn) {
      const o = btn.innerHTML; btn.innerHTML = "✓ copied"; btn.classList.add("ok");
      setTimeout(() => { btn.innerHTML = o; btn.classList.remove("ok"); }, 1300);
    }
    showToast("copied to clipboard");
  };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}

/* ---- page-to-page signals (replaces the single-page world where every
   feature could call every other feature's render directly) ----
   enclave:wallet   — wallet/session state changed (repaint anything user-specific)
   enclave:auth     — sign-in/out edges: detail.authed, detail.spinner
   enclave:catalog  — app-catalog load lifecycle: detail.type = loading|loaded|error
   enclave:toast    — show a toast: detail.message */
export function emit(name, detail){ document.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); }
export function on(name, fn){ document.addEventListener(name, (e) => fn(e.detail || {}, e)); }
