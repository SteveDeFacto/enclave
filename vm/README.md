# NAN microVM subsystem: boot OCI images as QEMU microVMs

Status: the CPU path is real and tested. A Docker/OCI image is pulled, converted
to a bootable ext4 rootfs, and launched under QEMU with networking and a
host to guest port forward, so the workload's server is reachable. GPU inside the
VM is deliberately GATED OFF (see "GPU" below): a request for `gpu=true` is
refused with 501 until the forwarding agent is implemented. We never hand back a
CPU-only VM to a caller who asked for a GPU.

## Why this exists

A container image is not bootable as a VM: it has no kernel and no init. The
pipeline fills that in:

1. `skopeo` pulls the image daemonlessly into an OCI layout (no Docker daemon;
   Tinfoil forbids one).
2. `umoci` unpacks it to a flat `rootfs/` plus the OCI config.
3. We read entrypoint, cmd, env, and cwd from the config.
4. We inject a static `busybox` and a `/nan-init` into the rootfs, so even
   distroless images (no shell of their own) boot.
5. `mke2fs -d` packs the rootfs into an ext4 disk UNPRIVILEGED (no root, no
   loopback mount). This is the one heavy step and it runs anywhere e2fsprogs
   exists.
6. QEMU boots a host-provided guest kernel plus a tiny initramfs that loads
   virtio and `switch_root`s into the ext4. User-mode networking forwards a host
   loopback port to the guest's app port.

One `share` (0..1) sets everything: `vcpus = share*16`, `ram = share*64 GB`. The
GPU MPS cap is derived too but only applied once forwarding exists.

## What is real vs gated

Real and tested (no qemu/registry needed for the tests):
- resource derivation, `/nan-init` injection (busybox and shell-fallback paths),
  a genuine ext4 build verified by superblock magic, and the full QEMU argv
  including networking and the initramfs. Run `python3 oci2microvm.py selftest`.
- the manager lifecycle: create, list, get, logs, delete, capacity accounting,
  host-port and vsock-CID allocation, and the GPU gate. Exercise it with
  `MOCK_BOOT=1` (real ext4 + real subprocess; only qemu and the registry pull are
  stubbed).

Needs a real host to run (the enclave's GPU container), not the dev box:
- the actual `skopeo`/`umoci` pull and the actual QEMU boot. The manager reports
  exactly what's missing via `GET /health`.

GATED OFF (not implemented):
- GPU inside the VM. `gpu_agent.py` is a skeleton: it holds an MPS-capped CUDA
  context but the CUDA-over-vsock forwarding protocol is not built. A guest VM
  cannot get a fraction of the H200 by VFIO (whole-device; nested passthrough of
  a CC-mode GPU is unavailable), so a real GPU share requires that forwarding
  agent. Until then, microVMs are CPU-only and GPU requests are refused. For GPU
  work today, use the PTX submission worker, not a microVM.

## Hard dependency: KVM

Booting needs `/dev/kvm` exposed by the host and nested VMs permitted. Without
KVM, QEMU falls back to TCG software emulation (10x to 50x slower), which is
unusable for real work. This must be confirmed with Tinfoil; it is the gate on
the whole path.

## Files

| file | role |
|------|------|
| `oci2microvm.py` | image to bootable microVM (importable + CLI) |
| `vmmanager.py`   | the spawn API (POST/GET/DELETE /vms, /vms/{id}/logs, /health) |
| `gpu_agent.py`   | per-VM host-side MPS-capped CUDA context + vsock (SKELETON) |
| `build-guest.sh` | builds the guest kernel + initramfs + injectable busybox into /opt/nan |
| `Dockerfile`     | deployable manager image (installs the toolchain, builds guests) |

## Try it without a GPU, KVM, or a registry

```bash
python3 oci2microvm.py selftest                       # real ext4 build + arg construction
python3 oci2microvm.py plan --image debian:bookworm-slim --share 0.10 --app-port 8000
MOCK_BOOT=1 python3 vmmanager.py &                    # full lifecycle, qemu/pull stubbed
curl -s localhost:8091/health
curl -s -XPOST localhost:8091/vms \
     -d '{"image":"vllm/vllm-openai:latest","share":0.25,"appPort":8000,"name":"glm"}'
curl -s localhost:8091/vms
curl -s localhost:8091/vms/<id>/logs
curl -s -XDELETE localhost:8091/vms/<id>
```

## Host prerequisites (in the enclave container)

`skopeo`, `umoci`, `qemu-system-x86_64`, `e2fsprogs`, and the guest assets in
`/opt/nan` (`vmlinuz`, `initramfs.cpio.gz`, `busybox`) that `build-guest.sh`
produces. The provided `Dockerfile` installs all of it. `build-guest.sh` uses
Ubuntu's `linux-image-kvm`, which has virtio built in, so the initramfs needs no
kernel modules. If you swap kernels, add the virtio module closure to the
initramfs.

## API

```
POST   /vms          {image, share, name?, appPort?, gpu?}  -> 201 {id, status, endpoint, hostPort, ...}
GET    /vms                                                  -> {vms: [...]}
GET    /vms/{id}                                             -> {...}
GET    /vms/{id}/logs                                        -> text/plain (serial console)
DELETE /vms/{id}                                             -> {id, status:"stopping"}
GET    /health                                              -> {status, kvm, gpuForwarding, missing, capacity}
```

## Next step: supervisor integration

This subsystem is a provisioning backend. To let a NAN deployment boot an image
as a microVM, the supervisor would route a deployment that carries an image to
`vmmanager` (`POST /vms`) instead of the PTX worker (`POST /tenants`), and proxy
the deployment's data path to the VM's `hostPort`. That routing is not wired yet;
it is the integration that turns this into a user-facing "bring your own image"
deploy option, and it should wait on the KVM confirmation above.
