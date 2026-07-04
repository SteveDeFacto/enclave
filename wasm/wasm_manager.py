#!/usr/bin/env python3
"""wasm-manager: per-tenant WebAssembly app manager for NAN on Tinfoil.

Replaces the runsc/microVM backends. Nested container runtimes need privileged
namespace/mount/exec operations that Tinfoil confines away; a Wasm runtime needs
none of them. Each tenant app is a `wasmtime serve` subprocess bound to a unique
host loopback port. Isolation is provided by three independent layers, all
unprivileged: the Wasm sandbox (memory-safe, no ambient authority), the OS
process boundary (separate PID, own process group), and curated WASI (no
filesystem, no host env, no network beyond the served HTTP socket).

It speaks the SAME HTTP contract the supervisor already uses for the "vm"
backend, so the supervisor needs no change:

  POST   /vms   {image, cpuShare, gpuShare?, gpuTflops?, cpuGflops?, name?, appPort?}
                 (cpuGflops in GFLOPS; legacy cpuTflops accepted as x1000)
                 -> 201 {id, status, endpoint, hostPort, sshHostPort, ...}
  DELETE /vms/:id        -> {id, deleted: true}
  GET    /vms/:id | /vms | /health | /capacity | /catalog | /debug/env

Notes:
- `image` is reinterpreted as a Wasm APP REFERENCE:
    * a catalog id (baked-in, attested .wasm under APPS_DIR), or
    * `ipfs://<cid>` — fetched from IPFS_GATEWAY and VERIFIED: we pull the DAG as a
      CAR, check every block hashes to its CID, and reassemble the file rooted at
      the requested CID (see ipfs_fetch.py). A tampering gateway fails the hash
      check, so "what ran == this exact CID" holds without trusting the gateway.
      The verified CID is what the supervisor folds into attestation.
    * an absolute path to a .wasm already under APPS_DIR.
- `sshHostPort` is always 0. A Wasm app is not an OS; there is nothing to SSH
  into. The supervisor already tolerates sshPort 0.
- Apps must be wasi:http components (what `wasmtime serve` runs). A WASIX/wasmer
  socket-server launcher can be added behind the same LAUNCHER seam later.
"""
import http.server
import json
import os
import pathlib
import re
import resource
import shutil
import signal
import socket
import subprocess
import threading
import time
import uuid

try:
    import ipfs_fetch   # local module (same dir): fetch + verify a wasm by IPFS CID
except Exception as _e:   # optional feature — never let a missing module take down the manager
    ipfs_fetch = None
    print(f"[wasm-manager] run-by-CID disabled: {_e}", flush=True)

# ---- config ---------------------------------------------------------------- #
PORT         = int(os.environ.get("WASM_MANAGER_PORT", "8091"))   # same port the supervisor expects
WASMTIME     = os.environ.get("WASMTIME_BIN", "wasmtime")
APPS_DIR     = pathlib.Path(os.environ.get("WASM_APPS_DIR", "/opt/nan/apps"))
CATALOG_PATH = pathlib.Path(os.environ.get("WASM_CATALOG", str(APPS_DIR / "catalog.json")))
HOST_IP      = os.environ.get("WASM_HOST_IP", "127.0.0.1")
PORT_LO      = int(os.environ.get("WASM_PORT_LO", "20000"))
PORT_HI      = int(os.environ.get("WASM_PORT_HI", "40000"))
NODE_VCPUS   = int(os.environ.get("NODE_VCPUS", "16"))
NODE_RAM_GB  = int(os.environ.get("NODE_RAM_GB", "64"))
# Does this node have a GPU attached? Catalog apps that declare a GPU need
# (vram_mb or gpu_gflops > 0) are refused at launch on CPU-only nodes
# (enclaves/cpu/tinfoil-config.yml sets NODE_HAS_GPU=0). Apps without a GPU
# need are CPU-only and run anywhere the routing sends them.
NODE_HAS_GPU = os.environ.get("NODE_HAS_GPU", "0").lower() in ("1", "true", "on")
# Deployments buy SHARES: cpuShare is this manager's admission unit and sets
# the guest linear-memory ceiling (wasmtime -W max-memory-size = cpuShare ×
# NODE_RAM_GB). The app's catalog specs (mem_mb etc.) only set the minimum
# share, so the cap is always >= what the app declared. Direct callers may
# still pass an explicit memMb to cap lower.
MIN_MEM_MB   = int(os.environ.get("WASM_APP_MIN_MEM_MB", "64"))
READY_SECS   = float(os.environ.get("WASM_READY_TIMEOUT", "20"))
MOCK         = os.environ.get("WASM_MOCK", "") not in ("", "0", "false")
LOG_DIR      = pathlib.Path(os.environ.get("WASM_LOG_DIR", "/tmp/nan-wasm-logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
# run-by-CID: fetch an app's bytes from IPFS and verify they hash to the CID.
IPFS_GATEWAY   = os.environ.get("IPFS_GATEWAY", "https://ipfs.nan.host").rstrip("/")
WASM_MAX_BYTES = int(os.environ.get("WASM_MAX_BYTES", str(256 * 1024 * 1024)))  # cap on a fetched app
IPFS_TIMEOUT   = float(os.environ.get("IPFS_FETCH_TIMEOUT", "120"))
# firewall: per-version ports config from the catalog. Logical ports are LABELS
# (each deployment binds a remapped actual), so classic low numbers are allowed —
# a DNS app may advertise udp:53. The ceiling keeps labels out of the manager-
# assigned serve range; reserved keeps them off infrastructure (supervisor 8080,
# this manager 8091). Privileged actuals are never attempted: logical < 1024 is
# ALWAYS remapped to a free high port (unprivileged processes can't bind them).
PORT_MIN_DECL  = 1
PORT_MAX_DECL  = 19999
PRIV_PORT_MAX  = 1023
RESERVED_PORTS = {8080, 8091}
AUDIT_SECS     = float(os.environ.get("WASM_AUDIT_INTERVAL", "10"))
# WASIp3 (component-model async): wasmtime 45 accepts `-S p3` on both `run`
# and `serve`, and no longer marks it experimental. The flag widens the API
# SURFACE only — wasip2 components ignore it, wasip3 components need it to
# instantiate — while network reach stays gated by the same tcp/udp/
# inherit-network grants and the bind audit polices what is actually bound.
# WASM_P3=0 drops the flag fleet-wide (operator kill-switch, e.g. if a
# wasmtime upgrade regresses p3) without rebuilding the image.
P3_FLAGS       = [] if os.environ.get("WASM_P3", "1").lower() in ("0", "false", "no") else ["-Sp3"]

# App scratch filesystem: each deployment gets its own private, writable /data
# preopen (wasi:filesystem via `wasmtime --dir`), so off-the-shelf code that
# expects to read/write files ports to wasm with no changes -- the point is to
# make apps EASIER TO CONVERT, not to store anything. It is a RAM-backed scratch
# dir on the enclave's (already encrypted) ramdisk: strictly ephemeral, torn down
# with the deployment, no persistence, no host paths exposed. Isolation is the
# wasi capability model -- an app sees ONLY its own dir; a path escaping the
# preopen (`/data/../../etc/...`) is refused by the runtime, and no preopen means
# no visibility at all. A per-app size cap bounds RAM use, since `-W
# max-memory-size` covers linear memory only, NOT files; we can't mount a sized
# tmpfs (the enclave blocks mounts), so the audit sweep polices it -- same shape
# as the port bind audit. Global kill-switch WASM_FS=0; per-app opt-out is
# `storage_mb: 0` in the catalog.
FS_ENABLED     = os.environ.get("WASM_FS", "1").lower() not in ("0", "false", "no")
FS_DIR         = pathlib.Path(os.environ.get("WASM_FS_DIR", "/tmp/nan-wasm-fs"))  # base for per-deployment scratch dirs (ramdisk)
FS_GUEST_PATH  = os.environ.get("WASM_FS_GUEST", "/data")                          # where it shows up inside the guest
DEF_STORAGE_MB = int(os.environ.get("WASM_APP_STORAGE_MB", "256"))                 # per-app /data ceiling; catalog can override
if FS_ENABLED:
    FS_DIR.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_apps = {}    # id -> record


# ---- helpers --------------------------------------------------------------- #
def _load_catalog() -> dict:
    """Map of app-id -> {file, name, description, vram_mb?, gpu_gflops?,
    mem_mb?, cpu_gflops?, storage_mb?}. Baked-in + attested. The four resource
    fields are the app's EXACT minimums (memory in MB, compute in GFLOPS =
    1/1000 TFLOPS; any GPU axis > 0 marks a GPU app), mirroring NanAppCatalog;
    shares are calculated from them."""
    try:
        data = json.loads(CATALOG_PATH.read_text())
        return {a["id"]: a for a in data.get("apps", [])}
    except Exception:
        return {}


def _check_component(data: bytes):
    """Reject anything that isn't a wasi:http *component* before we try to run it
    (same preamble check as the upload gateway; gives a clear error vs a wasmtime
    crash). Layer field: 0 = core module, 1 = component."""
    if len(data) < 8 or data[0:4] != b"\x00asm":
        raise ValueError("fetched bytes are not a WebAssembly file")
    layer = data[6] | (data[7] << 8)
    if layer == 0:
        raise ValueError("fetched a core wasm module, not a wasi:http component")
    if layer != 1:
        raise ValueError(f"unrecognized wasm layer {layer} (expected a component)")


def _resolve_cid(cid: str) -> pathlib.Path:
    """Fetch `cid` from IPFS, verify the bytes hash to it, cache under APPS_DIR, run."""
    safe = re.sub(r"[^A-Za-z0-9]", "", cid)
    if not safe:
        raise ValueError(f"bad ipfs cid '{cid}'")
    p = (APPS_DIR / f"ipfs-{safe}.wasm").resolve()
    if p.is_file():
        return p                                   # content-addressed cache hit
    if ipfs_fetch is None:
        raise ValueError("run-by-CID not available in this build (ipfs_fetch missing)")
    try:
        data = ipfs_fetch.fetch_verified(cid, IPFS_GATEWAY, WASM_MAX_BYTES, IPFS_TIMEOUT)
    except ValueError:
        raise                                      # verification / size errors already have clear messages
    except Exception as e:                          # network / gateway errors -> ValueError so launch() reports it
        raise ValueError(f"ipfs fetch failed for {cid}: {e}")
    _check_component(data)
    APPS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(p)                                  # atomic publish into the cache
    return p


def _resolve_wasm(ref: str) -> pathlib.Path:
    """Resolve an app reference to a .wasm path: a catalog id (baked-in, attested),
    `ipfs://<cid>` (fetched + verified against the CID), or a path INSIDE APPS_DIR."""
    if ref.startswith("ipfs://"):
        cid = ref[len("ipfs://"):].split("/", 1)[0].split("?", 1)[0].strip()
        return _resolve_cid(cid)
    cat = _load_catalog()
    if ref in cat:
        p = (APPS_DIR / cat[ref]["file"]).resolve()
    else:
        p = pathlib.Path(ref).resolve()
    # containment: only allow paths under APPS_DIR
    if APPS_DIR.resolve() not in p.parents and p != APPS_DIR.resolve():
        raise ValueError(f"app '{ref}' is not in the catalog and not under {APPS_DIR}")
    if not p.is_file():
        raise ValueError(f"wasm module not found for app '{ref}' ({p})")
    return p


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((HOST_IP, 0))
        return s.getsockname()[1]


def _port_open(port: int, timeout=0.25) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        try:
            s.connect((HOST_IP, port))
            return True
        except OSError:
            return False


def _used_cpu_share() -> float:
    """Admission is by cpuShare only: this manager owns the node's vCPU+RAM pool.
    GPU shares are accounted by the supervisor's card allocator, not here."""
    return round(sum(r["cpuShare"] for r in _apps.values() if r["status"] in ("starting", "running")), 4)


def _capacity() -> dict:
    used = _used_cpu_share()
    free = round(max(0.0, 1.0 - used), 4)
    return {"cpuShareFree": free, "usedCpuShare": used,
            "maxShare": free, "usedShare": used,   # deprecated aliases (one release)
            "vcpusFree": round(NODE_VCPUS * free, 2),
            "ramGbFree": round(NODE_RAM_GB * free, 2),
            "apps": len(_apps)}


def _preexec():
    """preexec: put the app in its own session so teardown can kill the whole
    group cleanly, and cap open files.

    We deliberately do NOT cap RLIMIT_AS. `wasmtime` reserves an enormous
    *virtual* address space (multi-TiB PROT_NONE guard/pooling regions) for fast
    linear-memory bounds-checking while touching almost no physical RAM, and on a
    many-core host it also reserves a worker-thread stack per CPU. Any RLIMIT_AS
    small enough to bound real memory instead makes those reservations fail,
    killing the runtime at startup (the "memory allocation of N bytes failed"
    abort). The guest's real memory is bounded on its linear memory via
    `wasmtime -W max-memory-size` in launch(); that is the only memory a tenant
    can grow, so it is the meaningful per-app cap."""
    os.setsid()
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
    except (ValueError, OSError):
        pass


# ---- lifecycle ------------------------------------------------------------- #
def _parse_ports(entries):
    """Parse a firewall config (list of 'http' | 'http:N' | 'tcp:N' | 'udp:N').

    Empty / just 'http' -> classic serve mode: `wasmtime serve` on a manager-
    assigned port, no wasi:sockets, the sandbox we've always had.
    Anything else -> run mode: the app is a long-running command component that
    binds its DECLARED ports itself via wasi:sockets ('http:N' = it serves HTTP
    on N and the supervisor proxies /x/:id there)."""
    http_port, tcp, udp, norm = None, set(), set(), []
    for e in entries or []:
        s = str(e).strip().lower()
        if not s or s == "http":
            continue
        m = re.fullmatch(r"(http|tcp|udp):(\d{1,5})", s)
        if not m:
            raise ValueError(f"bad port spec '{e}' (use http[:N] | tcp:N | udp:N)")
        n = int(m.group(2))
        if not (PORT_MIN_DECL <= n <= PORT_MAX_DECL) or n in RESERVED_PORTS:
            raise ValueError(f"port {n} not allowed (labels are {PORT_MIN_DECL}-{PORT_MAX_DECL}, "
                             f"excluding {sorted(RESERVED_PORTS)})")
        if m.group(1) == "http":
            if http_port is not None:
                raise ValueError("only one http:N entry allowed")
            http_port = n
        elif m.group(1) == "tcp":
            tcp.add(n)
        else:
            udp.add(n)
        norm.append(f"{m.group(1)}:{n}")
    declared = tcp | udp | ({http_port} if http_port else set())
    return {"serve": not declared, "http": http_port, "tcp": tcp, "udp": udp,
            "declared": declared, "norm": norm}


def _port_free(p: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST_IP, p))
            return True
        except OSError:
            return False


def _alloc_ports(pspec) -> dict:
    """Map each LOGICAL port entry ('tcp:5432') to an ACTUAL loopback port.

    Declared ports are the app's stable interface (what the bridge URL and
    NAN_PORTS reference); the actual bind is per-deployment, so two tenants can
    both run "the 5432 app" at the same time with no conflict — the URL routes
    by deployment id, never by the raw port. We prefer the logical number when
    it's free (apps that hardcode their port keep working while they can);
    otherwise the OS assigns a free one. NAN_PORTS always carries the truth."""
    with _lock:
        claimed = set()
        for r in _apps.values():
            if r["status"] in ("starting", "running"):
                claimed |= set((r.get("portMap") or {}).values())
    out = {}
    for entry in pspec["norm"]:
        logical = int(entry.split(":")[1])
        # privileged labels (<1024, e.g. udp:53) are never bound literally
        keep = logical > PRIV_PORT_MAX and logical not in claimed and _port_free(logical)
        actual = logical if keep else _free_port()
        claimed.add(actual)
        out[entry] = actual
    return out


def _build_cmd(pspec, wasm, serve_port: int, mem_bytes: int, port_map=None, fsdir=None):
    """The wasmtime invocation for a ports spec. Returns (cmd, host_port, wait_ports).

    serve mode: `wasmtime serve` owns the one HTTP listener; no sockets granted.
    run mode:   `wasmtime run` with wasi:sockets granted (-Stcp/-Sudp/
                -Sinherit-network/-Sallow-ip-name-lookup, verified against
                wasmtime 45). The app binds the ACTUAL ports from the mapping;
                NAN_PORTS tells it which ("tcp:5432=31245" = logical=actual —
                bind the actual). The grant is coarse (wasmtime can't allowlist
                per port), so the audit sweep enforces the firewall: bind an
                unassigned low port and the app is killed.
    Both modes add -Sp3 (unless WASM_P3=0) so apps may target the WASIp3
    async APIs as well as wasip2; socket permissions are identical either way.
    `fsdir`, when set, is preopened as the guest's /data (a private ramdisk
    scratch space); the app sees only that subtree."""
    fs_args = ["--dir", f"{fsdir}::{FS_GUEST_PATH}"] if fsdir else []
    if pspec["serve"]:
        return ([WASMTIME, "serve", "-Scli", "-Shttp", *P3_FLAGS, *fs_args,
                 "-W", f"max-memory-size={mem_bytes}",
                 "--addr", f"{HOST_IP}:{serve_port}", str(wasm)],
                serve_port, [serve_port])
    port_map = port_map or {}
    nan_ports = ",".join(f"{e}={port_map[e]}" for e in pspec["norm"])
    cmd = [WASMTIME, "run", "-Scli", *P3_FLAGS, "-Stcp", "-Sudp",
           "-Sinherit-network", "-Sallow-ip-name-lookup", *fs_args,
           "-W", f"max-memory-size={mem_bytes}",
           "--env", "NAN_PORTS=" + nan_ports, str(wasm)]
    http_entry = f"http:{pspec['http']}" if pspec["http"] else None
    host_port = port_map.get(http_entry, 0) if http_entry else 0
    if host_port:
        wait = [host_port]
    else:
        tcp_actuals = sorted(port_map[e] for e in pspec["norm"] if e.startswith("tcp:"))
        wait = tcp_actuals[:1]                               # udp-only: no waitable port
    return cmd, host_port, wait


def launch(app_ref: str, name: str, cpu_share: float, gpu_share: float = 0.0,
           mem_mb: int = 0, pspec=None, storage_mb=None) -> dict:
    pspec = pspec or _parse_ports([])
    if storage_mb is None:
        storage_mb = DEF_STORAGE_MB
    # the guest memory ceiling is the deployment's slice of the node's RAM
    # (cpuShare × NODE_RAM_GB); an explicit memMb (direct callers) caps lower.
    # Clamped to 4 GiB: wasm32 linear memory is hard-limited to 4 GiB, and
    # wasmtime refuses `-W max-memory-size` above its memory reservation
    # ("maximum memory size ... exceeds the configured memory reservation"),
    # which killed every launch with cpuShare > ~6% of a 64 GB node. Larger
    # CPU shares still buy proportional vCPU time — the guest just can't
    # address more than 4 GiB of linear memory.
    WASM32_MAX_MEM_MB = 4096
    if not mem_mb or mem_mb <= 0:
        mem_mb = int(cpu_share * NODE_RAM_GB * 1024)
    mem_mb = min(WASM32_MAX_MEM_MB, max(MIN_MEM_MB, int(mem_mb)))
    port = _free_port() if pspec["serve"] else 0
    port_map = {} if pspec["serve"] else _alloc_ports(pspec)   # logical entry -> actual bind
    vid = "app_" + uuid.uuid4().hex[:9]
    log_path = LOG_DIR / f"{vid}.log"
    assigned = set(port_map.values()) | ({port} if port else set())
    # Per-deployment scratch fs: private /data on the ramdisk. `storage_mb: 0`
    # (or WASM_FS=0) opts out; a mkdir failure is non-fatal (run without /data
    # rather than fail the deploy).
    fsdir = None
    if FS_ENABLED and storage_mb > 0:
        cand = FS_DIR / vid
        try:
            cand.mkdir(parents=True, exist_ok=True)
            fsdir = cand
        except OSError as e:
            print(f"[fs] {vid} could not create scratch dir: {e}", flush=True)
    rec = {"id": vid, "name": name or vid, "app": app_ref,
           "cpuShare": cpu_share, "gpuShare": gpu_share,
           "hostPort": port, "sshHostPort": 0,
           "endpoint": f"http://{HOST_IP}:{port}" if port else None, "status": "starting",
           "createdAt": time.time(), "_proc": None, "_log": str(log_path),
           "error": None, "mem_mb": mem_mb,   # exact guest memory cap (floor MIN_MEM_MB)
           "storageMb": storage_mb if fsdir else 0,   # 0 = no /data (opted out or disabled)
           "storageBytes": 0,                         # last measured /data usage (audit sweep)
           "ports": pspec["norm"],           # logical (the app's advertised interface)
           "portMap": port_map,              # logical entry -> actual loopback bind
           "boundPorts": [],                 # actuals confirmed bound (the bridge checks this)
           "_assigned": assigned,            # what the audit allows
           "_fsdir": str(fsdir) if fsdir else None}
    with _lock:
        _apps[vid] = rec

    if MOCK:
        # Stand up a trivial responder so the full supervisor path is testable.
        mock_port = port or _free_port()
        rec["hostPort"] = mock_port
        rec["_proc"] = _mock_server(mock_port, vid)
        rec["status"] = "running"
        return rec

    try:
        wasm = _resolve_wasm(app_ref)
    except ValueError as e:
        rec["status"], rec["error"] = "failed", str(e)
        return rec

    # Grants are minimal: a private /data preopen only (no host paths), no --env
    # beyond NAN_PORTS, and sockets only when the version's firewall config asks
    # for them. `-W max-memory-size` caps the guest's linear memory (the only RAM
    # a tenant can grow) -- this is the real per-app memory ceiling, enforced by
    # the runtime rather than by RLIMIT_AS (see _preexec for why RLIMIT_AS is
    # wrong); the /data ramdisk usage is capped separately by the audit sweep.
    mem_bytes = max(mem_mb, 1) * 1024 * 1024
    cmd, host_port, wait_ports = _build_cmd(pspec, wasm, port, mem_bytes, port_map, fsdir)
    rec["hostPort"] = host_port
    rec["endpoint"] = f"http://{HOST_IP}:{host_port}" if host_port else None
    logf = open(log_path, "wb")
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=logf,
                                stderr=logf, preexec_fn=_preexec)
    except Exception as e:
        rec["status"], rec["error"] = "failed", f"spawn: {e}"
        logf.close()
        return rec
    rec["_proc"] = proc

    # readiness: a waitable port accepts, or the process dies first.
    # (udp-only apps have no waitable port: a short grace, then alive == running.)
    deadline = time.time() + (READY_SECS if wait_ports else 2.0)
    while time.time() < deadline:
        if proc.poll() is not None:
            rec["status"] = "failed"
            rec["error"] = _log_tail(log_path) or f"wasmtime exited {proc.returncode}"
            return rec
        if wait_ports and _port_open(wait_ports[0]):
            rec["status"] = "running"
            _audit_rec(rec)          # populate boundPorts right away (the bridge checks it)
            return rec
        time.sleep(0.1)
    if wait_ports:
        # timed out: keep it but flag; supervisor can decide
        rec["status"] = "running" if _port_open(wait_ports[0]) else "failed"
    else:
        rec["status"] = "running" if proc.poll() is None else "failed"
    if rec["status"] == "failed":
        rec["error"] = rec.get("error") or ("did not open port in time; " + (_log_tail(log_path) or ""))
        _kill(rec)
    else:
        _audit_rec(rec)
    return rec


# --- firewall enforcement: audit what each app actually bound ---------------- #
def _bound_ports(pid) -> set:
    """Ports bound by `pid`: its socket inodes (/proc/<pid>/fd) matched against
    /proc/net/{tcp,tcp6,udp,udp6}. TCP counts only LISTEN (st=0A); UDP counts
    unconnected binds. Unprivileged: the manager spawned these processes."""
    inodes = set()
    try:
        for fd in os.listdir(f"/proc/{pid}/fd"):
            try:
                ln = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if ln.startswith("socket:["):
                inodes.add(ln[8:-1])
    except OSError:
        return set()
    ports = set()
    for name in ("tcp", "tcp6", "udp", "udp6"):
        try:
            lines = pathlib.Path(f"/proc/net/{name}").read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            f = line.split()
            if len(f) < 10 or f[9] not in inodes:
                continue
            if name.startswith("tcp") and f[3] != "0A":     # LISTEN only
                continue
            ports.add(int(f[1].rsplit(":", 1)[1], 16))
    return ports


def _audit_rec(rec):
    """Enforce the per-port firewall on one app. The wasmtime sockets grant is
    all-or-nothing, so this is the fine-grained half: any bind in the policed
    space (<= PORT_MAX_DECL, or reserved) that wasn't assigned kills the app.
    Ephemeral outbound ports (32768+) are out of scope on purpose."""
    proc = rec.get("_proc")
    pid = getattr(proc, "pid", None)
    if pid is None or (hasattr(proc, "poll") and proc.poll() is not None):
        return
    bound = _bound_ports(pid)
    assigned = set(rec.get("_assigned") or [])
    rec["boundPorts"] = sorted(bound & assigned)   # actuals the bridge may target
    policed = {p for p in bound if p <= PORT_MAX_DECL or p in RESERVED_PORTS}
    extra = policed - assigned
    if extra:
        rec["status"] = "failed"
        rec["error"] = (f"firewall: bound unassigned port(s) {sorted(extra)}; app killed. "
                        f"Apps must bind the ACTUAL ports from NAN_PORTS (logical=actual), not hardcode.")
        print(f"[audit] {rec['id']} killed: unassigned ports {sorted(extra)}", flush=True)
        _kill(rec)


def _dir_size(path) -> int:
    """Bytes used under `path` (files only, symlinks not followed)."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.stat(os.path.join(root, f), follow_symlinks=False).st_size
            except OSError:
                pass
    return total


def _audit_storage(rec):
    """Enforce the per-app /data ceiling. We can't mount a sized tmpfs (the
    enclave blocks mounts), so -- like the port firewall -- we measure and kill
    on breach. `storageBytes` is refreshed each sweep so callers can see usage."""
    fsdir, cap_mb = rec.get("_fsdir"), rec.get("storageMb") or 0
    if not fsdir or cap_mb <= 0:
        return
    used = _dir_size(fsdir)
    rec["storageBytes"] = used
    if used > cap_mb * 1024 * 1024:
        rec["status"] = "failed"
        rec["error"] = (f"storage: /data used {used // (1024*1024)}MiB exceeds the {cap_mb}MiB cap; "
                        f"app killed. Raise storage_mb in the catalog if the app needs more scratch space.")
        print(f"[audit] {rec['id']} killed: storage {used} bytes > {cap_mb}MiB", flush=True)
        _kill(rec)


def _audit_sweep():
    while True:
        time.sleep(AUDIT_SECS)
        with _lock:
            recs = [r for r in _apps.values() if r["status"] == "running"]
        for r in recs:
            try:
                _audit_rec(r)
                if r["status"] == "running":
                    _audit_storage(r)
            except Exception:
                pass


def _mock_server(port: int, vid: str):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(f"nan-wasm-ok {vid}".encode())
        def log_message(self, *a):
            pass
    srv = http.server.HTTPServer((HOST_IP, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _log_tail(path, n=800) -> str:
    try:
        return path.read_text(errors="replace")[-n:].strip()
    except Exception:
        return ""


def _kill(rec):
    p = rec.get("_proc")
    if p is None:
        return
    try:
        if MOCK:
            p.shutdown()
            return
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass


def _rm_fsdir(rec):
    d = rec.get("_fsdir")
    if d:
        shutil.rmtree(d, ignore_errors=True)   # ephemeral scratch: nothing to preserve


def teardown(vid: str) -> bool:
    with _lock:
        rec = _apps.pop(vid, None)
    if rec is None:
        return False
    _kill(rec)
    _rm_fsdir(rec)
    return True


def _public(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if not k.startswith("_")}


# ---- HTTP contract --------------------------------------------------------- #
class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "runtime": "wasmtime",
                                    "version": _wasmtime_version(), "mock": MOCK,
                                    "capacity": _capacity()})
        if self.path == "/capacity":
            return self._json(200, _capacity())
        if self.path == "/catalog":
            cat = _load_catalog()
            return self._json(200, {"apps": [
                {"id": a["id"], "name": a.get("name", a["id"]),
                 "description": a.get("description", ""),
                 "vramMb": int(a.get("vram_mb", 0)),
                 "gpuGflops": int(a.get("gpu_gflops", 0)),
                 "memMb": int(a.get("mem_mb", 0)),
                 "cpuGflops": int(a.get("cpu_gflops", 0)),
                 "gpu": int(a.get("vram_mb", 0)) > 0 or int(a.get("gpu_gflops", 0)) > 0} for a in cat.values()]})
        if self.path == "/debug/env":
            return self._json(200, _debug_env())
        if self.path == "/vms":
            with _lock:
                return self._json(200, {"vms": [_public(r) for r in _apps.values()]})
        if self.path.startswith("/vms/"):
            vid = self.path[len("/vms/"):]
            with _lock:
                rec = _apps.get(vid)
            return self._json(200, _public(rec)) if rec else self._json(404, {"error": "not found"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/vms":
            return self._json(404, {"error": "not found"})
        b = self._body()
        app_ref = b.get("image") or b.get("app")
        if not app_ref:
            return self._json(400, {"error": "missing app reference (image)"})
        # deployments buy shares: cpuShare (the admission unit; "share" is the
        # legacy alias) sets the memory cap; gpuShare rides along for GPU
        # catalog apps (the card pool itself is the supervisor's allocator).
        # The app's catalog specs set minimums, checked below.
        def _share(*keys, default=0.0):
            for k in keys:
                if b.get(k) is not None:
                    try:
                        return min(max(float(b[k]), 0.0), 1.0)
                    except (TypeError, ValueError):
                        pass
            return default
        try:
            mem_mb = max(0, int(b.get("memMb") or 0))
        except (TypeError, ValueError):
            mem_mb = 0
        cpu_share = _share("cpuShare", "share",
                           default=min(1.0, mem_mb / (NODE_RAM_GB * 1024.0)) if mem_mb else 0.05)
        gpu_share = _share("gpuShare")
        if gpu_share > 0 and gpu_share < cpu_share - 1e-9:
            return self._json(422, {"error": "derived gpuShare must be at least cpuShare (too much RAM for that VRAM ask)"})
        if _used_cpu_share() + cpu_share > 1.0 + 1e-6:
            return self._json(429, {"error": "insufficient capacity", "capacity": _capacity()})
        try:
            pspec = _parse_ports(b.get("ports") or [])
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        # No cross-tenant port conflicts by construction: declared ports are LOGICAL;
        # _alloc_ports gives each deployment its own actual bind (NAN_PORTS tells the
        # app which), so two tenants can both run "the tcp:5432 app" simultaneously.
        cat = _load_catalog()
        meta = cat.get(app_ref, {})
        min_vram = int(meta.get("vram_mb", 0))
        min_ggf = int(meta.get("gpu_gflops", 0))
        min_mem = int(meta.get("mem_mb", 0))
        min_cgf = int(meta.get("cpu_gflops", 0))
        if (min_vram > 0 or min_ggf > 0) and (not NODE_HAS_GPU or gpu_share <= 0):
            return self._json(422, {"error": f"app '{app_ref}' requires a GPU ({min_vram} MB VRAM / {min_ggf / 1000} TFLOPS); "
                                             + ("ask for GPU resources" if NODE_HAS_GPU else "this node is CPU-only")})
        if min_mem and (mem_mb or int(cpu_share * NODE_RAM_GB * 1024)) < min_mem:
            return self._json(422, {"error": f"app '{app_ref}' declares a minimum of {min_mem} MB RAM; the request asks for less"})
        # compute minimums: the ask arrives GPU in TFLOPS (gpuTflops) but CPU in
        # GFLOPS (cpuGflops) - a whole node is ~1000 GFLOPS, so TFLOPS is too
        # coarse a grain for CPU. cpuTflops is the legacy pre-GFLOPS field.
        def _num(k):
            try:
                return max(0.0, float(b.get(k) or 0))
            except (TypeError, ValueError):
                return 0.0
        ask_cgf = _num("cpuGflops") or _num("cpuTflops") * 1000
        if min_cgf and round(ask_cgf) < min_cgf:
            return self._json(422, {"error": f"app '{app_ref}' declares a minimum of {min_cgf} CPU GFLOPS; the request asks for less"})
        if min_ggf and round(_num("gpuTflops") * 1000) < min_ggf:
            return self._json(422, {"error": f"app '{app_ref}' declares a minimum of {min_ggf / 1000} GPU TFLOPS; the request asks for less"})
        storage_mb = int(meta.get("storage_mb", DEF_STORAGE_MB))   # per-app /data cap; 0 opts out
        rec = launch(app_ref, b.get("name", ""), cpu_share, gpu_share, mem_mb, pspec, storage_mb)
        code = 201 if rec["status"] in ("starting", "running") else 500
        return self._json(code, _public(rec))

    def do_DELETE(self):
        if self.path.startswith("/vms/"):
            vid = self.path[len("/vms/"):]
            return self._json(200, {"id": vid, "deleted": teardown(vid)})
        return self._json(404, {"error": "not found"})


def _wasmtime_version() -> str:
    if MOCK:
        return "mock"
    try:
        r = subprocess.run([WASMTIME, "--version"], capture_output=True, text=True, timeout=10)
        return (r.stdout or r.stderr or "").strip().splitlines()[0] if (r.stdout or r.stderr) else ""
    except Exception as e:
        return f"err: {e}"


def _debug_env() -> dict:
    out = {"runtime": "wasmtime", "mock": MOCK, "apps_dir": str(APPS_DIR),
           "catalog": sorted(_load_catalog().keys()), "version": _wasmtime_version(),
           "p3": bool(P3_FLAGS),
           "fs": FS_ENABLED, "fs_guest": FS_GUEST_PATH if FS_ENABLED else None,
           "default_storage_mb": DEF_STORAGE_MB if FS_ENABLED else 0}
    try:
        out["uname"] = " ".join(os.uname())
    except Exception as e:
        out["uname"] = f"err: {e}"
    # does `wasmtime serve` exist in this build?
    if not MOCK:
        try:
            r = subprocess.run([WASMTIME, "serve", "--help"], capture_output=True, text=True, timeout=10)
            out["serve_available"] = (r.returncode == 0)
        except Exception as e:
            out["serve_available"] = f"err: {e}"
    return out


def main():
    # Clear stale scratch dirs from a previous run: /data is strictly ephemeral,
    # and a manager restart has already lost track of any prior deployments.
    if FS_ENABLED:
        for child in FS_DIR.iterdir() if FS_DIR.exists() else []:
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
    httpd = http.server.ThreadingHTTPServer((HOST_IP if HOST_IP else "0.0.0.0", PORT), Handler)
    threading.Thread(target=_audit_sweep, daemon=True).start()   # firewall bind + storage audit
    print(f"wasm-manager on :{PORT} runtime=wasmtime mock={MOCK} apps_dir={APPS_DIR} "
          f"p3={bool(P3_FLAGS)} fs={FS_ENABLED}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for vid in list(_apps):
            teardown(vid)


if __name__ == "__main__":
    main()
