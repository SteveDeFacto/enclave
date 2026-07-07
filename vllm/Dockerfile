# enclave-vllm - the platform-model inference tier. A thin wrapper over vLLM's
# official OpenAI-server image that serves a Tinfoil Modelwrap volume (the
# weights are attested by the enclave measurement, not baked here).
#
# The base tag tracks the GLM-5.2 recipe build (CUDA 12.9 for Hopper/H200).
# Pinned by DIGEST so the enclave measurement is reproducible - bump the digest
# deliberately when moving vLLM versions (verify GLM parser flags still match).
# vllm/vllm-openai:glm52-cu129 as of 2026-07 (replace @sha256 with the pulled
# digest before release; CI/release.sh pins the enclave-vllm digest into the config).
ARG VLLM_BASE=vllm/vllm-openai:glm52-cu129
FROM ${VLLM_BASE}

# our discovery+launch entrypoint (finds the mpk mount, sets TP to the visible
# GPU count, binds loopback). Overrides the base image's server entrypoint.
COPY entrypoint.sh /usr/local/bin/enclave-vllm-entrypoint.sh
RUN chmod +x /usr/local/bin/enclave-vllm-entrypoint.sh

# GLM-5.2 defaults; override via env in tinfoil-config.yml.
ENV SERVED_MODEL_NAME=glm-5.2 \
    KV_CACHE_DTYPE=fp8 \
    MAX_MODEL_LEN=262144 \
    VLLM_PORT=8000 \
    VLLM_EXTRA_ARGS="--tool-call-parser glm47 --reasoning-parser glm45 --enable-auto-tool-choice --enable-prefix-caching"

ENTRYPOINT ["/usr/local/bin/enclave-vllm-entrypoint.sh"]
