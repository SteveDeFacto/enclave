# sd-shim — stable-diffusion.cpp behind wasi-nn

The image-generation sibling of `llama-shim/`: a flat C ABI (`enclave_sd.h`)
over [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp),
bound by the `sdcpp` wasi-nn backend (`wasmtime-nn-sdcpp.patch`, applies on
top of `wasmtime-nn-ggml.patch`). Host-preloaded checkpoints, weights never
in guest memory — the big-model image path (SD-Turbo full checkpoints, SDXL,
FLUX gguf quants).

**Pinned revision**: `leejet/stable-diffusion.cpp@b5d812008eb7082a238fc589444544b3278187ae`
(header layout is shim-internal; the Rust FFI binds only enclave_sd's seven
pointer/scalar functions, so an sd.cpp bump recompiles the shim, not the
patch).

## Build

**Production** rides `llamacpp-toolchain.yml`, which builds the whole ggml
stack into ONE tarball: llama.cpp's ggml (CUDA sm_86+sm_90,
`GGML_BACKEND_DL`, `GGML_MAX_NAME=128` tree-wide), sd.cpp compiled with
`SD_USE_SYSTEM_GGML` against that same ggml, and both shims. One ggml per
process is load-bearing - two vendored copies alias the same SONAMEs and
the dynamic linker binds both engines to whichever loaded first.
`GGML_MAX_NAME=128` is ABI (it sizes a field inside `struct ggml_tensor`,
so every ggml consumer in the process must agree) and REQUIRED by sd.cpp:
SD UNet tensor names overflow ggml's default 64 and truncated names
collide. sd.cpp needs no CUDA compile of its own - GPU work flows through
the dlopened `ggml-cuda` module, which `esd_init()` loads from
`ENCLAVE_GGML_BACKEND_DIR` (guarded: whichever shim initializes first in
the process wins). Ship flow: run the workflow → paste the printed
ELL_URL/ELL_SHA256 into Dockerfile.wasmtime → dispatch the Wasmtime
Toolchain → repin WASMTIME_IMAGE in Dockerfile.wasm.

**Local smoke** (vendored ggml, CPU; backends register statically so the
esd_init guard skips module loading):

```bash
git clone --recursive https://github.com/leejet/stable-diffusion.cpp && cd stable-diffusion.cpp
git checkout b5d812008eb7082a238fc589444544b3278187ae
cmake -B build -DCMAKE_BUILD_TYPE=Release -DSD_BUILD_SHARED_LIBS=ON
cmake --build build -j

cc -shared -fPIC -Wl,-soname,libenclave_sd.so \
   -I<sd.cpp>/include -I<sd.cpp>/ggml/include enclave_sd.c \
   -L<sd.cpp>/build/bin -lstable-diffusion \
   -o libenclave_sd.so

# wasmtime build (after applying wasmtime-nn-sdcpp.patch):
ESD_LIB_LOCATION=<dir with both .so> cargo build --release -p wasmtime-cli \
  --features wasmtime-wasi-nn/onnx-download,wasmtime-wasi-nn/sdcpp
```

## Wiring (host side)

- `wasm_manager.py`: volumes named in the `MODEL_VOLUMES_SD` env preload via
  `-S nn-graph=sd::<staged dir>` instead of ggml (`_sd_checkpoint_path`;
  MODEL_VOLUMES' third field still picks the file). Set it in the enclave's
  tinfoil-config next to MODEL_VOLUMES.
- Tuning env (per node / per tenant): `ENCLAVE_SD_USE_GPU` (default 1,
  strict — no silent CPU fallback), `ENCLAVE_SD_WTYPE` (e.g. `f16` to halve
  an f32 checkpoint on load), `ENCLAVE_SD_N_THREADS`, `ENCLAVE_SD_FLASH_ATTN`,
  `ENCLAVE_SD_VAE_TILING` (1 = tiled VAE decode: the ~6 GB decode spike at
  1024px becomes <1 GB, at tile-seam risk — the big-resolution knob), and
  `ENCLAVE_SD_{MODEL,DIFFUSION,CLIP_L,CLIP_G,T5XXL,LLM,VAE}_FILE` for
  volumes where the single-checkpoint convention is ambiguous (FLUX-style
  split components; `LLM` is the Qwen-class text encoder the 2025+ DiT
  families use — Qwen-Image, Z-Image — validated with Z-Image-Turbo).

## Guest contract (wasi-nn, WIT named tensors)

`load_by_name("<volume>")` → `init_execution_context` → one `compute()` per
image:

| tensor | type | meaning |
|---|---|---|
| `prompt` (req.) | U8 utf-8 | prompt |
| `negative_prompt` | U8 utf-8 | optional |
| `steps` | I32 [1] | default 20 |
| `seed` | I64 [1] | default 42 |
| `width`, `height` | I32 [1] | default 512, 64-multiples |
| `cfg` | Fp32 [1] | default 7.0 (1.0 = off, turbo models) |
| `sample_method`, `scheduler` | U8 utf-8 | sd.cpp names; default: model defaults |
| → `image` | U8 [1,h,w,3] | RGB row-major |

Generation blocks inside `compute()`; one generation at a time per model
(mutex — requests queue). Guest fuel cost per image: prompt in, ~h·w·3 bytes
out.
