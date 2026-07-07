# Enclave GPU worker (CuPy). cupy-cuda12x ships precompiled wheels, so this needs NO
# compiler, NO dev headers, and NO NumPy<2 pinning — runtime base is enough.
# Config gives it runtime:nvidia, gpus:all, ipc:host, and the shared
# /tmp/nvidia-mps mount so it joins the MPS daemon.
FROM nvidia/cuda:12.6.2-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

# nvidia-ml-py: NVML bindings for the CC attestation report (/attestation);
# report generation is pure NVML, so the manager still never holds a CUDA context.
RUN pip3 install --break-system-packages --no-cache-dir cupy-cuda12x nvidia-ml-py

COPY worker.py /worker.py
ENV WORKER_PORT=8090
EXPOSE 8090
CMD ["python3", "/worker.py"]
