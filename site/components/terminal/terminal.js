/* ============================================================
   <c-terminal> — the deploy console's persistent output: one
   buffer per run, selectable, survives reloads (localStorage).
   API: startRun() begins a buffer, line(cls, txt) appends to the
   live run, clear() resets the pane.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, lsGet, lsSet } from "../../js/core/util.js";

const TERM_STORE_KEY = "enclave_term_logs";
const IDLE_LINE = '<span class="ln dimln">// press “Deploy” to provision a confidential enclave…</span>';

class Terminal extends EnclaveElement {
  static templateUrl = new URL("./terminal.html", import.meta.url);

  constructor() {
    super();
    this._runs = []; this._cur = null; this._view = null; this._replay = false; this._saveT = 0;
  }

  get _out(){ return this.querySelector(".term-out"); }
  get _sel(){ return this.querySelector(".term-sel"); }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    try { this._runs = JSON.parse(lsGet(TERM_STORE_KEY) || "[]") || []; } catch(e){ this._runs = []; }
    this._view = this._runs.length ? this._runs[this._runs.length - 1] : null;
    this._renderSel();
    if (this._view) this._renderRun(this._view);              // restore last run's output across reloads
    this._sel.addEventListener("change", e => { const r = this._runs[+e.target.value]; if (r) this._renderRun(r); });
  }

  _save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { try {
      lsSet(TERM_STORE_KEY, JSON.stringify(this._runs.slice(-10).map(r => ({ id: r.id, label: r.label, at: r.at, lines: r.lines.slice(-400) }))));
    } catch(e){} }, 300);
  }

  startRun() {
    const d = new Date();
    this._cur = { id: null, label: "run " + d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), at: Date.now(), lines: [] };
    this._runs.push(this._cur); if (this._runs.length > 10) this._runs.splice(0, this._runs.length - 10);
    this._view = this._cur;
    if (this._out) this._out.innerHTML = "";
    this._renderSel(); this._save();
  }

  clear() { if (this._out) this._out.innerHTML = IDLE_LINE; }

  _renderSel() {
    const sel = this._sel; if (!sel) return;
    if (!this._runs.length){ sel.innerHTML = '<option>no deployments yet</option>'; sel.disabled = true; return; }
    sel.disabled = false;
    sel.innerHTML = this._runs.map((r, i) => '<option value="' + i + '">' +
      esc(r.id ? (r.id.length > 18 ? r.id.slice(0, 12) + "…" + r.id.slice(-4) : r.id) : r.label) + '</option>').join("");
    sel.value = String(this._runs.indexOf(this._view));
  }

  _renderRun(run) {
    const term = this._out; if (!term) return;
    this._view = run; term.innerHTML = "";
    if (!run || !run.lines.length){ term.innerHTML = '<span class="ln dimln">// no output recorded for this run</span>'; return; }
    this._replay = true;
    try { run.lines.forEach(l => this.line(l[0], l[1])); } finally { this._replay = false; }
    this._renderSel();
  }

  line(cls, txt) {
    const term = this._out; if (!term) return;
    if (!this._replay && this._cur){
      this._cur.lines.push([cls, txt]);   // record the live run even while another run is displayed
      if (!this._cur.id){ const m = /\b(dep_[a-z0-9]+|0x[0-9a-f]{64})\b/i.exec(txt); if (m){ this._cur.id = m[1]; this._renderSel(); } }
      this._save();
      if (this._view !== this._cur) return; // user is reading an older run; don't paint over it
    }
    // follow the tail only if the user is already at (or near) the bottom -
    // don't yank the view away from someone reading scrollback
    const follow = term.scrollHeight - term.scrollTop - term.clientHeight < 48;
    // collapse runs of identical lines (poll loops can emit hundreds of
    // "no live enclave has ..." retries) into one line with a repeat counter
    const last = term.lastElementChild;
    if (last && last.dataset && last.dataset.raw === txt && last.className === "ln " + cls){
      const n = parseInt(last.dataset.n || "1", 10) + 1;
      last.dataset.n = String(n);
      last.textContent = txt + "  (x" + n + ")";
      if (follow) term.scrollTop = term.scrollHeight;
      return last;
    }
    const s = document.createElement("span");
    s.className = "ln " + cls; s.textContent = txt; s.dataset.raw = txt;
    term.appendChild(s);
    if (follow) term.scrollTop = term.scrollHeight;
    return s;
  }
}
register("c-terminal", Terminal);
