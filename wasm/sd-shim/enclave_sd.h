/* enclave_sd - the flat C ABI between wasmtime's sdcpp wasi-nn backend and
 * stable-diffusion.cpp. Same discipline as enclave_llama (see llama-shim/):
 * sd.cpp's param structs (sd_ctx_params_t, sd_img_gen_params_t) are large and
 * their layout shifts between revisions - hand-rolled Rust FFI against them
 * would be layout-roulette on every bump. This shim pins the boundary to
 * pointers and scalars only, compiled against the PINNED sd.cpp checkout and
 * shipped next to libstable-diffusion, so the Rust side binds seven trivial
 * functions that cannot drift.
 *
 * Threading/session model: one esd model handle per preloaded volume, created
 * at server startup (weights land on the device ONCE). generate_image is not
 * documented thread-safe, so the Rust side serializes esd_txt2img calls per
 * handle with a mutex.
 */
#ifndef ENCLAVE_SD_H
#define ENCLAVE_SD_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* once per process, before anything else: routes sd.cpp logs to stderr and
 * remembers the last SD_LOG_ERROR line for esd_last_error(). */
void esd_init(void);

/* how many non-CPU ggml devices sd.cpp sees (0 = CUDA module or driver
 * missing; CPU inference still works). */
int32_t esd_gpu_devices(void);

/* Load a model. Either model_path names a single-file checkpoint
 * (.safetensors/.gguf/.ckpt - text encoders + diffusion + VAE in one file),
 * or it is NULL and the component paths name the pieces (FLUX-style:
 * diffusion_path required, others as the architecture demands). llm_path is
 * the LLM text encoder used by the 2025+ DiT families (Qwen-Image: Qwen2.5-VL;
 * Z-Image: Qwen3-4B; sd.cpp's --llm). Unused paths are NULL.
 *
 * n_threads <= 0 = all physical cores. wtype is a str_to_sd_type() string
 * ("" = keep source precision; "f16" halves an f32 checkpoint on load).
 * use_gpu 0 = pure CPU, nonzero = default device placement (GPU when one
 * exists - callers enforce strictness BEFORE calling, via esd_gpu_devices).
 * flash_attn nonzero enables FA on the diffusion model. vae_tiling nonzero
 * decodes the VAE in tiles (sd.cpp auto tile size, 0.5 overlap): caps the
 * decode buffer at ~O(tile) instead of O(image) - the difference between a
 * ~6 GB and a <1 GB spike at 1024px - at the cost of blend seam risk, so it
 * is a deployment knob, not a default.
 * Returns an opaque handle, or NULL (see esd_last_error). */
void *esd_load_model(const char *model_path,
                     const char *diffusion_path,
                     const char *clip_l_path,
                     const char *clip_g_path,
                     const char *t5xxl_path,
                     const char *llm_path,
                     const char *vae_path,
                     int32_t n_threads,
                     const char *wtype,
                     int32_t use_gpu,
                     int32_t flash_attn,
                     int32_t vae_tiling);
void esd_free_model(void *handle);

/* txt2img: one image, blocking. rgb_out must hold width*height*3 bytes
 * (RGB, row-major). sample_method/scheduler are sd.cpp name strings
 * ("euler_a", "discrete", ...); "" picks the model's default. cfg is the
 * classifier-free-guidance scale (1.0 = off, the turbo/distilled setting).
 * Returns 0 on success, nonzero on failure (see esd_last_error). */
int32_t esd_txt2img(void *handle,
                    const char *prompt,
                    const char *negative_prompt,
                    int32_t width,
                    int32_t height,
                    int32_t steps,
                    float cfg,
                    int64_t seed,
                    const char *sample_method,
                    const char *scheduler,
                    uint8_t *rgb_out);

/* the last SD_LOG_ERROR line seen on this thread's loads/generations
 * (process-global, best effort - for error messages, not control flow). */
const char *esd_last_error(void);

#ifdef __cplusplus
}
#endif
#endif
