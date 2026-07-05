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
    * `ipfs://<cid>` — the normal (and, through the supervisor, the ONLY) form:
      fetched from IPFS_GATEWAY and VERIFIED: we pull the DAG as a CAR, check
      every block hashes to its CID, and reassemble the file rooted at the
      requested CID (see ipfs_fetch.py). A tampering gateway fails the hash
      check, so "what ran == this exact CID" holds without trusting the gateway.
      The verified CID is what the supervisor folds into attestation.
    * a catalog id — only if a catalog file exists (WASM_CATALOG; none ships in
      the image: the only baked .wasm is nn-demo.wasm, the boot probe's fixture,
      which the probe launches directly without going through this resolution).
    * an absolute path to a .wasm already under APPS_DIR (internal/debug; the
      supervisor's approval gate never forwards these).
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
import urllib.request
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
# Readiness window for a spawned tenant's port. The loop exits EARLY on
# port-open or process death, so this only bounds the slowest legitimate case:
# the FIRST launch of a big component per CVM boot, where wasmtime must
# cranelift-compile it cold (llm-chat is 123MB; under TDX that can far exceed
# the old 20s - observed live 2026-07-05 as deterministic "failed" adopts
# while everything else was healthy). Later launches hit wasmtime's compile
# cache and open the port in seconds.
READY_SECS   = float(os.environ.get("WASM_READY_TIMEOUT", "150"))
MOCK         = os.environ.get("WASM_MOCK", "") not in ("", "0", "false")
LOG_DIR      = pathlib.Path(os.environ.get("WASM_LOG_DIR", "/tmp/nan-wasm-logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
# run-by-CID: fetch an app's bytes from IPFS and verify they hash to the CID.
IPFS_GATEWAY   = os.environ.get("IPFS_GATEWAY", "https://ipfs.nan.host").rstrip("/")
# cap on a fetched app: models ride inside the wasm (llm-chat 0.2 embeds a
# 460MB q4f16 LLM), so the ceiling is set by fetch/compile budgets, not code
WASM_MAX_BYTES = int(os.environ.get("WASM_MAX_BYTES", str(1024 * 1024 * 1024)))
# a 500MB CAR at gateway speeds (~3.5MB/s) needs ~150s; match the supervisor's
# 300s prefetch budget so the fetch is never the thing that times out first
IPFS_TIMEOUT   = float(os.environ.get("IPFS_FETCH_TIMEOUT", "300"))
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
# wasi-nn GPU interface: a deployment that BUYS a GPU share (gpuShare > 0)
# is launched with `-S nn`, so the guest can `load()` ONNX models and run
# inference through the host's ONNX Runtime — ExecutionTarget::Gpu maps to the
# CUDA execution provider, ::Cpu to the CPU one. Enforcement of the share is
# the SAME mechanism as the worker backend's PTX children: the tenant's
# wasmtime process is launched with CUDA_MPS_ACTIVE_THREAD_PERCENTAGE (SM cap)
# and CUDA_MPS_PINNED_DEVICE_MEM_LIMIT (VRAM cap = gpuShare × GPU_VRAM_GB), so
# the MPS daemon hardware-enforces both. Tenants that didn't buy a GPU share
# don't get the flag at all — a component importing wasi:nn then fails to
# instantiate, which is the admission control ("pay for a share to use the
# card"). WASM_NN=0 is the fleet-wide kill-switch (same shape as WASM_P3).
NN_ENABLED   = os.environ.get("WASM_NN", "1").lower() not in ("0", "false", "no")
GPU_VRAM_GB  = float(os.environ.get("GPU_VRAM_GB", "141"))
MPS_PIPE_DIR = os.environ.get("CUDA_MPS_PIPE_DIRECTORY", "/tmp/nvidia-mps")
# CUDA readiness probe (see _nn_probe_loop): a wasi-nn load() is a SYNCHRONOUS
# host call, so a CUDA init that HANGS (rather than errors) eats a runtime
# thread forever - a few retried GPU requests then wedge the whole tenant,
# including its CPU paths. Launching GPU tenants is therefore gated on a boot
# probe that does cuInit + primary-context retain (the MPS attach point) in a
# throwaway subprocess with the exact tenant env and a hard timeout, and
# bisects which layer breaks: full env -> without the pinned-VRAM limit ->
# without MPS. Result drives launches: full/nopin = go (nopin drops only the
# never-validated CUDA_MPS_PINNED_DEVICE_MEM_LIMIT; VRAM stays accounted by
# the supervisor's allocator), anything else = GPU launches are refused with
# the probe's diagnosis instead of hanging apps.
NN_PROBE_TIMEOUT = float(os.environ.get("WASM_NN_PROBE_TIMEOUT", "75"))   # worker.py validated ~60s CC init; match its patience
# Long-patience budget for the "is it hung or just glacial?" e2e variant:
# under CC, first-time cuBLAS/cuDNN kernel loading can legitimately take
# minutes (encrypted bounce-buffered copies), which only LOOKS like a hang.
NN_PROBE_LONG = float(os.environ.get("WASM_NN_PROBE_LONG", "600"))
# Control experiment for the bisect's endgame: the worker container's manager
# (same box, shared localhost) can spawn ITS validated CUDA path - an
# MPS-capped cupy child - on request. If that works while ORT hangs, the fault
# is container/ORT-side; if it hangs too, GPU compute init is broken node-wide
# under CC and the escalation target is the platform, not this stack.
WORKER_MGR_URL = os.environ.get("WORKER_MGR_URL", "http://127.0.0.1:8090").rstrip("/")
_NN_PROBE = {"state": "probing" if (NN_ENABLED and NODE_HAS_GPU and not MOCK) else "off",
             "mode": None, "detail": "", "attempts": 0, "stage": None,
             "env": {}, "args": []}   # state: probing|ok|failed|off; mode: full|nopin; stage: what's running RIGHT NOW; env/args: extra tenant env + wasmtime flags the probe adopted

_NN_PROBE_SRC = r"""
import ctypes, sys
try:
    cu = ctypes.CDLL("libcuda.so.1")
except OSError as e:
    print(f"libcuda.so.1 unavailable ({e}): nvidia runtime not applied to this container?", flush=True); sys.exit(4)
def ck(name, rc):
    if rc != 0:
        print(f"{name} rc={rc}", flush=True); sys.exit(2)
ck("cuInit", cu.cuInit(0))
n = ctypes.c_int(0)
ck("cuDeviceGetCount", cu.cuDeviceGetCount(ctypes.byref(n)))
if n.value < 1:
    print("no CUDA devices visible", flush=True); sys.exit(3)
dev = ctypes.c_int(0)
ck("cuDeviceGet", cu.cuDeviceGet(ctypes.byref(dev), 0))
ctx = ctypes.c_void_p()
ck("cuDevicePrimaryCtxRetain", cu.cuDevicePrimaryCtxRetain(ctypes.byref(ctx), dev))
print("ok", flush=True)
"""
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


def _nn_tenant_env(gpu_share: float, pinned: bool) -> dict:
    """The MPS cap env a GPU tenant's wasmtime process runs with. `pinned`
    adds the per-client VRAM limit; dropped when the probe found it poisonous
    (mode "nopin") - the SM cap is the validated, load-bearing one."""
    env = dict(os.environ)
    env["CUDA_MPS_PIPE_DIRECTORY"] = MPS_PIPE_DIR
    env["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] = str(max(1, round(gpu_share * 100)))
    if pinned:
        env["CUDA_MPS_PINNED_DEVICE_MEM_LIMIT"] = f"0={max(1, int(gpu_share * GPU_VRAM_GB * 1024))}M"
    # host-side wasi-nn traces into the tenant's log file (owner-readable via
    # the deployment logs endpoint) - names the backend step a hang died in
    env.setdefault("WASMTIME_LOG", "wasmtime_wasi_nn=debug")
    # ORT's sm_90 FLASH-ATTENTION path (GroupQueryAttention et al) computes
    # kernel-launch heuristics that integer-divide by the device's SM budget;
    # under a small MPS partition (e.g. a 2% tenant of an H200) a denominator
    # floors to zero and the whole process dies with SIGFPE mid-compute
    # (observed live 2026-07-05: exit -8 on llm-chat's first prefill; the
    # identical stack on consumer sm_86 is fine - different kernel family).
    # Disable flash attention for tenants: attention falls back to the
    # memory-efficient kernels, which don't carry that heuristic.
    env.setdefault("ORT_DISABLE_FLASH_ATTENTION", "1")
    # whatever the probe's GPU bisect adopted (e.g. CUDA_MODULE_LOADING=EAGER
    # when lazy loading deadlocks under MPS) applies to every tenant
    env.update(_NN_PROBE.get("env") or {})
    return env


def _nn_probe_once(env: dict) -> tuple:
    """(ok, detail). Runs the cuInit/primary-ctx probe in a subprocess under a
    hard timeout - a HANG is a result here, not a failure mode. Deliberately
    NOT subprocess.run: its timeout path does kill()+wait(), and a child stuck
    in an UNINTERRUPTIBLE kernel ioctl (D-state - how GPU driver hangs look
    under CC) never reaps, blocking the whole probe forever. We poll with a
    deadline and ABANDON an unkillable child rather than wait on it."""
    try:
        proc = subprocess.Popen(["python3", "-c", _NN_PROBE_SRC], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, preexec_fn=_preexec)
    except Exception as e:                                       # noqa: BLE001
        return (False, f"probe spawn failed: {e}")
    deadline = time.time() + NN_PROBE_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            out = (proc.stdout.read() or "").strip() if proc.stdout else ""
            return (proc.returncode == 0 and out.endswith("ok"), out or f"rc={proc.returncode}")
        time.sleep(0.5)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except Exception:                                            # noqa: BLE001
        pass
    for _ in range(10):                                          # 5s of grace to reap
        if proc.poll() is not None:
            return (False, f"HUNG >{NN_PROBE_TIMEOUT:.0f}s (killed)")
        time.sleep(0.5)
    return (False, f"HUNG >{NN_PROBE_TIMEOUT:.0f}s and UNKILLABLE (kernel-stuck GPU ioctl?) - abandoned")


def _proc_hang_dump(pid) -> str:
    """Compact thread dump of a HUNG process, readable without root from the
    same user: per-thread state + kernel wait channel. This is the ground
    truth the whole bisect exists to reach - a D-state thread's wchan names
    the kernel/driver function the hang lives in (platform's bug); an S-state
    futex points back at userspace (ours)."""
    out = []
    base = f"/proc/{pid}/task"
    try:
        maps_n = sum(1 for _ in open(f"/proc/{pid}/maps"))
    except Exception:                                            # noqa: BLE001
        maps_n = -1
    try:
        for tid in sorted(os.listdir(base), key=int):
            try:
                comm = open(f"{base}/{tid}/comm").read().strip()
                state = open(f"{base}/{tid}/stat").read().rsplit(") ", 1)[-1].split()[0]
                try:
                    wchan = open(f"{base}/{tid}/wchan").read().strip() or "0"
                except Exception:                                # noqa: BLE001
                    wchan = "?"
                out.append((state, f"{comm}:{state}:{wchan}"))
            except Exception:                                    # noqa: BLE001
                continue
    except Exception as e:                                       # noqa: BLE001
        return f"dump failed: {e}"
    # D-state threads always shown; the rest deduped by (comm prefix, wchan)
    ds = [s for st, s in out if st == "D"]
    others, seen = [], set()
    for st, s in out:
        if st == "D":
            continue
        key = s.rsplit(":", 1)[-1] + s[:4]
        if key not in seen:
            seen.add(key)
            others.append(s)
    shown = ds + others[: max(0, 14 - len(ds))]
    return f"maps={maps_n} threads({len(out)})=[" + ", ".join(shown) + "]"


def _nn_probe_e2e(env, targets=("cpu", "gpu"), timeout=None, extra_args=()) -> tuple:
    """({target: ok}, detail). The ORT layer, end to end: serve the baked-in
    nn-demo with the real tenant env and run ONE inference per target through
    it. The cuInit probe can pass while ORT's session creation still hangs (it
    exercises cudart/cublas/cuDNN and the CC data path, not just the driver
    attach), so only this stage proves a GPU deployment will actually answer.
    Each call is a FRESH wasmtime process = a fresh CUDA init. On a hang, the
    detail carries a thread dump of the wedged process (state + kernel wchan)."""
    timeout = timeout or NN_PROBE_TIMEOUT
    wasm = APPS_DIR / "nn-demo.wasm"
    if not wasm.is_file():
        return ({t: True for t in targets}, "e2e skipped (nn-demo.wasm not baked in)")
    port = _free_port()
    cmd = [WASMTIME, "serve", "-Scli", "-Shttp", *P3_FLAGS, "-Snn", *extra_args,
           "--addr", f"{HOST_IP}:{port}", str(wasm)]
    try:
        proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                preexec_fn=_preexec)
    except Exception as e:                                       # noqa: BLE001
        return ({t: False for t in targets}, f"e2e spawn failed: {e}")
    try:
        deadline = time.time() + 15
        while time.time() < deadline and not _port_open(port):
            if proc.poll() is not None:
                return ({t: False for t in targets}, f"e2e wasmtime exited rc={proc.returncode} before serving")
            time.sleep(0.2)
        if not _port_open(port):
            return ({t: False for t in targets}, "e2e serve socket never opened")
        parts, results = [], {}
        for tgt in targets:
            t0 = time.time()
            try:
                with urllib.request.urlopen(f"http://{HOST_IP}:{port}/?target={tgt}",
                                            timeout=timeout) as r:
                    body = json.loads(r.read() or b"{}")
                results[tgt] = bool(body.get("ok"))
                parts.append(f"{tgt}: {'ok' if results[tgt] else body.get('error', 'not ok')} ({time.time() - t0:.1f}s)")
            except Exception as e:                               # noqa: BLE001
                results[tgt] = False
                dump = _proc_hang_dump(proc.pid) if proc.poll() is None else f"process exited rc={proc.returncode}"
                parts.append(f"{tgt}: HUNG/failed after {time.time() - t0:.1f}s ({e.__class__.__name__}: {e}) {dump}")
        return (results, "; ".join(parts))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:                                        # noqa: BLE001
            try:
                proc.kill()
            except Exception:                                    # noqa: BLE001
                pass


# Runtime-API bisect: walks the exact CUDA calls ORT's CUDA provider makes at
# session init, journaling each STEP to a file BEFORE executing it - when one
# hangs, the journal's last line names the call. The two calls the passing
# probes never exercised are the prime suspects: cudaHostAlloc (PINNED host
# memory needs shared/unencrypted pages under TDX) and cuBLAS/cuDNN library
# init (their kernel-module upload is the heavyweight step).
_NN_RT_SRC = r"""
import ctypes, sys
log = open(sys.argv[1], "w", buffering=1)
def step(name): log.write("STEP " + name + "\n")
def ck(name, rc):
    if rc != 0:
        log.write(f"FAIL {name} rc={rc}\n"); sys.exit(2)
if len(sys.argv) > 2 and sys.argv[2] == "threads":
    # mimic wasmtime's thread pressure OUTSIDE wasmtime: ~50 threads on the
    # 16-vCPU TDX guest before any CUDA call. If the walk spins HERE too, the
    # hang is thread-count x driver x TDX - wasmtime fully exonerated.
    import threading, time as _t
    step("spawn 48 sleeper threads")
    for _ in range(48):
        threading.Thread(target=_t.sleep, args=(3600,), daemon=True).start()
step("dlopen libcudart.so.12")
try:
    rt = ctypes.CDLL("libcudart.so.12")
except OSError as e:
    log.write(f"SKIP no cudart ({e})\n"); sys.exit(3)
step("cudaSetDevice(0)");         ck("cudaSetDevice", rt.cudaSetDevice(0))
step("cudaFree(0) [ctx init]");   ck("cudaFree0", rt.cudaFree(None))
p = ctypes.c_void_p()
step("cudaMalloc 1MB [device]");  ck("cudaMalloc", rt.cudaMalloc(ctypes.byref(p), 1 << 20))
h = ctypes.c_void_p()
step("cudaHostAlloc 1MB [PINNED host - TDX shared pages]")
ck("cudaHostAlloc", rt.cudaHostAlloc(ctypes.byref(h), 1 << 20, 0))
step("cudaMemcpy pinned H2D 1MB"); ck("cudaMemcpy", rt.cudaMemcpy(p, h, 1 << 20, 1))
step("dlopen libcublas.so.12")
cb = ctypes.CDLL("libcublas.so.12")
bh = ctypes.c_void_p()
step("cublasCreate [cublas init]"); ck("cublasCreate", cb.cublasCreate_v2(ctypes.byref(bh)))
one = ctypes.c_float(1.0); zero = ctypes.c_float(0.0)
step("cublasSgemm 64x64 [kernel-module load + compute]")
ck("cublasSgemm", cb.cublasSgemm_v2(bh, 0, 0, 64, 64, 64, ctypes.byref(one),
                                    p, 64, p, 64, ctypes.byref(zero), p, 64))
step("cudaDeviceSynchronize");    ck("sync", rt.cudaDeviceSynchronize())
step("dlopen libcudnn.so.9")
dn = ctypes.CDLL("libcudnn.so.9")
dh = ctypes.c_void_p()
step("cudnnCreate [cudnn init]"); ck("cudnnCreate", dn.cudnnCreate(ctypes.byref(dh)))
log.write("ok\n")
"""


def _nn_probe_rt(env: dict, threaded=False) -> tuple:
    """(ok, detail). Runs the runtime-API bisect with a hard deadline; on a
    hang, reports the exact CUDA call it died in (journal's last STEP).
    threaded=True first spawns ~50 sleeper threads (wasmtime-like pressure)."""
    jpath = LOG_DIR / f"nn-rt-{uuid.uuid4().hex[:6]}.log"
    argv = ["python3", "-c", _NN_RT_SRC, str(jpath)] + (["threads"] if threaded else [])
    try:
        proc = subprocess.Popen(argv, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                preexec_fn=_preexec)
    except Exception as e:                                       # noqa: BLE001
        return (False, f"rt probe spawn failed: {e}")
    deadline = time.time() + NN_PROBE_TIMEOUT
    while time.time() < deadline and proc.poll() is None:
        time.sleep(0.5)
    hung = proc.poll() is None
    if hung:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:                                        # noqa: BLE001
            pass
    try:
        lines = [l.strip() for l in jpath.read_text().splitlines() if l.strip()]
    except Exception:                                            # noqa: BLE001
        lines = []
    finally:
        try:
            jpath.unlink()
        except Exception:                                        # noqa: BLE001
            pass
    if not hung and lines and lines[-1] == "ok":
        return (True, f"ok ({len(lines) - 1} steps)")
    last = lines[-1] if lines else "(no journal)"
    return (False, (f"HUNG at '{last}' after {NN_PROBE_TIMEOUT:.0f}s" if hung
                    else f"stopped at '{last}' rc={proc.returncode}"))


def _nn_probe_gdb(env, extra_args=()) -> str:
    """Symbol-level stacks of the hang: spawn the e2e wasmtime UNDER gdb (gdb
    as parent dodges ptrace-scope), trigger one gpu load, let it wedge, SIGINT
    gdb (it stops the inferior; batch mode then runs the queued commands), and
    harvest `thread apply all bt`. The full dump goes to the manager log; the
    CUDA/ORT-relevant frames come back for the public trail."""
    if not shutil.which("gdb"):
        return "gdb not in image"
    wasm = APPS_DIR / "nn-demo.wasm"
    if not wasm.is_file():
        return "no nn-demo.wasm"
    port = _free_port()
    cmd = ["gdb", "--batch", "-q",
           "-ex", "set pagination off", "-ex", "set confirm off", "-ex", "run",
           "-ex", "thread apply all bt 24",
           "--args", WASMTIME, "serve", "-Scli", "-Shttp", *P3_FLAGS, "-Snn", *extra_args,
           "--addr", f"{HOST_IP}:{port}", str(wasm)]
    try:
        proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, preexec_fn=_preexec)
    except Exception as e:                                       # noqa: BLE001
        return f"gdb spawn failed: {e}"
    out = ""
    try:
        deadline = time.time() + 40
        while time.time() < deadline and not _port_open(port):
            if proc.poll() is not None:
                out, _ = proc.communicate(timeout=10)
                return f"gdb/wasmtime exited rc={proc.returncode} before serving: {(out or '')[-200:]}"
            time.sleep(0.3)
        if _port_open(port):
            threading.Thread(target=lambda: urllib.request.urlopen(
                f"http://{HOST_IP}:{port}/?target=gpu", timeout=120).read(),
                daemon=True).start()
            time.sleep(45)   # let the init wedge properly before snapping
        try:
            os.kill(proc.pid, signal.SIGINT)   # gdb only: stops the inferior, then bt runs
        except Exception:                                        # noqa: BLE001
            pass
        try:
            out, _ = proc.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            out, _ = proc.communicate(timeout=10)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:                                        # noqa: BLE001
            pass
    out = out or ""
    print("[nn-probe] gdb full dump (tail):\n" + out[-20000:], flush=True)
    # Dedupe by symbol (address-stripped): N identical spinner threads must not
    # crowd out the one interesting stack (v0.5.21's capture was 12 copies of
    # ORT's WorkerLoop). Wide match incl. rust `ort::`/wasmtime symbols.
    frames, seen = [], set()
    for l in out.splitlines():
        ls = l.strip()
        if not re.match(r"#\d+ ", ls):
            continue
        if not re.search(r"cuda|cublas|cudnn|onnx|ort|wasi|nn_|wasmtime", ls, re.I):
            continue
        key = re.sub(r"0x[0-9a-f]+", "", ls).split(" in ", 1)[-1]
        if key in seen:
            continue
        seen.add(key)
        frames.append(ls)
    if not frames:
        frames = [l.strip() for l in out.splitlines() if re.match(r"#\d+ ", l.strip())][:12]
    return ("frames: " + " | ".join(frames[:16])[:1100]) if frames else \
        f"no frames captured (gdb said: {out[-220:]})"


def _nn_probe_worker_control() -> tuple:
    """(ok, detail). Ask the worker manager (if present on this box) to spawn
    one MPS-capped cupy child - the platform's VALIDATED CUDA path - and tear
    it down. Purely diagnostic: discriminates 'this container/ORT is broken'
    from 'GPU compute under CC is broken node-wide'."""
    tid = "nn-probe-control"
    try:
        req = urllib.request.Request(f"{WORKER_MGR_URL}/tenants",
                                     data=json.dumps({"id": tid, "gpuShare": 0.01}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=100) as r:
            body = json.loads(r.read() or b"{}")
        ok = body.get("status") == "running"
        detail = (f"ok (sm_granted={body.get('sm_granted')}, device={body.get('device')})" if ok
                  else f"{body.get('status')}: {body.get('error') or 'no error detail'}")
    except Exception as e:                                       # noqa: BLE001
        return (False, f"unreachable/failed ({e.__class__.__name__}: {e})")
    finally:
        try:
            req = urllib.request.Request(f"{WORKER_MGR_URL}/tenants/{tid}", method="DELETE")
            urllib.request.urlopen(req, timeout=10).read()
        except Exception:                                        # noqa: BLE001
            pass
    return (ok, detail)


def _nn_probe_loop():
    """Crash guard: a probe that dies must VERDICT, not stay 'probing' forever
    (every GPU deploy 503s on that state)."""
    try:
        _nn_probe_run()
    except Exception:                                            # noqa: BLE001
        import traceback
        tb = traceback.format_exc()
        _NN_PROBE.update(state="failed", stage="crashed",
                         detail="probe crashed: " + " | ".join(tb.strip().splitlines()[-3:]))
        print("[nn-probe] CRASHED:\n" + tb, flush=True)


def _nn_probe_run():
    """Boot-time GPU readiness bisect. Writes _NN_PROBE; launches gate on it.
    Layer 1: raw driver (cuInit + primary-ctx retain = the MPS attach point),
    bisecting the env. Layer 2: ORT end to end through the real runtime.
    Progress is published LIVE (stage + growing detail) so an outside observer
    can always tell a slow probe from a stuck one.
    WASM_NN_PROBE=0 skips everything and declares ok (operator escape hatch)."""
    if os.environ.get("WASM_NN_PROBE", "1").lower() in ("0", "false", "off"):
        _NN_PROBE.update(state="ok", mode="full", stage="done", detail="probe skipped (WASM_NN_PROBE=0)")
        print("[nn-probe] skipped by WASM_NN_PROBE=0 - GPU launches ungated", flush=True)
        return
    share = 0.01   # smallest grain; the probe only needs A context, not capacity
    steps = [("full",  _nn_tenant_env(share, pinned=True),
              "tenant env (SM cap + pinned VRAM limit)"),
             ("nopin", _nn_tenant_env(share, pinned=False),
              "without CUDA_MPS_PINNED_DEVICE_MEM_LIMIT"),
             ("nomps", {k: v for k, v in os.environ.items() if not k.startswith("CUDA_MPS")},
              "without any MPS env (diagnostic only - tenants NEVER run uncapped)")]
    history = []
    mode = None
    # up to 3 rounds of the full env first: rides out MPS-daemon boot races the
    # same way worker.py's children retry their CUDA init.
    def note(entry):   # publish progress LIVE: detail grows as the bisect runs
        history.append(entry)
        _NN_PROBE["detail"] = "; ".join(history)

    for attempt in range(3):
        _NN_PROBE["attempts"] = attempt + 1
        _NN_PROBE["stage"] = f"cuInit full env #{attempt + 1}"
        ok, detail = _nn_probe_once(steps[0][1])
        note(f"full#{attempt + 1}: {detail}")
        print(f"[nn-probe] full env attempt {attempt + 1}: {'ok' if ok else detail}", flush=True)
        if ok:
            mode = "full"
            break
        time.sleep(5)
    if mode is None:
        for m, env, label in steps[1:]:
            _NN_PROBE["stage"] = f"cuInit {m}"
            ok, detail = _nn_probe_once(env)
            note(f"{m}: {detail}")
            print(f"[nn-probe] {label}: {'ok' if ok else detail}", flush=True)
            if ok and m == "nopin":
                # the pinned-VRAM var is the poison: run tenants SM-capped only
                # (VRAM stays admission-accounted by the supervisor's allocator).
                print("[nn-probe] WARNING: CUDA_MPS_PINNED_DEVICE_MEM_LIMIT hangs/fails CUDA "
                      "init on this node - GPU tenants run with the SM cap only.", flush=True)
                mode = "nopin"
                break
            if ok and m == "nomps":
                # CUDA works, MPS attach doesn't: refusing is the honest move -
                # uncapped tenants would break the share product.
                _NN_PROBE.update(state="failed", mode=None, stage="done",
                                 detail="MPS attach breaks CUDA init in this container (bare CUDA works). "
                                        + "; ".join(history))
                return
        if mode is None:
            _NN_PROBE.update(state="failed", mode=None, stage="done", detail="; ".join(history))
            return
    # driver layer passed - walk the runtime-API calls ORT will make, so a
    # later e2e hang is pre-attributed to an exact CUDA call (diagnostic; the
    # e2e stage below remains the launch gate)
    base = _nn_tenant_env(share, pinned=(mode == "full"))
    _NN_PROBE["stage"] = "runtime-API bisect (cudaMalloc/pinned/cublas/cudnn)"
    rt_ok, rt_detail = _nn_probe_rt(base)
    note(f"rtapi: {rt_detail}")
    print(f"[nn-probe] runtime-API bisect: {rt_detail}", flush=True)
    _NN_PROBE["stage"] = f"ORT e2e base ({mode}): cpu then gpu, {NN_PROBE_TIMEOUT:.0f}s each"
    res, e2e_detail = _nn_probe_e2e(base)
    note(f"e2e[{mode}]: {e2e_detail}")
    print(f"[nn-probe] ORT end-to-end ({mode}): {e2e_detail}", flush=True)
    if all(res.values()):
        _NN_PROBE.update(state="ok", mode=mode, stage="done", detail="; ".join(history))
        return
    if not res.get("cpu", False):
        # ORT can't even run the CPU provider here - nothing GPU-specific to bisect
        _NN_PROBE.update(state="failed", mode=mode, stage="done",
                         detail="ORT fails on the CPU provider itself - " + "; ".join(history))
        return
    # GPU-only failure. The v0.5.15-0.5.20 exoneration ladder cleared MPS, the
    # pinned limit, lazy loading, slow-CC-load, pooling VA, signal traps, and
    # CoW init individually (kryptos hangs are a userspace SPIN during ORT's
    # CUDA init: one R-state thread, no D-state, driver event thread healthy).
    # This path now EXTRACTS rather than guesses:
    #   rtapi-threaded - the plain-process CUDA walk under wasmtime-like
    #                    thread pressure; a spin HERE fully exonerates wasmtime
    #   gdb            - symbol-level stacks of the actual hang
    #   bare           - the one remaining heal candidate (all flags off)
    _NN_PROBE["stage"] = "rtapi under thread pressure (48 sleepers)"
    tok, tdetail = _nn_probe_rt(base, threaded=True)
    note(f"rtapi-threaded: {tdetail}")
    print(f"[nn-probe] rtapi threaded: {tdetail}", flush=True)
    _NN_PROBE["stage"] = "gdb stack capture of the hang (~2.5 min)"
    gdetail = _nn_probe_gdb(base)
    note(f"gdb: {gdetail}")
    print(f"[nn-probe] gdb frames: {gdetail}", flush=True)
    BARE = ["-O", "pooling-allocator=n", "-O", "signals-based-traps=n", "-O", "memory-init-cow=n"]
    _NN_PROBE["stage"] = "ORT e2e gpu variant 'bare' (all wasmtime flags off)"
    vres, vdetail = _nn_probe_e2e(base, targets=("gpu",), extra_args=BARE)
    note(f"bare: {vdetail}")
    print(f"[nn-probe] gpu variant bare: {vdetail}", flush=True)
    if vres.get("gpu"):
        _NN_PROBE.update(args=BARE)
        note("ADOPTED bare: nn tenants run with pooling, signal traps, and CoW init all off")
        _NN_PROBE.update(state="ok", stage="done", detail="; ".join(history))
        return
    # Every tenant-shaped variant hung. Endgame diagnostics (adopt NOTHING -
    # both would compromise the share caps - but name the guilty layer):
    #   control - the worker container's VALIDATED cupy-under-MPS path
    #   nomps   - ORT with no MPS env at all
    _NN_PROBE["stage"] = "control: worker manager cupy-under-MPS tenant"
    ctl_ok, ctl_detail = _nn_probe_worker_control()
    note(f"control[worker-cupy]: {ctl_detail}")
    print(f"[nn-probe] control worker-cupy: {ctl_detail}", flush=True)
    _NN_PROBE["stage"] = "ORT e2e gpu without MPS (diagnostic only)"
    nomps_env = {k: v for k, v in base.items() if not k.startswith("CUDA_MPS")}
    nomps_res, nomps_detail = _nn_probe_e2e(nomps_env, targets=("gpu",))
    note(f"nomps[diagnostic]: {nomps_detail}")
    print(f"[nn-probe] gpu without MPS (diagnostic): {nomps_detail}", flush=True)
    nomps_ok = bool(nomps_res.get("gpu"))
    if ctl_ok and nomps_ok:
        verdict = ("the MPS+ORT interaction in THIS container is the fault: cupy-under-MPS works "
                   "(worker) and ORT works here without MPS, but ORT under MPS hangs")
    elif ctl_ok:
        verdict = ("this container's GPU compute path is the fault: the worker's cupy-under-MPS "
                   "control works, but ORT hangs here with AND without MPS")
    elif nomps_ok:
        verdict = ("MPS is broken node-wide for real compute init: even the validated worker path "
                   "fails, while ORT works without MPS")
    else:
        verdict = ("GPU compute init is broken NODE-WIDE under CC (the validated worker cupy path "
                   "and ORT, with and without MPS, all fail) - escalate to the platform/driver level")
    _NN_PROBE.update(state="failed", mode=mode, stage="done",
                     detail=f"driver layer ok ({mode}); ORT CUDA hung in every tenant variant. "
                            f"VERDICT: {verdict}. Trail: " + "; ".join(history))


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


def _build_cmd(pspec, wasm, serve_port: int, mem_bytes: int, port_map=None, fsdir=None,
               nn=False):
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
    scratch space); the app sees only that subtree.
    `nn`, when set, grants wasi-nn (`-S nn`): the deployment bought a GPU share,
    so the guest may run ONNX inference through the host runtime (the MPS caps
    ride in the process env, set by launch(), not here)."""
    fs_args = ["--dir", f"{fsdir}::{FS_GUEST_PATH}"] if fsdir else []
    # nn tenants also carry whatever wasmtime flags the boot probe adopted
    # (e.g. -O pooling-allocator=n: serve's default pooling allocator reserves
    # ~6TB of virtual address space, which CUDA init chokes on under TDX).
    # hostcall-fuel: wasmtime caps guest<->host copies per request at 128MiB
    # by default (a DoS guard); an embedded LLM blows through it twice - the
    # model bytes at load() (traps with a bare wasm backtrace, no message at
    # default log levels) and the per-step logits reads on a big vocab
    # (151936 x 4B x 400 tokens = 240MB). 4GiB keeps the guard while clearing
    # any model that passes WASM_MAX_BYTES.
    nn_args = ["-Snn", "-S", "hostcall-fuel=4294967296", *(_NN_PROBE.get("args") or [])] if nn else []
    if pspec["serve"]:
        return ([WASMTIME, "serve", "-Scli", "-Shttp", *P3_FLAGS, *nn_args, *fs_args,
                 "-W", f"max-memory-size={mem_bytes}",
                 "--addr", f"{HOST_IP}:{serve_port}", str(wasm)],
                serve_port, [serve_port])
    port_map = port_map or {}
    nan_ports = ",".join(f"{e}={port_map[e]}" for e in pspec["norm"])
    cmd = [WASMTIME, "run", "-Scli", *P3_FLAGS, *nn_args, "-Stcp", "-Sudp",
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
    # wasi-nn: buying a GPU share grants the interface; the share is enforced
    # per-process by MPS (env below), the same mechanism as the worker backend.
    nn = NN_ENABLED and NODE_HAS_GPU and gpu_share > 0
    rec = {"id": vid, "name": name or vid, "app": app_ref,
           "cpuShare": cpu_share, "gpuShare": gpu_share, "nn": nn,
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
    cmd, host_port, wait_ports = _build_cmd(pspec, wasm, port, mem_bytes, port_map, fsdir, nn)
    rec["hostPort"] = host_port
    rec["endpoint"] = f"http://{HOST_IP}:{host_port}" if host_port else None
    # GPU tenants: the wasmtime process itself is the CUDA process (ORT holds
    # the context), so the MPS caps go in ITS environment — SM% from the bought
    # share, VRAM = share × the card (the same budget the deployment priced).
    # The pipe dir joins the mps-control daemon's server; without these vars a
    # CUDA context would run uncapped, so nn tenants never launch without them.
    # The pinned-VRAM var is dropped when the boot probe found it poisonous
    # (mode "nopin"); the POST handler refuses GPU launches unless the probe
    # passed, so `nn` here implies a probe mode exists.
    env = None
    if nn:
        env = _nn_tenant_env(gpu_share, pinned=_NN_PROBE.get("mode") != "nopin")
        rec["mpsPct"] = max(1, round(gpu_share * 100))
    logf = open(log_path, "wb")
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=logf,
                                stderr=logf, preexec_fn=_preexec, env=env)
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


def _refresh_status(rec: dict) -> None:
    """A tenant that died on its own (fatal signal, OOM-kill, crash) must not
    keep reporting "running": the supervisor routes traffic and RENEWS leases
    on this status (observed live: a SIGFPE'd app served ECONNREFUSED for an
    hour while its lease kept being paid)."""
    proc = rec.get("_proc")
    if rec.get("status") == "running" and proc is not None:
        code = proc.poll()
        if code is not None:
            rec["status"] = "failed"
            rec["error"] = (f"app process died: signal {-code}" if code < 0
                            else f"app process exited (code {code})")
            print(f"[audit] {rec['id']} died: exit={code}", flush=True)


def _public(rec: dict) -> dict:
    _refresh_status(rec)
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
                                    "nn": NN_ENABLED and NODE_HAS_GPU and (MOCK or _NN_PROBE["state"] == "ok"),
                                    "nnProbe": dict(_NN_PROBE),
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
        # Tenant log tail: the wasmtime process's stdout+stderr (stage markers,
        # panics, CUDA/ORT aborts). The supervisor exposes it owner-only at
        # /v1/deployments/:id/logs - a crashed app's last words are the owner's
        # ONLY debugging evidence on this backend.
        m = re.match(r"^/vms/([^/?]+)/logs(?:\?(.*))?$", self.path)
        if m:
            vid = m.group(1)
            q = dict(p.split("=", 1) for p in (m.group(2) or "").split("&") if "=" in p)
            try:
                tail = min(2000, max(1, int(q.get("tail") or 200)))
            except ValueError:
                tail = 200
            with _lock:
                rec = _apps.get(vid)
            if not rec:
                return self._json(404, {"error": "not found"})
            p = pathlib.Path(rec.get("_log") or str(LOG_DIR / f"{vid}.log"))
            try:
                lines = p.read_bytes().decode("utf-8", "replace").splitlines()[-tail:]
            except OSError:
                lines = []
            proc = rec.get("_proc")
            exit_code = proc.poll() if proc is not None else None
            return self._json(200, {"id": vid, "lines": lines,
                                    "exited": exit_code is not None,
                                    "exitCode": exit_code,
                                    "status": rec.get("status"), "error": rec.get("error")})
        if self.path.startswith("/vms/"):
            vid = self.path[len("/vms/"):]
            with _lock:
                rec = _apps.get(vid)
            return self._json(200, _public(rec)) if rec else self._json(404, {"error": "not found"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        # Prefetch: resolve + verify + cache an app's bytes WITHOUT launching.
        # The supervisor calls this before claiming an on-chain deployment so
        # a lease is never burned racing a 100MB+ IPFS fetch against the spawn
        # window - after this, the launch's fetch is a local cache hit.
        if self.path == "/prefetch":
            b = self._body()
            ref = str(b.get("image") or b.get("app") or "").strip()
            if not ref.startswith("ipfs://"):
                return self._json(400, {"error": "prefetch takes an ipfs://<cid> app reference"})
            try:
                t0 = time.time()
                p = _resolve_wasm(ref)
                return self._json(200, {"ok": True, "bytes": p.stat().st_size,
                                        "seconds": round(time.time() - t0, 1)})
            except ValueError as e:
                return self._json(422, {"error": str(e)})
            except Exception as e:
                return self._json(502, {"error": f"prefetch failed: {e}"})
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
        # GPU tenants launch only after the CUDA/MPS probe passed: a hanging
        # CUDA init inside a tenant eats runtime threads until the whole app
        # wedges, so failing the deploy loudly here is the honest alternative.
        if gpu_share > 0 and NN_ENABLED and NODE_HAS_GPU and not MOCK and _NN_PROBE["state"] != "ok":
            msg = ("GPU interface warming up (CUDA readiness probe still running); retry shortly"
                   if _NN_PROBE["state"] == "probing"
                   else f"GPU interface unavailable on this node: {_NN_PROBE['detail'] or 'probe failed'}")
            return self._json(503, {"error": msg, "nnProbe": dict(_NN_PROBE)})
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
           "nn": NN_ENABLED and NODE_HAS_GPU and (MOCK or _NN_PROBE["state"] == "ok"),
           "nn_probe": dict(_NN_PROBE), "gpu_vram_gb": GPU_VRAM_GB,
           "mps_pipe": MPS_PIPE_DIR if (NN_ENABLED and NODE_HAS_GPU) else None,
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
    if _NN_PROBE["state"] == "probing":
        threading.Thread(target=_nn_probe_loop, daemon=True).start()   # gates GPU launches
    print(f"wasm-manager on :{PORT} runtime=wasmtime mock={MOCK} apps_dir={APPS_DIR} "
          f"p3={bool(P3_FLAGS)} fs={FS_ENABLED} nn={_NN_PROBE['state']}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for vid in list(_apps):
            teardown(vid)


if __name__ == "__main__":
    main()
