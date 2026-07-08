/* enclave_llama.c - see enclave_llama.h for the contract. Built against the
 * PINNED llama.cpp checkout by the enclave-llamacpp toolchain workflow (and by
 * hand for local smokes):
 *
 *   cc -shared -fPIC -Wl,-soname,libenclave_llama.so \
 *      -I<llama.cpp>/include -I<llama.cpp>/ggml/include \
 *      enclave_llama.c -L<llama.cpp>/build/bin -lllama -lggml \
 *      -o libenclave_llama.so
 *
 * The -soname is load-bearing: the wasmtime binary NEEDs "libenclave_llama.so"
 * by that bare name, and in the manager image it is resolved by ldconfig from
 * /usr/local/lib - a soname-less lib is not reliably cached there.
 */
#include "enclave_llama.h"
#include "llama.h"
#include "ggml-backend.h"

#include <stdlib.h>
#include <string.h>

void ell_init(void) {
    /* GGML_BACKEND_DL builds ship the compute backends (cpu, cuda) as
     * dlopened modules so the wasmtime binary carries no DT_NEEDED on
     * libcuda.so.1 (the driver exists only at runtime, injected by the
     * nvidia container runtime - and never on CPU-flavor nodes). Load them
     * from ENCLAVE_GGML_BACKEND_DIR (NULL = executable dir + cwd). A module
     * whose own deps are unresolvable is skipped silently in release builds;
     * ell_gpu_devices() is how callers check that a GPU actually arrived. */
    ggml_backend_load_all_from_path(getenv("ENCLAVE_GGML_BACKEND_DIR"));
    llama_backend_init();
}

int32_t ell_gpu_devices(void) {
    int32_t n = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        if (ggml_backend_dev_type(ggml_backend_dev_get(i)) == GGML_BACKEND_DEVICE_TYPE_GPU) {
            n++;
        }
    }
    return n;
}

void *ell_load_model(const char *path, int32_t n_gpu_layers) {
    struct llama_model_params p = llama_model_default_params();
    p.n_gpu_layers = n_gpu_layers;
    return llama_model_load_from_file(path, p);
}

void ell_free_model(void *model) { llama_model_free((struct llama_model *)model); }

int32_t ell_n_vocab(void *model) {
    return llama_vocab_n_tokens(llama_model_get_vocab((const struct llama_model *)model));
}

void *ell_new_context(void *model, uint32_t n_ctx, uint32_t n_batch) {
    struct llama_context_params p = llama_context_default_params();
    p.n_ctx = n_ctx;
    if (n_batch) { p.n_batch = n_batch; }
    return llama_init_from_model((struct llama_model *)model, p);
}

void ell_free_context(void *ctx) { llama_free((struct llama_context *)ctx); }

void ell_reset(void *ctx) {
    llama_memory_clear(llama_get_memory((struct llama_context *)ctx), true);
}

int32_t ell_decode(void *ctx, void *model, const int32_t *tokens, int32_t n, float *logits_out) {
    struct llama_context *lctx = (struct llama_context *)ctx;
    if (n <= 0 || (uint32_t)n > llama_n_batch(lctx)) {
        return -1;
    }
    /* llama_batch_get_one wants a mutable pointer but does not write; the
     * cast is safe against the pinned revision (verified at pin time). */
    struct llama_batch batch = llama_batch_get_one((llama_token *)tokens, n);
    int32_t rc = llama_decode(lctx, batch);
    if (rc != 0) {
        return rc;
    }
    const float *logits = llama_get_logits_ith(lctx, -1);
    if (!logits) {
        return -2;
    }
    memcpy(logits_out, logits, (size_t)ell_n_vocab(model) * sizeof(float));
    return 0;
}
