# NAN microVM manager - boots OCI images as QEMU microVMs and serves the spawn API.
#
# CPU path is real. GPU-in-VM forwarding is gated off (gpu_agent is a skeleton);
# requests for gpu=true are refused with 501 until NAN_GPU_FORWARDING is enabled
# and the vsock CUDA agent is implemented. For GPU work today, use the PTX worker.
#
# Runs in the enclave. Booting needs /dev/kvm exposed by the host (Tinfoil): without
# it QEMU falls back to TCG software emulation, which is unusably slow. Confirm KVM.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      qemu-system-x86 skopeo e2fsprogs busybox-static cpio gzip \
      python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# umoci (daemonless OCI unpack) - not in apt; fetch the release binary.
RUN curl -fsSL -o /usr/local/bin/umoci \
      https://github.com/opencontainers/umoci/releases/download/v0.4.7/umoci.amd64 \
    && chmod 0755 /usr/local/bin/umoci

# Build the guest kernel + initramfs + injectable busybox into /opt/nan.
COPY build-guest.sh /usr/local/bin/build-guest.sh
RUN chmod +x /usr/local/bin/build-guest.sh && /usr/local/bin/build-guest.sh

COPY oci2microvm.py vmmanager.py gpu_agent.py /opt/nan/
WORKDIR /opt/nan

ENV NAN_GUEST_KERNEL=/opt/nan/vmlinuz \
    NAN_GUEST_INITRD=/opt/nan/initramfs.cpio.gz \
    NAN_BUSYBOX=/opt/nan/busybox \
    VMMGR_PORT=8091
EXPOSE 8091

# Sanity-check the pipeline at build time (ext4 build + arg construction).
RUN python3 oci2microvm.py selftest

CMD ["python3", "vmmanager.py"]
