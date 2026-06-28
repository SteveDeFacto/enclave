#!/usr/bin/env python3
"""
NAN GPU worker — Layer 1 skeleton.

Runs inside the GPU container. Joins the MPS daemon (shared /tmp/nvidia-mps,
ipc:host), holds a CUDA context, and runs a *submitted* compute job — the
submission model. Proves the prod plumbing end to end:

  - MPS cap is HARDWARE-enforced here: /healthz reports the SM count the driver
    actually granted this process (== the validated %smid finding), so an MPS
    ACTIVE_THREAD_PERCENTAGE cap is visible as a reduced SM count.
  - A tenant submits PTX (not a container, not raw CUDA): POST /run loads the
    module, launches it, returns the output buffer.

NOT YET (next layers, deliberately not faked):
  * Layer 2 — one MPS-capped child PROCESS per tenant (isolation boundary).
    This skeleton runs jobs in ITS OWN process; that is NOT inter-tenant safe.
  * Layer 4 — SAFETY: submitted PTX is UNTRUSTED. Before this is exposed to
    real tenants, every load/store in the PTX must be bounds-fenced
    (Guardian/G-Safe address masking) — see fence_ptx() stub below. Until then
    run ONLY trusted PTX.  <-- do not remove this warning lightly.
"""
import os, json, base64, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pycuda.driver as cuda

PORT      = int(os.environ.get("WORKER_PORT", "8090"))
VRAM_GB   = float(os.environ.get("GPU_VRAM_GB", "141"))
MPS_CAP   = os.environ.get("CUDA_MPS_ACTIVE_THREAD_PERCENTAGE")  # set per-process in Layer 2

_ctx = None
_dev_name = "?"
_sm_granted = -1

def init_cuda(retries=30, gap=2.0):
    """Create a context. Retries because the MPS daemon sidecar may still be
    coming up when this container starts (boot race, same pattern as before)."""
    global _ctx, _dev_name, _sm_granted
    last = None
    for _ in range(retries):
        try:
            cuda.init()
            dev = cuda.Device(0)
            _ctx = dev.make_context()
            _dev_name = dev.name()
            # The driver reflects the MPS SM cap in this attribute — reading it
            # back is the fluctuation-proof proof the cap is applied to us.
            _sm_granted = dev.get_attribute(cuda.device_attribute.MULTIPROCESSOR_COUNT)
            print(f"[worker] CUDA up: {_dev_name} | MPS cap={MPS_CAP or 'none'}% "
                  f"| SMs granted={_sm_granted}", flush=True)
            return True
        except Exception as e:
            last = e
            time.sleep(gap)
    print(f"[worker] CUDA init failed after retries: {last}", flush=True)
    return False

def fence_ptx(ptx: bytes) -> bytes:
    """SAFETY STUB (Layer 4). Untrusted PTX must be rewritten so every global
    load/store is masked to the tenant's own allocation (Guardian/G-Safe address
    fencing) before it is allowed to run next to other tenants. Until this is
    real, the worker accepts only TRUSTED ptx (REQUIRE_FENCE gate below)."""
    raise NotImplementedError("PTX bounds-fencing not implemented (Layer 4)")

REQUIRE_FENCE = os.environ.get("REQUIRE_FENCE", "1") not in ("0", "false", "off")

def run_ptx(job: dict) -> dict:
    """Minimal trusted-PTX execution: load module, launch entry, return output.
    job = { ptx_b64, entry, grid:[x,y,z], block:[x,y,z], out_bytes, trusted?:bool }"""
    ptx = base64.b64decode(job["ptx_b64"])
    if REQUIRE_FENCE and not job.get("trusted"):
        ptx = fence_ptx(ptx)  # raises until Layer 4 — refuses untrusted PTX by default

    entry     = job["entry"]
    grid      = tuple(job.get("grid",  [1, 1, 1]))
    block     = tuple(job.get("block", [1, 1, 1]))
    out_bytes = int(job["out_bytes"])

    _ctx.push()
    try:
        mod = cuda.module_from_buffer(ptx)
        fn  = mod.get_function(entry)
        out = cuda.mem_alloc(out_bytes)
        fn(out, grid=grid, block=block)
        cuda.Context.synchronize()
        host = bytearray(out_bytes)
        cuda.memcpy_dtoh(host, out)
        out.free()
        return {"ok": True, "output_b64": base64.b64encode(bytes(host)).decode()}
    finally:
        _ctx.pop()

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

    def do_GET(self):
        if self.path in ("/health", "/healthz"):
            self._send(200 if _ctx else 503, {
                "ok": _ctx is not None, "device": _dev_name,
                "mps_cap_pct": MPS_CAP, "sm_granted": _sm_granted, "vram_gb": VRAM_GB,
            })
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/run":
            return self._send(404, {"error": "not_found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            job = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, run_ptx(job))
        except NotImplementedError as e:
            self._send(403, {"ok": False, "error": "unfenced_ptx_refused", "detail": str(e)})
        except Exception as e:
            self._send(400, {"ok": False, "error": str(e)})

if __name__ == "__main__":
    if not init_cuda():
        raise SystemExit("no CUDA context — is the MPS sidecar up and the GPU attached?")
    print(f"[worker] listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
