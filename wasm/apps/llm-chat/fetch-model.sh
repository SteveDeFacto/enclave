#!/usr/bin/env bash
# Fetches the llm-chat model artifacts into assets/ (gitignored - a 117MB
# model does not belong in git). Pinned to an exact HuggingFace revision and
# sha256 so the build is reproducible. Run once before
# `cargo component build --release --target wasm32-wasip2`.
#
# Model: SmolLM2-135M-Instruct, ONNX export with KV cache, q4f16 quantization
# (4-bit MatMulNBits weights + fp16 internals). The graph BOUNDARY is fp32 +
# i64 only - the fp16 stays inside the model - so the guest exchanges plain
# fp32/i64 tensors with wasi-nn. MatMulNBits has first-class CUDA kernels, so
# ExecutionTarget::Gpu runs the whole decoder on the card.
set -euo pipefail
mkdir -p "$(dirname "$0")/assets"
cd "$(dirname "$0")/assets"

REPO=onnx-community/SmolLM2-135M-Instruct-ONNX
REV=b8a5c0f183b78c55955a5364f610c36668b5e681

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

fetch onnx/model_q4f16.onnx 662d0a9d8d5d56e3746a5bf3b3ede96bd2d4d3594d9b2e282baebd4f34cf3589
fetch tokenizer.json 7d27c493c729a66ecefc837280b05d948b1ed50d130eebdbf911b1b36cf38ed7
