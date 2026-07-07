/* enclave_llama - the flat C ABI between wasmtime's ggml wasi-nn backend and
 * llama.cpp. llama.h passes structs BY VALUE (llama_model_params, llama_batch),
 * whose layout shifts between llama.cpp releases - hand-rolled Rust FFI against
 * that would be layout-roulette on every bump. This shim pins the boundary to
 * pointers and scalars only (opaque handles, int32/uint32/float*), compiled and
 * shipped INSIDE the prebuilt enclave-llamacpp tarball next to libllama, so the
 * Rust side binds eight trivial functions that cannot drift.
 *
 * Threading/session model: one ell_context per wasi-nn execution context. The
 * KV cache lives inside it - callers feed token ids (chunked to <= n_batch)
 * and read back logits for the last fed token. ell_reset() starts a fresh
 * sequence without reallocating.
 */
#ifndef ENCLAVE_LLAMA_H
#define ENCLAVE_LLAMA_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* once per process, before anything else */
void ell_init(void);

/* n_gpu_layers: 0 = pure CPU, -1 = offload every layer. NULL on failure. */
void *ell_load_model(const char *path, int32_t n_gpu_layers);
void ell_free_model(void *model);
int32_t ell_n_vocab(void *model);

/* n_ctx 0 = the model's training context; n_batch = max tokens per ell_decode
 * call. NULL on failure. */
void *ell_new_context(void *model, uint32_t n_ctx, uint32_t n_batch);
void ell_free_context(void *ctx);

/* wipe the KV cache: next ell_decode starts a fresh sequence */
void ell_reset(void *ctx);

/* Feed n tokens (n <= n_batch); on success writes n_vocab floats - the logits
 * of the LAST fed token - to logits_out and returns 0. Nonzero = decode error
 * (context overflow, backend failure). */
int32_t ell_decode(void *ctx, void *model, const int32_t *tokens, int32_t n, float *logits_out);

#ifdef __cplusplus
}
#endif
#endif
