#!/usr/bin/env bash
# Fetches the llm-chat model artifacts into assets/ (gitignored - a 460MB
# model does not belong in git). Pinned to an exact HuggingFace revision and
# sha256 so the build is reproducible. Run once before
# `cargo component build --release --target wasm32-wasip2`.
#
# Model: Qwen2.5-0.5B-Instruct, ONNX export with KV cache, q4f16 quantization
# (4-bit MatMulNBits weights + fp16 internals). The graph BOUNDARY is fp32 +
# i64 only - the fp16 stays inside the model - so the guest exchanges plain
# fp32/i64 tensors with wasi-nn. MatMulNBits has first-class CUDA kernels, so
# ExecutionTarget::Gpu runs the whole decoder on the card.
#
# NOTE the artifact this produces (~493MB) exceeds wasmtime's default 128MiB
# hostcall-fuel budget; the platform launches nn tenants with
# -S hostcall-fuel=4GiB (wasm_manager.py). Local runs need the same flag.
set -euo pipefail
mkdir -p "$(dirname "$0")/assets"
cd "$(dirname "$0")/assets"

REPO=onnx-community/Qwen2.5-0.5B-Instruct
REV=cc5cc01a65cc3ff17bdb73a7de33d879f62599b0

fetch() { # <repo-path> <sha256>
    local out="${1##*/}"
    if [ -f "$out" ] && echo "$2  $out" | sha256sum -c --quiet - 2>/dev/null; then
        echo "$out: cached, checksum ok"
        return
    fi
    echo "fetching $1 ..."
    curl -fsSL -o "$out" "https://huggingface.co/$REPO/resolve/$REV/$1"
    echo "$2  $out" | sha256sum -c -
}

fetch onnx/model_q4f16.onnx b11c1dd99efd57e6c6e5bc4443a019931a5fbd5dd500d48644d8225f5ce0b2cb
fetch tokenizer.json a8506e7111b80c6d8635951a02eab0f4e1a8e4e5772da83846579e97b16f61bf
