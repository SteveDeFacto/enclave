#!/usr/bin/env bash
# enclave-vllm entrypoint: serve an ATTESTED model volume with vLLM's OpenAI API.
#
# The model weights are NOT in this image - they arrive as a Tinfoil Modelwrap
# volume (dm-verity image mounted read-only at MODEL_VOLUME_ROOT/mpk-<hash>,
# whose root hash is in the enclave measurement, so the attestation commits to
# the exact bytes). We discover that mount and hand its path to `vllm serve`.
# vLLM binds loopback only; the supervisor is the sole public ingress (it
# proxies /v1/chat|completions|models to us over the attested shim).
#
# Env (all optional; sane defaults for GLM-5.2-FP8 on 8xH200):
#   MODEL_DIR        explicit model path (skips discovery)
#   MODEL_VOLUME_ROOT  where Modelwrap mounts live (default /tinfoil/mpk)
#   SERVED_MODEL_NAME  OpenAI model id clients use (default glm-5.2)
#   TENSOR_PARALLEL  GPUs to shard across (default = nvidia-smi count, else 8)
#   MAX_MODEL_LEN    context window (default 262144; GLM supports up to 1M)
#   KV_CACHE_DTYPE   default fp8 (halves KV cache; Hopper-native)
#   GPU_MEMORY_UTILIZATION  fraction of each card vLLM may claim (default 0.90,
#                    vLLM's own default). Lower it when the flavor co-hosts the
#                    per-tenant GPU stack on the same card (enclaves/gpu) so
#                    tenant MPS shares keep their VRAM budget.
#   VLLM_PORT        loopback port for the OpenAI server (default 8000)
#   PLATFORM_MODEL_KEY  require this Bearer key on the OpenAI API (must equal the
#                    supervisor's PLATFORM_MODEL_KEY, which it re-asserts upstream).
#                    Unset = open on loopback. SET IT before enabling a co-hosted
#                    platform-model tier: all containers share one net namespace,
#                    so a run-mode tenant with -Sinherit-network can reach
#                    127.0.0.1:8000 and bill-bypass the supervisor gate otherwise.
#   VLLM_EXTRA_ARGS  appended verbatim (parsers, quant flags, etc.)
set -euo pipefail

MODEL_VOLUME_ROOT="${MODEL_VOLUME_ROOT:-/tinfoil/mpk}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-glm-5.2}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-262144}"
KV_CACHE_DTYPE="${KV_CACHE_DTYPE:-fp8}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
VLLM_PORT="${VLLM_PORT:-8000}"

# --- locate the model ------------------------------------------------------- #
if [ -z "${MODEL_DIR:-}" ]; then
  # exactly one mpk-* mount is the common case; if several, set MODEL_DIR.
  shopt -s nullglob
  mounts=("$MODEL_VOLUME_ROOT"/mpk-*)
  shopt -u nullglob
  if [ "${#mounts[@]}" -eq 0 ]; then
    echo "enclave-vllm: no model volume under $MODEL_VOLUME_ROOT/mpk-* - is the Modelwrap models: entry declared and mounted?" >&2
    exit 1
  fi
  if [ "${#mounts[@]}" -gt 1 ]; then
    echo "enclave-vllm: multiple model volumes found (${mounts[*]}); set MODEL_DIR to pick one" >&2
    exit 1
  fi
  MODEL_DIR="${mounts[0]}"
fi
if [ ! -d "$MODEL_DIR" ]; then
  echo "enclave-vllm: MODEL_DIR $MODEL_DIR is not a directory" >&2
  exit 1
fi

# --- tensor parallelism = visible GPU count (fallback 8) -------------------- #
if [ -z "${TENSOR_PARALLEL:-}" ]; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    TENSOR_PARALLEL="$(nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')"
  fi
  TENSOR_PARALLEL="${TENSOR_PARALLEL:-8}"
fi

echo "enclave-vllm: serving $MODEL_DIR as '$SERVED_MODEL_NAME' | TP=$TENSOR_PARALLEL kv=$KV_CACHE_DTYPE ctx=$MAX_MODEL_LEN gpu-util=$GPU_MEMORY_UTILIZATION port=$VLLM_PORT" >&2

# Loopback bind: the enclave shim only exposes the supervisor; nothing reaches
# vLLM except the supervisor's in-CVM proxy. Loopback is NOT a trust boundary
# here (all CVM containers share one net namespace, and run-mode tenants get
# -Sinherit-network), so gate the API behind the shared PLATFORM_MODEL_KEY when
# set — defense in depth against a tenant bypassing the supervisor's billing gate.
API_KEY_ARGS=()
if [ -n "${PLATFORM_MODEL_KEY:-}" ]; then
  API_KEY_ARGS=(--api-key "$PLATFORM_MODEL_KEY")
else
  echo "enclave-vllm: WARNING: PLATFORM_MODEL_KEY unset — the OpenAI API on 127.0.0.1:$VLLM_PORT is UNAUTHENTICATED; a shared-namespace tenant could reach it directly and bypass supervisor billing. Set PLATFORM_MODEL_KEY before serving a platform-model tier." >&2
fi

exec vllm serve "$MODEL_DIR" \
  --served-model-name "$SERVED_MODEL_NAME" \
  --tensor-parallel-size "$TENSOR_PARALLEL" \
  --kv-cache-dtype "$KV_CACHE_DTYPE" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --host 127.0.0.1 \
  --port "$VLLM_PORT" \
  "${API_KEY_ARGS[@]}" \
  ${VLLM_EXTRA_ARGS:-}
