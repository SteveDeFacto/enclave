#!/usr/bin/env python3
"""
gpu_agent - host-side GPU slice for ONE microVM.  *** SKELETON ***

Why this exists at all
----------------------
A guest VM cannot be handed a *fraction* of the H200 by VFIO: VFIO is whole-
device, and nested passthrough of a CC-mode GPU into a sub-VM is not available.
So "give the VM a share of the GPU" is necessarily:

    guest CUDA userspace  --(vsock)-->  this agent (host)  --(real CUDA ctx)-->  H200

The agent runs on the host, holds the ONLY real CUDA context for this tenant,
and is MPS-capped to the tenant's share (CUDA_MPS_ACTIVE_THREAD_PERCENTAGE =
share*100 - the same hardware-enforced cap validated via %smid). The guest just
sees a virtual GPU and ships CUDA calls down the vsock; the agent replays them on
its capped context. That is how the share is enforced.

What is REAL here
-----------------
  * the MPS cap (set in the environment by oci2microvm.VMSpec.env) - that is the
    share, and it is hardware-enforced on this process.
  * holding the context and reporting the driver-granted SM count, proving the cap.

What is STUBBED (deliberately, per "ignore GPU security for now")
-----------------------------------------------------------------
  * the CUDA call marshalling over vsock (the virtual-GPU protocol).
  * any bounds-fencing / cross-tenant safety (Layer 4). Until that exists the
    forwarded kernels are UNTRUSTED and this is NOT inter-tenant safe.
"""
from __future__ import annotations
import os, socket, sys, time

MPS_CAP = os.environ.get("CUDA_MPS_ACTIVE_THREAD_PERCENTAGE", "?")
CID     = int(os.environ.get("NAN_VSOCK_CID", "3"))
VSOCK_PORT = 9999

# AF_VSOCK is Linux-only; guard so the file imports anywhere.
HAVE_VSOCK = hasattr(socket, "AF_VSOCK")


def hold_capped_context():
    """Create the capped CUDA context and report the SM count the driver grants.

    The granted SM count is the fluctuation-proof proof the MPS cap applies:
    e.g. cap=25% -> ~33 of 132 SMs. (Same probe as worker.py.)
    """
    try:
        import pycuda.driver as cuda
        cuda.init()
        dev = cuda.Device(0)
        ctx = dev.make_context()
        sms = dev.get_attribute(cuda.device_attribute.MULTIPROCESSOR_COUNT)
        print(f"[gpu_agent] context up | MPS cap={MPS_CAP}% | SMs granted={sms}", flush=True)
        return ctx
    except Exception as e:                       # noqa: BLE001
        print(f"[gpu_agent] no CUDA ({e}); running channel-only (stub)", flush=True)
        return None


def serve():
    ctx = hold_capped_context()
    if not HAVE_VSOCK:
        print("[gpu_agent] AF_VSOCK unavailable on this host; nothing to serve (stub).", flush=True)
        return
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
    s.listen()
    print(f"[gpu_agent] vsock listening (cid={CID}, port={VSOCK_PORT})", flush=True)
    while True:
        conn, _ = s.accept()
        with conn:
            # STUB: a real agent would read a framed CUDA-call request here,
            # replay it on `ctx`, and write back the result. We just ack.
            data = conn.recv(4096)
            conn.sendall(b'{"stub":true,"mps_cap":"%s"}' % MPS_CAP.encode())


if __name__ == "__main__":
    serve()
