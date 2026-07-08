/* ============================================================
   Deployment run log — records each deploy run's output lines,
   persists the last 10 runs to localStorage, and broadcasts
   `enclave:runlog` events (start / id / line / end) so mounted
   views follow live. Runs are CONCURRENT: startRun()/resume()
   hand back a writer bound to one run, so a fleet of deploys
   each stream their own narrative side by side.

   Lives outside any component so a run survives soft navigation:
   the deploy flow starts on apps.html#deploy, the router swaps
   <main> to the dashboard, and the same run keeps streaming into
   the panels there (<c-deployments>' live strips + row panels).
   A HARD reload kills the writers but not the records: each run
   restores flagged `interrupted`, and the dashboard resumes every
   watch (deploy.js resumeDeployWatch) via resume().
   ============================================================ */
import { emit, lsGet, lsSet } from "./util.js";

const KEY = "enclave_term_logs";

let runs = [];
try { runs = JSON.parse(lsGet(KEY) || "[]") || []; } catch (e) { runs = []; }
// restored runs have no live writer; any stored un-done was cut off by the
// unload (a refresh mid-deploy) - flag them so the dashboard can resume them
runs.forEach(r => { r.interrupted = !r.done; r.done = true; });
const live = new Set();                  // runs with an attached writer (deploys in flight)
let saveT = 0;

function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try {
    lsSet(KEY, JSON.stringify(runs.slice(-10).map(r => ({ id: r.id, label: r.label, at: r.at, done: r.done, lines: r.lines.slice(-400) }))));
  } catch (e) {} }, 300);
}

/* The one way to append: a writer BOUND to its run. All closures (no `this`),
   so methods stay safe passed around detached (e.g. payForRuntime's log sink);
   a writer goes quiet once its run ends, so a stray late loop can never write
   into another run's story. */
function writerFor(run) {
  const dead = () => run.done || !live.has(run);
  const setId = (id) => {
    if (dead() || !id || run.id === id) return;
    run.id = id;
    save();
    emit("enclave:runlog", { type: "id", run: run });
  };
  const line = (cls, txt) => {
    if (dead()) return;
    run.lines.push([cls, txt]);
    // name the run after its deployment id the moment one appears in the text.
    // bytes32 ids read exactly like tx hashes (and the "↳ sent 0x…" line comes
    // FIRST), so 0x…64 only counts right after "created"; the deploy flow also
    // names the run explicitly via setId().
    if (!run.id) { const m = /\b(dep_[a-z0-9]+)\b/.exec(txt) || /\bcreated (0x[0-9a-f]{64})\b/i.exec(txt); if (m) setId(m[1]); }
    save();
    emit("enclave:runlog", { type: "line", run: run, cls: cls, txt: txt });
  };
  const end = () => {
    if (run.done) return;
    run.done = true; live.delete(run);
    save();
    emit("enclave:runlog", { type: "end", run: run });
  };
  return { run, dead, line, setId, end };
}

export const runlog = {
  runs() { return runs; },
  /* the runs currently being written (deploys/watches in flight) */
  live() { return [...live]; },
  /* the most recent recorded run for a deployment id (this browser only) */
  runFor(id) {
    const want = String(id || "").toLowerCase();
    if (!want) return null;
    for (let i = runs.length - 1; i >= 0; i--)
      if ((runs[i].id || "").toLowerCase() === want) return runs[i];
    return null;
  },
  /* every run a page unload cut off mid-deploy (this browser only) */
  interrupted() { return runs.filter(r => r.interrupted); },

  /* open a new run and hand back its writer; concurrent with any others */
  startRun() {
    const d = new Date();
    const run = { id: null,
            label: "run " + d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            at: Date.now(), done: false, lines: [] };
    runs.push(run);
    // cap the history at 10 without ever dropping an in-flight run
    while (runs.length > 10) { const i = runs.findIndex(r => r.done); if (i === -1) break; runs.splice(i, 1); }
    live.add(run);
    save();
    emit("enclave:runlog", { type: "start", run: run });
    return writerFor(run);
  },

  /* reopen an interrupted run so a resumed watcher can keep appending to the
     same record; null if something is already writing it */
  resume(run) {
    if (live.has(run)) return null;
    run.interrupted = false; run.done = false; live.add(run);
    save();
    emit("enclave:runlog", { type: "start", run: run });
    return writerFor(run);
  },

  /* legacy line sink (fund.js's default log): the newest live run, or a fresh one */
  line(cls, txt) {
    const w = live.size ? writerFor([...live][live.size - 1]) : runlog.startRun();
    w.line(cls, txt);
  },
};

/* Append one styled line to a .term container: repeated identical lines
   collapse into a (xN) counter, and the view follows the tail only when the
   reader is already at (or near) the bottom — never yank someone out of
   scrollback. `scroller` (optional) is the element that actually scrolls
   when it isn't the container itself. */
export function paintLine(container, cls, txt, scroller) {
  if (!container) return;
  const sc = scroller || container;
  const follow = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
  const last = container.lastElementChild;
  if (last && last.dataset && last.dataset.raw === txt && last.className === "ln " + cls) {
    const n = parseInt(last.dataset.n || "1", 10) + 1;
    last.dataset.n = String(n);
    last.textContent = txt + "  (x" + n + ")";
    if (follow) sc.scrollTop = sc.scrollHeight;
    return;
  }
  const s = document.createElement("span");
  s.className = "ln " + cls; s.textContent = txt; s.dataset.raw = txt;
  container.appendChild(s);
  if (follow) sc.scrollTop = sc.scrollHeight;
}
