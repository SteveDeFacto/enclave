#!/usr/bin/env python3
"""
oci2microvm - boot a Docker/OCI image as a QEMU microVM (CPU path is real).

A container image is NOT bootable as a VM on its own: it has no kernel and no
init. The pipeline:

  1. pull   the image daemonlessly (skopeo)              -> OCI layout
  2. unpack it to a flat rootfs (umoci)                  -> rootfs/ + config.json
  3. read   the image config (entrypoint/cmd/env/cwd)
  4. inject a static busybox + /nan-init into the rootfs so the guest can boot
            even if the image ships no shell (distroless)
  5. pack   the rootfs into an ext4 disk (mke2fs -d, UNPRIVILEGED)
  6. boot   QEMU with:
              - a host-provided guest kernel + initramfs (the initramfs loads
                virtio_blk and switch_roots into the ext4, so STOCK kernels work)
              - vCPU/RAM derived from the tenant's card share
              - user-mode networking with a host->guest port forward, so the
                workload's server is actually reachable
              - (only when GPU forwarding is enabled) a vsock channel to the
                host GPU agent

GPU: a guest cannot get a *fraction* of the H200 by VFIO (whole-device; nested
passthrough of a CC-mode GPU is unavailable). "Give the VM a GPU share" therefore
requires a host CUDA agent that holds an MPS-capped context and serves the guest's
CUDA over vsock - see gpu_agent.py. That forwarding is NOT implemented yet, so by
default a microVM here is CPU-ONLY and we say so. We never silently hand back a
GPU-less VM to a caller who asked for GPU; the manager gates that explicitly.

Import-safe and CLI-runnable:
    python3 oci2microvm.py run   --image debian:bookworm-slim --share 0.10 --app-port 8000
    python3 oci2microvm.py plan  --image debian:bookworm-slim --share 0.10 --app-port 8000
    python3 oci2microvm.py selftest          # real ext4 build + arg construction, no qemu needed
"""
from __future__ import annotations
import argparse, json, os, shlex, shutil, subprocess, sys, tempfile
from dataclasses import dataclass
from pathlib import Path

# ---- node capacity (must match the enclave; same numbers as the supervisor) ----
NODE_VCPUS  = int(os.environ.get("NODE_VCPUS", "16"))
NODE_RAM_GB = int(os.environ.get("NODE_RAM_GB", "64"))
MIN_PCT     = 1   # 1% floor, same grain as the rest of NAN

# ---- host-provided guest kernel + initramfs (built by build-guest.sh) ----------
#   The initramfs is what makes STOCK kernels work: it loads virtio_blk and
#   switch_roots into /dev/vda. A custom kernel with virtio built in can boot
#   without it (set NAN_GUEST_INITRD="").
GUEST_KERNEL  = os.environ.get("NAN_GUEST_KERNEL",  "/opt/nan/vmlinuz")
GUEST_INITRD  = os.environ.get("NAN_GUEST_INITRD",  "/opt/nan/initramfs.cpio.gz")
# A static busybox injected into the guest so even distroless images have a shell
# for /nan-init. build-guest.sh drops one here.
GUEST_BUSYBOX = os.environ.get("NAN_BUSYBOX",       "/opt/nan/busybox")

GUEST_CMDLINE_BASE = "console=ttyS0 root=/dev/vda rw quiet"
# When an initramfs is used it owns /init and switch_roots to /nan-init itself,
# so we do NOT pass init= on the cmdline. Without an initramfs we boot /nan-init
# directly and the kernel must have virtio_blk + ext4 built in.
GUEST_CMDLINE_NOINITRD = GUEST_CMDLINE_BASE + " init=/nan-init"

ROOTFS_SLACK_MB = int(os.environ.get("ROOTFS_SLACK_MB", "512"))


def sh(cmd, **kw):
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw)


def have(tool):
    return shutil.which(tool) is not None


def derive_resources(share):
    """One share -> a matching slice of vCPU / RAM / GPU. Nothing stranded."""
    share = max(MIN_PCT / 100.0, min(1.0, share))
    pct = round(share * 100)
    vcpus = max(1, round(share * NODE_VCPUS))
    ram_mib = max(256, round(share * NODE_RAM_GB * 1024))
    return {"share": share, "pct": pct, "vcpus": vcpus, "ram_mib": ram_mib, "gpu_mps_pct": pct}


# ----------------------------------------------------------------------------- #
#  Image -> rootfs
# ----------------------------------------------------------------------------- #
def pull_and_unpack(image, work):
    """skopeo copy docker://<image> -> oci: , then umoci unpack -> bundle/rootfs."""
    if not have("skopeo") or not have("umoci"):
        raise RuntimeError("need skopeo + umoci on the host (see README prerequisites)")
    oci = work / "oci"
    bundle = work / "bundle"
    tag = "img"
    sh(["skopeo", "copy", f"docker://{image}", f"oci:{oci}:{tag}"])
    sh(["umoci", "unpack", "--rootless", "--image", f"{oci}:{tag}", str(bundle)])
    rootfs = bundle / "rootfs"
    if not rootfs.is_dir():
        raise RuntimeError(f"unpack produced no rootfs at {rootfs}")
    return bundle


def read_image_config(bundle):
    """entrypoint/cmd/env/cwd from the OCI runtime config umoci wrote."""
    cfg = json.loads((bundle / "config.json").read_text())
    proc = cfg.get("process", {})
    args = proc.get("args", []) or ["/bin/sh"]
    env = proc.get("env", []) or []
    cwd = proc.get("cwd", "/") or "/"
    return {"args": args, "env": env, "cwd": cwd}


# /nan-init: minimal pid-1 for an OCI image booted as a microVM. We point its
# shebang at a busybox WE inject, so images with no shell (distroless) still boot.
NAN_INIT_BUSYBOX = """#!/.nan/busybox sh
# nan-init: pid-1 for an OCI image booted as a microVM (injected busybox).
/.nan/busybox mount -t proc     proc     /proc    2>/dev/null
/.nan/busybox mount -t sysfs    sysfs    /sys     2>/dev/null
/.nan/busybox mount -t devtmpfs devtmpfs /dev     2>/dev/null
/.nan/busybox mkdir -p /dev/pts /dev/shm
/.nan/busybox mount -t devpts devpts /dev/pts     2>/dev/null
/.nan/busybox mount -t tmpfs  tmpfs  /dev/shm     2>/dev/null
{env_exports}
cd {cwd} 2>/dev/null || cd /
echo "[nan-init] exec: {pretty_args}"
exec {exec_args}
"""

NAN_INIT_SHELL = """#!/bin/sh
# nan-init: pid-1 for an OCI image booted as a microVM (image-provided shell).
mount -t proc     proc     /proc    2>/dev/null || true
mount -t sysfs    sysfs    /sys     2>/dev/null || true
mount -t devtmpfs devtmpfs /dev     2>/dev/null || true
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts     2>/dev/null || true
mount -t tmpfs  tmpfs  /dev/shm     2>/dev/null || true
{env_exports}
cd {cwd} 2>/dev/null || cd /
echo "[nan-init] exec: {pretty_args}"
exec {exec_args}
"""


def inject_init(rootfs, cfg, busybox_src):
    """Drop a static busybox + /nan-init into the rootfs.

    The injected busybox guarantees a shell even for distroless images. If no
    busybox is provided we write /nan-init pointing at /bin/sh (works only if the
    image ships one).
    """
    env_exports = "\n".join(
        f"export {shlex.quote(e.split('=', 1)[0])}={shlex.quote(e.split('=', 1)[1])}"
        for e in cfg["env"] if "=" in e
    )
    exec_args = " ".join(shlex.quote(a) for a in cfg["args"])
    pretty = " ".join(cfg["args"])
    cwd = shlex.quote(cfg["cwd"])

    if busybox_src and Path(busybox_src).is_file():
        nan_dir = rootfs / ".nan"
        nan_dir.mkdir(parents=True, exist_ok=True)
        bb_dst = nan_dir / "busybox"
        shutil.copy2(busybox_src, bb_dst)
        bb_dst.chmod(0o755)
        init = NAN_INIT_BUSYBOX.format(env_exports=env_exports, cwd=cwd,
                                       pretty_args=pretty, exec_args=exec_args)
    else:
        init = NAN_INIT_SHELL.format(env_exports=env_exports, cwd=cwd,
                                     pretty_args=pretty, exec_args=exec_args)
    p = rootfs / "nan-init"
    p.write_text(init)
    p.chmod(0o755)


def dir_size_mb(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            fp = Path(root) / f
            try:
                total += fp.stat(follow_symlinks=False).st_size
            except OSError:
                pass
    return total // (1024 * 1024) + 1


def build_ext4(rootfs, out, slack_mb=ROOTFS_SLACK_MB):
    """Pack a directory tree into an ext4 image WITHOUT root/mount, via mke2fs -d."""
    if not have("mke2fs"):
        raise RuntimeError("need e2fsprogs (mke2fs) on the host")
    size_mb = dir_size_mb(rootfs) + slack_mb
    sh(["mke2fs", "-q", "-F", "-t", "ext4", "-L", "nanroot",
        "-d", str(rootfs), str(out), f"{size_mb}M"])
    return out


# ----------------------------------------------------------------------------- #
#  QEMU command
# ----------------------------------------------------------------------------- #
@dataclass
class VMSpec:
    name: str
    image: str
    share: float
    rootfs_img: str
    app_port: int = 8080          # the port the guest workload listens on
    host_port: int = 0            # host port forwarded to app_port (0 => none)
    kernel: str = GUEST_KERNEL
    initrd: str = GUEST_INITRD    # "" => boot /nan-init directly (custom kernel)
    vcpus: int = 1
    ram_mib: int = 512
    gpu: bool = False             # GPU forwarding requested (needs the agent)
    gpu_mps_pct: int = MIN_PCT
    cid: int = 0                  # vsock CID for the GPU agent (only if gpu)
    kvm: bool = True

    def qemu_argv(self):
        use_initrd = bool(self.initrd)
        cmdline = GUEST_CMDLINE_BASE if use_initrd else GUEST_CMDLINE_NOINITRD
        argv = [
            "qemu-system-x86_64",
            "-machine", "q35,accel=kvm" if self.kvm else "q35,accel=tcg",
            "-cpu", "host" if self.kvm else "max",
            "-smp", str(self.vcpus),
            "-m", f"{self.ram_mib}M",
            "-nographic", "-no-reboot",
            "-kernel", self.kernel,
        ]
        if use_initrd:
            argv += ["-initrd", self.initrd]
        argv += [
            "-append", cmdline,
            "-drive", f"file={self.rootfs_img},format=raw,if=virtio",
            "-netdev", self._netdev(),
            "-device", "virtio-net-pci,netdev=net0",
            "-serial", "mon:stdio",
        ]
        if self.gpu:
            argv += ["-device", f"vhost-vsock-pci,guest-cid={self.cid}"]
        return argv

    def _netdev(self):
        s = "user,id=net0"
        if self.host_port:
            s += f",hostfwd=tcp:127.0.0.1:{self.host_port}-:{self.app_port}"
        return s

    def env(self):
        e = {}
        if self.gpu:
            e["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] = str(self.gpu_mps_pct)
            e["NAN_VSOCK_CID"] = str(self.cid)
        return e


# ----------------------------------------------------------------------------- #
#  Orchestration
# ----------------------------------------------------------------------------- #
def prepare(image, share, name, work, app_port=8080, host_port=0,
            gpu=False, cid=0, busybox=GUEST_BUSYBOX):
    """Everything up to (not including) booting QEMU. Returns a ready VMSpec."""
    res = derive_resources(share)
    bundle = pull_and_unpack(image, work)
    cfg = read_image_config(bundle)
    inject_init(bundle / "rootfs", cfg, busybox)
    rootfs_img = build_ext4(bundle / "rootfs", work / "rootfs.ext4")
    return VMSpec(
        name=name, image=image, share=res["share"], rootfs_img=str(rootfs_img),
        app_port=app_port, host_port=host_port,
        vcpus=res["vcpus"], ram_mib=res["ram_mib"],
        gpu=gpu, gpu_mps_pct=res["gpu_mps_pct"], cid=cid,
        kvm=os.path.exists("/dev/kvm"),
    )


def missing_prereqs(spec_gpu=False):
    """What the host is missing to actually boot. Honest, not faked."""
    miss = []
    if not have("qemu-system-x86_64"): miss.append("qemu-system-x86_64")
    if not have("skopeo"):             miss.append("skopeo")
    if not have("umoci"):              miss.append("umoci")
    if not have("mke2fs"):             miss.append("e2fsprogs(mke2fs)")
    if not Path(GUEST_KERNEL).is_file():                 miss.append(f"guest kernel ({GUEST_KERNEL})")
    if GUEST_INITRD and not Path(GUEST_INITRD).is_file(): miss.append(f"initramfs ({GUEST_INITRD})")
    if not os.path.exists("/dev/kvm"): miss.append("/dev/kvm (would fall back to slow TCG)")
    if spec_gpu:                       miss.append("GPU forwarding (gpu_agent vsock protocol not implemented)")
    return miss


def boot(spec, log_path=None):
    env = {**os.environ, **spec.env()}
    if log_path:
        lf = open(log_path, "wb")
        return subprocess.Popen(spec.qemu_argv(), env=env, stdout=lf, stderr=lf, stdin=subprocess.DEVNULL)
    return subprocess.Popen(spec.qemu_argv(), env=env)


# ----------------------------------------------------------------------------- #
#  CLI
# ----------------------------------------------------------------------------- #
def _spec_for_plan(a):
    res = derive_resources(a.share)
    return VMSpec(name=a.name, image=a.image, share=res["share"],
                  rootfs_img="<work>/rootfs.ext4", app_port=a.app_port,
                  host_port=a.host_port, vcpus=res["vcpus"], ram_mib=res["ram_mib"],
                  gpu=a.gpu, gpu_mps_pct=res["gpu_mps_pct"], cid=a.cid,
                  kvm=os.path.exists("/dev/kvm"))


def cmd_plan(a):
    res = derive_resources(a.share)
    spec = _spec_for_plan(a)
    print(f"image      : {a.image}")
    print(f"share      : {res['pct']}%  ->  {res['vcpus']} vCPU, {res['ram_mib']} MiB RAM"
          + (f", GPU MPS cap {res['gpu_mps_pct']}%" if a.gpu else ", CPU-only"))
    print(f"network    : host 127.0.0.1:{a.host_port or '<none>'} -> guest :{a.app_port}")
    print(f"kvm        : {'yes' if spec.kvm else 'NO -> TCG software emulation (slow)'}")
    print(f"initramfs  : {spec.initrd or '<none> (custom kernel must have virtio built in)'}")
    if a.gpu:
        print(f"agent env  : {spec.env()}")
    miss = missing_prereqs(a.gpu)
    print(f"missing    : {', '.join(miss) if miss else 'nothing (ready to boot)'}")
    print("qemu       : " + " ".join(shlex.quote(x) for x in spec.qemu_argv()))


def cmd_run(a):
    if a.gpu:
        sys.exit("GPU forwarding is not implemented (gpu_agent is a skeleton). "
                 "Re-run without --gpu for a CPU-only microVM, or implement the vsock CUDA agent first.")
    if not have("qemu-system-x86_64"):
        sys.exit("qemu-system-x86_64 not found (this runs in the GPU/worker container, not here)")
    work = Path(tempfile.mkdtemp(prefix=f"nanvm-{a.name}-"))
    print(f"[oci2microvm] work dir: {work}")
    spec = prepare(a.image, a.share, a.name, work, app_port=a.app_port,
                   host_port=a.host_port, gpu=False)
    cmd_plan(a)
    print("[oci2microvm] booting...")
    boot(spec).wait()


def cmd_selftest(a):
    """Exercise the parts that DON'T need qemu/kvm/registry: config parse, init
    injection, a REAL ext4 build, and qemu arg construction (net + initramfs)."""
    print("== selftest: resource derivation ==")
    for s in (0.01, 0.10, 0.25, 0.5, 1.0):
        r = derive_resources(s)
        print(f"  share {s:>4} -> {r['pct']:>3}%  {r['vcpus']:>2} vCPU  {r['ram_mib']:>6} MiB  gpu {r['gpu_mps_pct']}%")

    print("== selftest: init injection (distroless: inject busybox) ==")
    cfg = {"args": ["/app/server", "--port", "8000"],
           "env": ["PATH=/usr/bin:/bin", "MODEL=glm"], "cwd": "/app"}
    work = Path(tempfile.mkdtemp(prefix="nanvm-selftest-"))
    rootfs = work / "rootfs"
    (rootfs / "app").mkdir(parents=True)
    (rootfs / "app" / "server").write_bytes(b"\x7fELF placeholder\n" * 64)
    fake_bb = work / "busybox"; fake_bb.write_bytes(b"\x7fELF busybox\n" * 64); fake_bb.chmod(0o755)
    inject_init(rootfs, cfg, str(fake_bb))
    init_txt = (rootfs / "nan-init").read_text()
    assert (rootfs / ".nan" / "busybox").is_file(), "busybox not injected"
    assert init_txt.startswith("#!/.nan/busybox sh"), "init not using injected busybox"
    assert "exec /app/server --port 8000" in init_txt and "export MODEL=glm" in init_txt and "cd /app" in init_txt
    print("  /.nan/busybox injected; /nan-init uses it + has entrypoint/env/cwd  OK")

    print("== selftest: init injection (image ships a shell: no busybox) ==")
    rootfs2 = work / "rootfs2"; (rootfs2 / "bin").mkdir(parents=True)
    inject_init(rootfs2, cfg, None)
    t2 = (rootfs2 / "nan-init").read_text()
    assert t2.startswith("#!/bin/sh") and "mount -t proc" in t2 and "exec /app/server" in t2
    print("  /nan-init falls back to /bin/sh + bare mounts  OK")

    print("== selftest: REAL ext4 build via mke2fs -d (unprivileged) ==")
    img = build_ext4(rootfs, work / "rootfs.ext4", slack_mb=8)
    with open(img, "rb") as f:
        f.seek(0x438); magic = f.read(2)
    assert magic == b"\x53\xef", "ext4 superblock magic not found"
    print(f"  built {img.name} ({img.stat().st_size // 1024} KiB), ext4 magic OK")

    print("== selftest: QEMU argv (networking + initramfs, CPU-only) ==")
    spec = VMSpec(name="st", image="busybox", share=0.25, rootfs_img=str(img),
                  app_port=8000, host_port=34567, vcpus=4, ram_mib=16384,
                  initrd="/opt/nan/initramfs.cpio.gz", gpu=False, kvm=False)
    j = " ".join(spec.qemu_argv())
    for needle in ("accel=tcg", "-smp 4", "16384M", "-initrd /opt/nan/initramfs.cpio.gz",
                   "hostfwd=tcp:127.0.0.1:34567-:8000", "virtio-net-pci,netdev=net0", str(img)):
        assert needle in j, f"missing {needle!r} in qemu argv"
    assert "vhost-vsock" not in j, "CPU-only VM should not wire vsock"
    assert spec.env() == {}, "CPU-only VM should set no GPU env"
    print("  CPU-only argv has net + initramfs, no vsock/GPU env  OK")

    print("== selftest: QEMU argv (GPU requested: vsock + MPS env) ==")
    g = VMSpec(name="g", image="x", share=0.25, rootfs_img=str(img), gpu=True,
               gpu_mps_pct=25, cid=42, kvm=False)
    jg = " ".join(g.qemu_argv())
    assert "vhost-vsock-pci,guest-cid=42" in jg
    assert g.env()["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] == "25"
    print("  GPU argv wires vsock + sets MPS cap  OK (forwarding itself still a skeleton)")

    shutil.rmtree(work, ignore_errors=True)
    print("\nALL SELFTESTS PASSED")


def main():
    ap = argparse.ArgumentParser(prog="oci2microvm")
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--image", required=True)
    common.add_argument("--share", type=float, required=True, help="0..1 fraction of the card")
    common.add_argument("--name", default="vm")
    common.add_argument("--app-port", type=int, default=8080, help="port the guest workload listens on")
    common.add_argument("--host-port", type=int, default=0, help="host port forwarded to the guest")
    common.add_argument("--gpu", action="store_true", help="request GPU forwarding (not yet implemented)")
    common.add_argument("--cid", type=int, default=3, help="vsock guest CID (only used with --gpu)")
    sub.add_parser("plan", parents=[common]).set_defaults(func=cmd_plan)
    sub.add_parser("run",  parents=[common]).set_defaults(func=cmd_run)
    sub.add_parser("selftest").set_defaults(func=cmd_selftest)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
