#!/usr/bin/env bash
# build-guest.sh - produce the guest kernel + initramfs + injectable busybox that
# oci2microvm needs to boot OCI images. Run this ONCE on the worker host (Ubuntu
# base), inside the image build. Outputs to /opt/nan/.
#
#   /opt/nan/vmlinuz             guest kernel (virtio built in)
#   /opt/nan/initramfs.cpio.gz   tiny initramfs: mount /dev/vda, switch_root /nan-init
#   /opt/nan/busybox             static busybox injected into each guest rootfs
#
# We use Ubuntu's linux-image-kvm flavour, which is built FOR VMs with virtio_blk,
# virtio_net, virtio_pci and ext4 compiled in (=y). That means the initramfs needs
# no kernel modules at all: just busybox to mount the root disk and switch_root.
# If you swap in a kernel that has virtio as modules, add them to the initramfs
# (copy the .ko closure into ./modules and modprobe them in /init).
set -euo pipefail

OUT=/opt/nan
mkdir -p "$OUT"

echo "[build-guest] installing busybox-static + linux-image-kvm"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends busybox-static linux-image-kvm cpio gzip e2fsprogs >/dev/null

# --- kernel ---------------------------------------------------------------
KVMLINUZ="$(ls -1 /boot/vmlinuz-*-kvm 2>/dev/null | sort -V | tail -1 || true)"
[ -z "$KVMLINUZ" ] && KVMLINUZ="$(ls -1 /boot/vmlinuz-* | sort -V | tail -1)"
cp "$KVMLINUZ" "$OUT/vmlinuz"
echo "[build-guest] kernel: $KVMLINUZ -> $OUT/vmlinuz"

# --- injectable busybox (goes INTO each guest rootfs as /.nan/busybox) -----
BB="$(command -v busybox)"
cp "$BB" "$OUT/busybox"
chmod 0755 "$OUT/busybox"
echo "[build-guest] busybox: $BB -> $OUT/busybox"

# --- initramfs ------------------------------------------------------------
# /init: bring up the virtio root disk and hand off to the guest's /nan-init.
IR="$(mktemp -d)"
mkdir -p "$IR/bin" "$IR/proc" "$IR/sys" "$IR/dev" "$IR/newroot"
cp "$BB" "$IR/bin/busybox"
chmod 0755 "$IR/bin/busybox"

cat > "$IR/init" << 'INIT'
#!/bin/busybox sh
/bin/busybox --install -s /bin
mount -t proc     proc     /proc
mount -t sysfs    sysfs    /sys
mount -t devtmpfs devtmpfs /dev
# virtio is built into the kvm kernel; modprobe is a harmless no-op if so.
for m in virtio virtio_ring virtio_pci virtio_blk virtio_net ext4; do
  modprobe "$m" 2>/dev/null || true
done
# wait briefly for the root disk to appear
for i in $(seq 1 50); do [ -b /dev/vda ] && break; sleep 0.1; done
if [ ! -b /dev/vda ]; then
  echo "[initramfs] /dev/vda never appeared"; exec sh
fi
mount -t ext4 -o rw /dev/vda /newroot || { echo "[initramfs] mount failed"; exec sh; }
echo "[initramfs] switching into guest rootfs"
exec switch_root /newroot /nan-init
INIT
chmod 0755 "$IR/init"

( cd "$IR" && find . -print0 | cpio --null -ov --format=newc 2>/dev/null | gzip -9 > "$OUT/initramfs.cpio.gz" )
rm -rf "$IR"
echo "[build-guest] initramfs -> $OUT/initramfs.cpio.gz ($(du -h "$OUT/initramfs.cpio.gz" | cut -f1))"

echo "[build-guest] done. Set NAN_GUEST_KERNEL=$OUT/vmlinuz NAN_GUEST_INITRD=$OUT/initramfs.cpio.gz NAN_BUSYBOX=$OUT/busybox"
