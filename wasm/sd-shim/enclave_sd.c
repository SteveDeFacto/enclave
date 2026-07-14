/* enclave_sd.c - see enclave_sd.h for the contract. Production builds ride
 * llamacpp-toolchain.yml: sd.cpp compiled with SD_USE_SYSTEM_GGML against
 * the SAME ggml as llama.cpp (one ggml per process - two vendored copies
 * alias the same SONAMEs and the dynamic linker binds both engines to
 * whichever loaded first) and GGML_MAX_NAME=128 tree-wide (it sizes a field
 * inside struct ggml_tensor; SD tensor names overflow the default 64). By
 * hand for local smokes:
 *
 *   cc -shared -fPIC -Wl,-soname,libenclave_sd.so -DGGML_MAX_NAME=128 \
 *      -I<sd.cpp>/include -I<ggml prefix>/include enclave_sd.c \
 *      -L<sd.cpp>/build/bin -L<ggml libs> -lstable-diffusion -lggml -lggml-base \
 *      -o libenclave_sd.so
 *
 * (a vendored-ggml sd.cpp build re-exports ggml symbols, so the ggml -I/-l
 * pieces are optional there). The -soname is load-bearing: the wasmtime
 * binary NEEDs "libenclave_sd.so" by that bare name, resolved by ldconfig
 * from /usr/local/lib in the manager image (same as libenclave_llama).
 */
#include "enclave_sd.h"
#include "stable-diffusion.h"
#include "ggml-backend.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* last error line, process-global. sd.cpp logs from the generating thread;
 * we only read it right after a failed call on that same thread, so a plain
 * static buffer is fine for its best-effort purpose. */
static char g_last_error[1024];

static void esd_log_cb(enum sd_log_level_t level, const char *text, void *data) {
    (void)data;
    if (level == SD_LOG_ERROR && text) {
        snprintf(g_last_error, sizeof(g_last_error), "%s", text);
        /* strip the trailing newline sd.cpp logs carry */
        size_t n = strlen(g_last_error);
        if (n && g_last_error[n - 1] == '\n') {
            g_last_error[n - 1] = 0;
        }
    }
    if (level >= SD_LOG_WARN) {
        fprintf(stderr, "sd.cpp: %s", text ? text : "");
    }
}

void esd_init(void) {
    sd_set_log_callback(esd_log_cb, NULL);
    /* GGML_BACKEND_DL stacks (production: sd.cpp built with
     * SD_USE_SYSTEM_GGML against the same ggml as llama.cpp) ship the
     * compute backends as dlopened modules - load them so sd_list_devices/
     * new_sd_ctx see any GPU. Guarded like ell_init: whichever shim
     * initializes first in this process loads the modules; a vendored-ggml
     * local build registers its backends statically and dev_count is
     * already nonzero. */
    if (ggml_backend_dev_count() == 0) {
        ggml_backend_load_all_from_path(getenv("ENCLAVE_GGML_BACKEND_DIR"));
    }
}

int32_t esd_gpu_devices(void) {
    /* sd_list_devices emits one "name<TAB>description" line per ggml device;
     * anything whose name is not CPU-ish counts as an accelerator. */
    size_t need = sd_list_devices(NULL, 0);
    if (need == 0 || need > 65536) {
        return 0;
    }
    char *buf = malloc(need + 1);
    if (!buf) {
        return 0;
    }
    sd_list_devices(buf, need + 1);
    int32_t n = 0;
    for (char *line = strtok(buf, "\n"); line; line = strtok(NULL, "\n")) {
        if (strncmp(line, "CPU", 3) != 0) {
            n++;
        }
    }
    free(buf);
    return n;
}

/* The opaque handle: sd.cpp's context plus the per-model knobs that apply
 * at GENERATION time (sd_img_gen_params_t fields, fixed per deployment). */
typedef struct {
    sd_ctx_t *ctx;
    int32_t   vae_tiling;
} esd_model_t;

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
                     int32_t vae_tiling) {
    sd_ctx_params_t p;
    sd_ctx_params_init(&p);
    p.model_path           = model_path;
    p.diffusion_model_path = diffusion_path;
    p.clip_l_path          = clip_l_path;
    p.clip_g_path          = clip_g_path;
    p.t5xxl_path           = t5xxl_path;
    p.llm_path             = llm_path;
    p.vae_path             = vae_path;
    p.n_threads            = n_threads > 0 ? n_threads : sd_get_num_physical_cores();
    if (wtype && wtype[0]) {
        p.wtype = str_to_sd_type(wtype);
        if (p.wtype >= SD_TYPE_COUNT) {
            snprintf(g_last_error, sizeof(g_last_error), "unknown wtype '%s'", wtype);
            return NULL;
        }
    }
    if (!use_gpu) {
        p.backend = "CPU"; /* device assignment spec: everything on the CPU */
    }
    p.flash_attn           = flash_attn != 0;
    p.diffusion_flash_attn = flash_attn != 0;
    sd_ctx_t *ctx = new_sd_ctx(&p);
    if (!ctx) {
        return NULL;
    }
    esd_model_t *m = malloc(sizeof(*m));
    if (!m) {
        free_sd_ctx(ctx);
        snprintf(g_last_error, sizeof(g_last_error), "out of memory");
        return NULL;
    }
    m->ctx        = ctx;
    m->vae_tiling = vae_tiling;
    return m;
}

void esd_free_model(void *handle) {
    if (!handle) {
        return;
    }
    esd_model_t *m = (esd_model_t *)handle;
    free_sd_ctx(m->ctx);
    free(m);
}

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
                    uint8_t *rgb_out) {
    esd_model_t *m = (esd_model_t *)handle;
    sd_ctx_t *ctx = m->ctx;
    sd_img_gen_params_t p;
    sd_img_gen_params_init(&p);
    if (m->vae_tiling) {
        /* auto tile size (0 = sd.cpp picks), 0.5 overlap - mirrors the
         * engine's own defaults for --vae-tiling */
        p.vae_tiling_params.enabled        = true;
        p.vae_tiling_params.target_overlap = 0.5f;
    }
    p.prompt          = prompt;
    p.negative_prompt = negative_prompt ? negative_prompt : "";
    p.width           = width;
    p.height          = height;
    p.seed            = seed;
    p.batch_count     = 1;
    p.sample_params.sample_steps     = steps;
    p.sample_params.guidance.txt_cfg = cfg;
    if (sample_method && sample_method[0]) {
        p.sample_params.sample_method = str_to_sample_method(sample_method);
        if (p.sample_params.sample_method >= SAMPLE_METHOD_COUNT) {
            snprintf(g_last_error, sizeof(g_last_error), "unknown sample_method '%s'", sample_method);
            return -1;
        }
    } else {
        p.sample_params.sample_method = sd_get_default_sample_method(ctx);
    }
    if (scheduler && scheduler[0]) {
        p.sample_params.scheduler = str_to_scheduler(scheduler);
        if (p.sample_params.scheduler >= SCHEDULER_COUNT) {
            snprintf(g_last_error, sizeof(g_last_error), "unknown scheduler '%s'", scheduler);
            return -1;
        }
    } else {
        p.sample_params.scheduler = sd_get_default_scheduler(ctx, p.sample_params.sample_method);
    }

    sd_image_t *images = NULL;
    int n_images = 0;
    if (!generate_image(ctx, &p, &images, &n_images)) {
        return -2;
    }
    if (n_images < 1 || !images || !images[0].data) {
        if (images) {
            free_sd_images(images, n_images);
        }
        snprintf(g_last_error, sizeof(g_last_error), "generation returned no image");
        return -3;
    }
    if (images[0].width != (uint32_t)width || images[0].height != (uint32_t)height ||
        images[0].channel != 3) {
        snprintf(g_last_error, sizeof(g_last_error),
                 "unexpected output geometry %ux%ux%u (wanted %dx%dx3)",
                 images[0].width, images[0].height, images[0].channel, width, height);
        free_sd_images(images, n_images);
        return -4;
    }
    memcpy(rgb_out, images[0].data, (size_t)width * height * 3);
    free_sd_images(images, n_images);
    return 0;
}

const char *esd_last_error(void) { return g_last_error; }
