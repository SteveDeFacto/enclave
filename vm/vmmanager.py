#!/usr/bin/env python3
"""
vmmanager - the spawn-a-VM API. Runs inside the GPU (worker) container.

The supervisor proxies public /v1/vms/* here over localhost (same pattern it
already uses for the worker). Each VM:

  - is booted from a Docker/OCI image via oci2microvm (CPU path is real)
  - gets vCPU + RAM derived from one `share` (0..1)
  - gets a host->guest port forward so its server is actually reachable
  - (only if GPU forwarding is enabled) a vsock CID + host GPU agent

GPU is GATED, not faked: a request for gpu=true is refused with 501 unless
NAN_GPU_FORWARDING is enabled, because the gpu_agent vsock protocol is still a
skeleton. We never hand back a CPU-only VM to a caller who asked for a GPU.

Endpoints
  POST   /vms          {image, share, name?, appPort?, gpu?}  -> 201 {id, status, endpoint, ...}
  GET    /vms                                                  -> {vms: [...]}
  GET    /vms/{id}                                             -> {...}
  GET    /vms/{id}/logs                                        -> text/plain (serial console)
  DELETE /vms/{id}                                             -> {id, status:"stopping"}
  GET    /health                                              -> {status, kvm, missing, capacity}

State is in-memory (a control-plane process; the supervisor is the source of
truth for billing/quota).
"""
from __future__ import annotations
import json, os, pathlib, secrets, socket, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import oci2microvm as vm

PORT = int(os.environ.get("VMMGR_PORT", "8091"))
NODE_VCPUS = vm.NODE_VCPUS
NODE_RAM_GB = vm.NODE_RAM_GB
GPU_FORWARDING = os.environ.get("NAN_GPU_FORWARDING", "").lower() in ("1", "true", "on")
MOCK_BOOT = os.environ.get("MOCK_BOOT", "").lower() in ("1", "true", "on")
LOG_DIR = pathlib.Path(os.environ.get("NAN_VM_LOGDIR", tempfile.gettempdir())) / "nan-vm-logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_vms: dict[str, dict] = {}
_used_share = 0.0
_free_cids: list[int] = []
_next_cid = 3                      # vsock CIDs 0-2 are reserved


def _new_id() -> str:
    return "vm_" + secrets.token_hex(4)


def _alloc_cid() -> int:
    global _next_cid
    if _free_cids:
        return _free_cids.pop()
    c = _next_cid
    _next_cid += 1
    return c


def _free_cid(c: int) -> None:
    if c and c >= 3:
        _free_cids.append(c)


def _alloc_host_port() -> int:
    """Grab a free loopback TCP port for the host->guest forward."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _capacity() -> dict:
    free = max(0.0, 1.0 - _used_share)
    return {"maxShare": round(free, 4), "usedShare": round(_used_share, 4),
            "vcpusFree": round(free * NODE_VCPUS, 1), "ramGbFree": round(free * NODE_RAM_GB, 1)}


def _public(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if not k.startswith("_")}


def _mock_prepare(image, share, name, work, app_port, host_port):
    """Sandbox/testing: build a REAL ext4 from a synthetic rootfs (no registry),
    and return a VMSpec. Used when MOCK_BOOT is set."""
    res = vm.derive_resources(share)
    rootfs = work / "rootfs"
    (rootfs / "app").mkdir(parents=True)
    (rootfs / "app" / "server").write_bytes(b"#!/bin/true\n")
    cfg = {"args": ["/app/server"], "env": ["PATH=/usr/bin:/bin"], "cwd": "/app"}
    vm.inject_init(rootfs, cfg, None)
    img = vm.build_ext4(rootfs, work / "rootfs.ext4", slack_mb=8)
    return vm.VMSpec(name=name, image=image, share=res["share"], rootfs_img=str(img),
                     app_port=app_port, host_port=host_port, vcpus=res["vcpus"],
                     ram_mib=res["ram_mib"], gpu=False, kvm=False)


def _mock_boot(spec, log_path):
    """A real subprocess we can manage/kill, standing in for qemu under MOCK_BOOT."""
    import subprocess
    script = (f"import time,sys;"
              f"open({log_path!r},'a').write('[mock-boot] {spec.image} up on guest :{spec.app_port}\\n');"
              f"sys.exit(0) if False else time.sleep(36000)")
    return subprocess.Popen(["python3", "-c", script])


def _spawn(image: str, share: float, name: str, app_port: int, gpu: bool) -> dict:
    global _used_share
    vid = _new_id()
    cid = _alloc_cid() if gpu else 0
    host_port = _alloc_host_port()
    res = vm.derive_resources(share)
    log_path = str(LOG_DIR / f"{vid}.log")
    rec = {
        "id": vid, "name": name or vid, "image": image,
        "share": res["share"], "pct": res["pct"], "vcpus": res["vcpus"],
        "ramMib": res["ram_mib"], "gpu": gpu, "gpuMpsPct": res["gpu_mps_pct"] if gpu else None,
        "cid": cid or None, "appPort": app_port, "hostPort": host_port,
        "endpoint": f"http://127.0.0.1:{host_port}",
        "status": "provisioning", "createdAt": time.time(), "error": None,
        "_proc": None, "_log": log_path,
    }
    with _lock:
        _vms[vid] = rec
        _used_share += res["share"]

    def worker():
        try:
            work = pathlib.Path(tempfile.mkdtemp(prefix=f"nanvm-{vid}-"))
            rec["status"] = "building"
            if MOCK_BOOT:
                spec = _mock_prepare(image, share, name or vid, work, app_port, host_port)
                rec["status"] = "booting"
                proc = _mock_boot(spec, log_path)
            else:
                spec = vm.prepare(image, share, name or vid, work, app_port=app_port,
                                  host_port=host_port, gpu=gpu, cid=cid)
                rec["status"] = "booting"
                proc = vm.boot(spec, log_path=log_path)
            rec["_proc"] = proc
            rec["status"] = "running"
            proc.wait()
            if rec["status"] == "running":
                rec["status"] = "stopped"
        except Exception as e:  # noqa: BLE001 - surface failure to the API
            rec["status"] = "failed"
            rec["error"] = str(e)
        finally:
            with _lock:
                global _used_share
                _used_share = max(0.0, _used_share - rec["share"])
                _free_cid(cid)

    threading.Thread(target=worker, daemon=True).start()
    return rec


def _kill(vid: str) -> bool:
    rec = _vms.get(vid)
    if not rec:
        return False
    proc = rec.get("_proc")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    rec["status"] = "stopped"
    return True


def _logs(vid: str, tail: int = 200):
    rec = _vms.get(vid)
    if not rec:
        return None
    p = rec.get("_log")
    if not p or not os.path.exists(p):
        return ""
    with open(p, "r", errors="replace") as f:
        lines = f.readlines()
    return "".join(lines[-tail:])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _text(self, code: int, body: str):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "ok", "kvm": os.path.exists("/dev/kvm"),
                                    "gpuForwarding": GPU_FORWARDING, "mockBoot": MOCK_BOOT,
                                    "missing": vm.missing_prereqs(False),
                                    "capacity": _capacity()})
        if self.path == "/vms":
            return self._json(200, {"vms": [_public(r) for r in _vms.values()]})
        if self.path.startswith("/vms/") and self.path.endswith("/logs"):
            vid = self.path[len("/vms/"):-len("/logs")]
            txt = _logs(vid)
            return self._text(200, txt) if txt is not None else self._json(404, {"error": "no such vm"})
        if self.path.startswith("/vms/"):
            rec = _vms.get(self.path.split("/", 2)[2])
            return self._json(200, _public(rec)) if rec else self._json(404, {"error": "no such vm"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/vms":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})
        image = req.get("image")
        share = req.get("share")
        gpu = bool(req.get("gpu", False))
        app_port = int(req.get("appPort", 8080))
        if not image or not isinstance(share, (int, float)):
            return self._json(422, {"error": "image (str) and share (0..1) required"})
        if not (0 < share <= 1):
            return self._json(422, {"error": "share must be in (0, 1]"})
        if gpu and not GPU_FORWARDING:
            return self._json(501, {"error": "gpu_forwarding_unavailable",
                                    "message": "GPU-in-VM forwarding is not implemented yet "
                                               "(gpu_agent vsock protocol is a skeleton). "
                                               "Request gpu=false for a CPU-only microVM."})
        with _lock:
            if share > (1.0 - _used_share) + 1e-9:
                return self._json(409, {"error": "not enough free share", "capacity": _capacity()})
        rec = _spawn(image, float(share), req.get("name", ""), app_port, gpu)
        return self._json(201, _public(rec))

    def do_DELETE(self):
        if self.path.startswith("/vms/"):
            vid = self.path.split("/", 2)[2]
            ok = _kill(vid)
            return self._json(200, {"id": vid, "status": "stopping"}) if ok \
                else self._json(404, {"error": "no such vm"})
        return self._json(404, {"error": "not found"})


def main():
    print(f"[vmmanager] listening on :{PORT}  (kvm={os.path.exists('/dev/kvm')}, "
          f"gpuForwarding={GPU_FORWARDING}, mockBoot={MOCK_BOOT}, "
          f"node={NODE_VCPUS}vCPU/{NODE_RAM_GB}GB)", flush=True)
    miss = vm.missing_prereqs(False)
    if miss and not MOCK_BOOT:
        print(f"[vmmanager] NOTE missing prereqs (boots will fail until present): {', '.join(miss)}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
