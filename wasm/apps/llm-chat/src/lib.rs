//! llm-chat: a general-purpose LLM service compiled into a wasm component,
//! running on NaN's wasi-nn GPU interface. Ships with an embedded model
//! (see assets/app-config.json for which); geometry, chat template, sampling
//! defaults and the API key are configuration, not code - a deployment can
//! override any of it via NAN_CONFIG (the platform passes the deployment's
//! CID-verified configCid JSON through the tenant environment).
//!
//! Routes:
//!   GET  /                    - chat playground (self-contained HTML).
//!   GET  /ping                - liveness, touches no wasi-nn.
//!   GET  /v1/models           - OpenAI-compatible model list.
//!   POST /v1/chat/completions - OpenAI-compatible completions, stream and
//!                               non-stream. Point any OpenAI SDK at the
//!                               deployment URL. If the config sets api_key,
//!                               requires `Authorization: Bearer <key>`.
//!   POST /chat                - legacy SSE endpoint used by the playground.
//!
//! Generation: autoregressive decode with the model's KV cache. The trick
//! that makes this cheap through wasi-nn: `compute()` returns OWNED tensor
//! resources for the `present.*` KV tensors, and we hand those handles
//! straight back as the next step's `past_key_values.*` inputs - the cache
//! bytes never cross into guest memory. Only the logits are read out
//! (one vocab row per decode step).
#[allow(warnings)]
mod bindings;

mod config;
mod sampling;

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokenizers::Tokenizer;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use bindings::wasi::io::streams::StreamError;
use bindings::wasi::nn::graph::{load, ExecutionTarget, GraphEncoding};
use bindings::wasi::nn::inference::GraphExecutionContext;
use bindings::wasi::nn::tensor::{Tensor, TensorType};

use config::AppConfig;
use sampling::{pick_token, Rng, SampleParams};

static MODEL: &[u8] = include_bytes!("../assets/model_q4.onnx");
static TOKENIZER_JSON: &[u8] = include_bytes!("../assets/tokenizer.json");
static CHAT_HTML: &str = include_str!("chat.html");

const PREFILL_CHUNK: usize = 128;
const MAX_BODY_BYTES: usize = 256 * 1024;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- tensors --

fn i64_tensor(dims: &[u32], vals: &[i64]) -> Tensor {
    let bytes: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
    Tensor::new(dims, TensorType::I64, &bytes)
}

fn empty_past(cfg: &AppConfig) -> Vec<(String, Tensor)> {
    let mut past = Vec::with_capacity((cfg.n_layers * 2) as usize);
    for l in 0..cfg.n_layers {
        for kind in ["key", "value"] {
            past.push((
                format!("past_key_values.{l}.{kind}"),
                Tensor::new(&[1, cfg.n_kv_heads, 0, cfg.head_dim], TensorType::Fp32, &[]),
            ));
        }
    }
    past
}

fn nn_err(stage: &str, e: bindings::wasi::nn::errors::Error) -> String {
    format!("{stage}: {:?}: {}", e.code(), e.data())
}

// ------------------------------------------------------------- generation --

struct StepResult {
    logits: Vec<f32>,
    past: Vec<(String, Tensor)>,
}

/// One forward pass. `past` is consumed (the host drops the old cache).
fn step(
    cfg: &AppConfig,
    ctx: &GraphExecutionContext,
    ids: &[i64],
    past: Vec<(String, Tensor)>,
    past_len: usize,
    read_logits: bool,
) -> Result<StepResult, String> {
    let new_len = ids.len();
    let total = past_len + new_len;
    let mut inputs: Vec<(String, Tensor)> = Vec::with_capacity(3 + past.len());
    inputs.push(("input_ids".into(), i64_tensor(&[1, new_len as u32], ids)));
    inputs.push((
        "attention_mask".into(),
        i64_tensor(&[1, total as u32], &vec![1i64; total]),
    ));
    let positions: Vec<i64> = (past_len as i64..total as i64).collect();
    inputs.push((
        "position_ids".into(),
        i64_tensor(&[1, new_len as u32], &positions),
    ));
    inputs.extend(past);

    let outputs = ctx.compute(inputs).map_err(|e| nn_err("compute", e))?;

    let mut logits = Vec::new();
    let mut next_past = Vec::with_capacity((cfg.n_layers * 2) as usize);
    for (name, tensor) in outputs {
        if name == "logits" {
            if read_logits {
                let data = tensor.data();
                let row = cfg.vocab * 4;
                if data.len() < row {
                    return Err(format!("logits too short: {} bytes", data.len()));
                }
                let tail = &data[data.len() - row..];
                logits = tail
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
            }
        } else if let Some(rest) = name.strip_prefix("present.") {
            next_past.push((format!("past_key_values.{rest}"), tensor));
        }
    }
    if next_past.len() != (cfg.n_layers * 2) as usize {
        return Err(format!(
            "expected {} KV outputs, got {} - do the config's n_layers/n_kv_heads match the model?",
            cfg.n_layers * 2,
            next_past.len()
        ));
    }
    if read_logits && logits.len() != cfg.vocab {
        return Err("model returned no logits (config vocab mismatch?)".into());
    }
    Ok(StepResult { logits, past: next_past })
}

struct GenParams {
    max_new: usize,
    sample: SampleParams,
    stop_strings: Vec<String>,
}

struct GenStats {
    target: String,
    prompt_tokens: usize,
    tokens: usize,
    load_ms: u128,
    prefill_ms: u128,
    decode_ms: u128,
    finish_reason: &'static str,
    text: String,
}

/// Run the full completion; `emit` receives text deltas as they stabilize
/// (with a holdback of the longest stop string so a stop sequence is never
/// partially emitted), `status` receives progress lines. Both return false
/// when the client is gone. Status events double as keepalive bytes during
/// the one long silence (cold session init; the host caches sessions).
fn generate(
    cfg: &AppConfig,
    tok: &Tokenizer,
    prompt_ids: &[u32],
    target: ExecutionTarget,
    tname: &str,
    p: &GenParams,
    emit: &dyn Fn(&str) -> bool,
    status: &dyn Fn(&str) -> bool,
) -> Result<GenStats, String> {
    if !status(&format!(
        "loading the model on {tname} - the first request after a node boot initializes the session and can take a while"
    )) {
        return Err("client disconnected".into());
    }
    let t0 = now_ms();
    let graph = load(&[MODEL.to_vec()], GraphEncoding::Onnx, target)
        .map_err(|e| nn_err("load", e))?;
    let ctx = graph
        .init_execution_context()
        .map_err(|e| nn_err("init", e))?;
    let load_ms = now_ms() - t0;
    if !status(&format!(
        "session ready ({load_ms} ms); prefilling {} prompt tokens",
        prompt_ids.len()
    )) {
        return Err("client disconnected".into());
    }

    // -- prefill, in chunks so no single logits tensor gets huge
    let t1 = now_ms();
    let ids: Vec<i64> = prompt_ids.iter().map(|&t| t as i64).collect();
    let mut past = empty_past(cfg);
    let mut done = 0usize;
    let mut logits = Vec::new();
    while done < ids.len() {
        let end = (done + PREFILL_CHUNK).min(ids.len());
        let last = end == ids.len();
        let r = step(cfg, &ctx, &ids[done..end], past, done, last)?;
        past = r.past;
        if last {
            logits = r.logits;
        }
        done = end;
    }
    let prefill_ms = now_ms() - t1;

    // -- decode
    let t2 = now_ms();
    let holdback = p.stop_strings.iter().map(|s| s.len()).max().unwrap_or(0);
    let mut rng = Rng::new(now_ms() as u64 ^ (prompt_ids.len() as u64) << 17);
    let mut generated: Vec<u32> = Vec::new();
    let mut emitted = 0usize; // chars of decoded text already sent
    let mut total_len = ids.len();
    let mut finish: &'static str = "stop";
    let mut final_text = String::new();
    loop {
        let recent: Vec<u32> = if generated.is_empty() {
            prompt_ids[prompt_ids.len().saturating_sub(p.sample.rep_window)..].to_vec()
        } else {
            generated[generated.len().saturating_sub(p.sample.rep_window)..].to_vec()
        };
        let next = pick_token(&mut logits, &recent, &p.sample, &mut rng);
        if cfg.eos.contains(&next) {
            break;
        }
        if generated.len() >= p.max_new {
            finish = "length";
            break;
        }
        generated.push(next);

        // incremental detokenization: decode everything, emit the stable
        // suffix minus the stop-string holdback; hold while the tail is an
        // incomplete UTF-8 sequence
        if let Ok(text) = tok.decode(&generated, true) {
            // stop-string scan on the full decoded text
            if let Some(pos) = p
                .stop_strings
                .iter()
                .filter_map(|s| text.find(s.as_str()))
                .min()
            {
                final_text = text[..pos].to_string();
                if pos > emitted {
                    if !emit(&text[emitted..pos]) {
                        return Err("client disconnected".into());
                    }
                }
                let decode_ms = now_ms() - t2;
                return Ok(GenStats {
                    target: tname.to_string(),
                    prompt_tokens: prompt_ids.len(),
                    tokens: generated.len(),
                    load_ms,
                    prefill_ms,
                    decode_ms,
                    finish_reason: "stop",
                    text: final_text,
                });
            }
            let visible = text.len().saturating_sub(holdback);
            if !text.ends_with('\u{FFFD}') && visible > emitted {
                if let Some(delta) = text.get(emitted..visible) {
                    if !emit(delta) {
                        break; // client disconnected
                    }
                    emitted = visible;
                }
            }
            final_text = text;
        }

        let r = step(cfg, &ctx, &[next as i64], past, total_len, true)?;
        past = r.past;
        logits = r.logits;
        total_len += 1;
    }
    // flush whatever the holdback was withholding
    if final_text.len() > emitted {
        if let Some(delta) = final_text.get(emitted..) {
            let _ = emit(delta);
        }
    }
    let decode_ms = now_ms() - t2;

    Ok(GenStats {
        target: tname.to_string(),
        prompt_tokens: prompt_ids.len(),
        tokens: generated.len(),
        load_ms,
        prefill_ms,
        decode_ms,
        finish_reason: finish,
        text: final_text,
    })
}

// -------------------------------------------------------------------- http --

#[derive(Deserialize)]
struct ChatMsg {
    role: String,
    content: String,
}

/// Request shape shared by /chat (legacy) and /v1/chat/completions (OpenAI).
/// OpenAI fields we don't implement are accepted and ignored.
#[derive(Deserialize)]
struct ChatReq {
    messages: Vec<ChatMsg>,
    #[serde(default)]
    target: Option<String>, // NaN extension: cpu | gpu | auto
    #[serde(default)]
    max_tokens: Option<usize>,
    #[serde(default)]
    max_completion_tokens: Option<usize>, // newer OpenAI name
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    top_p: Option<f32>,
    #[serde(default)]
    top_k: Option<usize>, // extension (common in OSS servers)
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    stop: Option<serde_json::Value>, // string or [string]
}

fn read_body(req: &IncomingRequest) -> Result<Vec<u8>, String> {
    let body = req.consume().map_err(|_| "request has no body")?;
    let stream = body.stream().map_err(|_| "cannot read request body")?;
    let mut out = Vec::new();
    loop {
        match stream.blocking_read(64 * 1024) {
            Ok(chunk) => {
                out.extend_from_slice(&chunk);
                if out.len() > MAX_BODY_BYTES {
                    return Err("request body too large".into());
                }
            }
            Err(StreamError::Closed) => break,
            Err(e) => return Err(format!("body read error: {e:?}")),
        }
    }
    Ok(out)
}

/// Render + tokenize the conversation; drops oldest turns until it fits.
/// A `system` message in the request overrides the configured default.
fn build_prompt(
    cfg: &AppConfig,
    tok: &Tokenizer,
    messages: &[ChatMsg],
) -> Result<(Vec<u32>, Vec<String>), String> {
    let system = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone())
        .unwrap_or_else(|| cfg.system_prompt.clone());
    let mut msgs: Vec<(String, String)> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| (m.role.clone(), m.content.clone()))
        .collect();
    if msgs.is_empty() {
        return Err("no user/assistant messages".into());
    }
    loop {
        let rendered = config::render_template(&cfg.template, &system, &msgs)?;
        let enc = tok
            .encode(rendered.prompt.as_str(), true)
            .map_err(|e| format!("tokenize: {e}"))?;
        let ids = enc.get_ids().to_vec();
        if ids.len() <= cfg.max_prompt_tokens || msgs.len() <= 1 {
            if ids.len() > cfg.max_prompt_tokens {
                return Err(format!(
                    "message too long: {} tokens (limit {})",
                    ids.len(),
                    cfg.max_prompt_tokens
                ));
            }
            return Ok((ids, rendered.stop_strings));
        }
        msgs.remove(0); // drop the oldest turn and retry
    }
}

fn gen_params(cfg: &AppConfig, creq: &ChatReq, extra_stops: Vec<String>) -> GenParams {
    let mut stops = extra_stops;
    match &creq.stop {
        Some(serde_json::Value::String(s)) if !s.is_empty() => stops.push(s.clone()),
        Some(serde_json::Value::Array(a)) => {
            for v in a.iter().take(4) {
                if let Some(s) = v.as_str() {
                    stops.push(s.to_string());
                }
            }
        }
        _ => {}
    }
    GenParams {
        max_new: creq
            .max_tokens
            .or(creq.max_completion_tokens)
            .unwrap_or(cfg.default_max_new)
            .min(cfg.max_new_cap)
            .max(1),
        sample: SampleParams {
            temperature: creq.temperature.unwrap_or(0.7).clamp(0.0, 2.0),
            top_p: creq.top_p.unwrap_or(0.9).clamp(0.05, 1.0),
            top_k: creq.top_k.unwrap_or(0),
            rep_penalty: cfg.rep_penalty,
            rep_window: cfg.rep_window,
        },
        stop_strings: stops,
    }
}

fn targets_for(mode: &str) -> Vec<(ExecutionTarget, &'static str)> {
    match mode {
        "cpu" => vec![(ExecutionTarget::Cpu, "cpu")],
        "gpu" => vec![(ExecutionTarget::Gpu, "gpu")],
        _ => vec![(ExecutionTarget::Gpu, "gpu"), (ExecutionTarget::Cpu, "cpu")],
    }
}

fn respond_bytes(out: ResponseOutparam, status: u16, ctype: &str, body_bytes: &[u8]) {
    let headers = Fields::new();
    let _ = headers.set(&"content-type".to_string(), &[ctype.as_bytes().to_vec()]);
    let resp = OutgoingResponse::new(headers);
    let _ = resp.set_status_code(status);
    let body = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    let stream = body.write().unwrap();
    // the platform caps a single body write at 4096 bytes
    for chunk in body_bytes.chunks(4000) {
        if stream.blocking_write_and_flush(chunk).is_err() {
            break;
        }
    }
    drop(stream);
    let _ = OutgoingBody::finish(body, None);
}

fn json_err(out: ResponseOutparam, status: u16, msg: &str) {
    respond_bytes(
        out,
        status,
        "application/json",
        serde_json::json!({ "error": { "message": msg, "type": "invalid_request_error" } })
            .to_string()
            .as_bytes(),
    );
}

/// Bearer-token check for /v1/*. No key configured = open (gate with a
/// private deployment instead when that is the intent).
fn authorized(cfg: &AppConfig, req: &IncomingRequest) -> bool {
    let Some(key) = &cfg.api_key else { return true };
    let headers = req.headers();
    for v in headers.get(&"authorization".to_string()) {
        if let Ok(s) = String::from_utf8(v) {
            if let Some(tok) = s.strip_prefix("Bearer ") {
                if tok.trim() == key {
                    return true;
                }
            }
        }
    }
    false
}

// ------------------------------------------------- legacy /chat (playground) --

fn handle_chat(cfg: &AppConfig, req: IncomingRequest, out: ResponseOutparam) {
    let parsed: Result<ChatReq, String> = read_body(&req)
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| format!("bad JSON: {e}")));
    let creq = match parsed {
        Ok(c) => c,
        Err(e) => return json_err(out, 400, &e),
    };
    let tok = match Tokenizer::from_bytes(TOKENIZER_JSON) {
        Ok(t) => t,
        Err(e) => return json_err(out, 500, &format!("tokenizer: {e}")),
    };
    let (prompt_ids, stops) = match build_prompt(cfg, &tok, &creq.messages) {
        Ok(v) => v,
        Err(e) => return json_err(out, 400, &e),
    };
    let params = gen_params(cfg, &creq, stops);

    let headers = Fields::new();
    let _ = headers.set(&"content-type".to_string(), &[b"text/event-stream".to_vec()]);
    let _ = headers.set(&"cache-control".to_string(), &[b"no-cache".to_vec()]);
    let resp = OutgoingResponse::new(headers);
    let body = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    let stream = body.write().unwrap();
    let send = |v: serde_json::Value| -> bool {
        let msg = format!("data: {v}\n\n");
        for chunk in msg.as_bytes().chunks(4000) {
            if stream.blocking_write_and_flush(chunk).is_err() {
                return false;
            }
        }
        true
    };

    let mode = creq.target.as_deref().unwrap_or("auto");
    let mut last_err = String::new();
    let mut ok = false;
    for (i, (target, tname)) in targets_for(mode).iter().enumerate() {
        if i > 0 && !send(serde_json::json!({ "notice": format!("gpu failed ({last_err}); retrying on cpu") })) {
            break;
        }
        let emit = |delta: &str| send(serde_json::json!({ "delta": delta }));
        let status = |s: &str| send(serde_json::json!({ "status": s }));
        match generate(cfg, &tok, &prompt_ids, *target, tname, &params, &emit, &status) {
            Ok(s) => {
                let gen_s = (s.decode_ms as f64) / 1000.0;
                let tok_per_s = if gen_s > 0.0 { s.tokens as f64 / gen_s } else { 0.0 };
                send(serde_json::json!({
                    "done": true, "target": s.target,
                    "prompt_tokens": s.prompt_tokens, "tokens": s.tokens,
                    "load_ms": s.load_ms as u64, "prefill_ms": s.prefill_ms as u64,
                    "decode_ms": s.decode_ms as u64,
                    "finish_reason": s.finish_reason,
                    "tok_per_s": (tok_per_s * 10.0).round() / 10.0,
                }));
                ok = true;
                break;
            }
            Err(e) => last_err = format!("{tname}: {e}"),
        }
    }
    if !ok && !last_err.is_empty() {
        send(serde_json::json!({ "error": last_err }));
    }
    drop(stream);
    let _ = OutgoingBody::finish(body, None);
}

// --------------------------------------- OpenAI-compatible /v1 endpoints --

fn completion_id() -> String {
    format!("chatcmpl-nan{:x}", now_ms())
}

fn handle_completions(cfg: &AppConfig, req: IncomingRequest, out: ResponseOutparam) {
    if !authorized(cfg, &req) {
        return json_err(out, 401, "missing or invalid API key");
    }
    let parsed: Result<ChatReq, String> = read_body(&req)
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| format!("bad JSON: {e}")));
    let creq = match parsed {
        Ok(c) => c,
        Err(e) => return json_err(out, 400, &e),
    };
    let tok = match Tokenizer::from_bytes(TOKENIZER_JSON) {
        Ok(t) => t,
        Err(e) => return json_err(out, 500, &format!("tokenizer: {e}")),
    };
    let (prompt_ids, stops) = match build_prompt(cfg, &tok, &creq.messages) {
        Ok(v) => v,
        Err(e) => return json_err(out, 400, &e),
    };
    let params = gen_params(cfg, &creq, stops);
    let mode = creq.target.as_deref().unwrap_or("auto");
    let id = completion_id();
    let created = (now_ms() / 1000) as u64;
    let model = cfg.name.clone();

    if creq.stream.unwrap_or(false) {
        // ---- streaming: OpenAI chunk protocol over SSE
        let headers = Fields::new();
        let _ = headers.set(&"content-type".to_string(), &[b"text/event-stream".to_vec()]);
        let _ = headers.set(&"cache-control".to_string(), &[b"no-cache".to_vec()]);
        let resp = OutgoingResponse::new(headers);
        let body = resp.body().unwrap();
        ResponseOutparam::set(out, Ok(resp));
        let stream = body.write().unwrap();
        let send_raw = |s: &str| -> bool {
            for chunk in s.as_bytes().chunks(4000) {
                if stream.blocking_write_and_flush(chunk).is_err() {
                    return false;
                }
            }
            true
        };
        let chunk = |delta: serde_json::Value, finish: Option<&str>| -> String {
            format!(
                "data: {}\n\n",
                serde_json::json!({
                    "id": id, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
                })
            )
        };
        // role preamble chunk (OpenAI clients expect it)
        let _ = send_raw(&chunk(serde_json::json!({ "role": "assistant" }), None));

        let mut last_err = String::new();
        let mut done_stats: Option<GenStats> = None;
        for (target, tname) in targets_for(mode).iter() {
            let emit = |delta: &str| send_raw(&chunk(serde_json::json!({ "content": delta }), None));
            // OpenAI protocol has no status events; SSE comments keep the
            // connection warm through cold session init without confusing SDKs
            let status = |s: &str| send_raw(&format!(": {s}\n\n"));
            match generate(cfg, &tok, &prompt_ids, *target, tname, &params, &emit, &status) {
                Ok(s) => {
                    done_stats = Some(s);
                    break;
                }
                Err(e) => last_err = format!("{tname}: {e}"),
            }
        }
        match done_stats {
            Some(s) => {
                let _ = send_raw(&chunk(serde_json::json!({}), Some(s.finish_reason)));
                let _ = send_raw("data: [DONE]\n\n");
            }
            None => {
                let _ = send_raw(&format!(
                    "data: {}\n\n",
                    serde_json::json!({ "error": { "message": last_err, "type": "server_error" } })
                ));
            }
        }
        drop(stream);
        let _ = OutgoingBody::finish(body, None);
    } else {
        // ---- non-streaming: run to completion, one JSON response
        let sink = |_: &str| true;
        let mut last_err = String::new();
        let mut result: Option<GenStats> = None;
        for (target, tname) in targets_for(mode).iter() {
            match generate(cfg, &tok, &prompt_ids, *target, tname, &params, &sink, &sink) {
                Ok(s) => {
                    result = Some(s);
                    break;
                }
                Err(e) => last_err = format!("{tname}: {e}"),
            }
        }
        match result {
            Some(s) => {
                let body_json = serde_json::json!({
                    "id": id, "object": "chat.completion", "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "message": { "role": "assistant", "content": s.text },
                        "finish_reason": s.finish_reason,
                    }],
                    "usage": {
                        "prompt_tokens": s.prompt_tokens,
                        "completion_tokens": s.tokens,
                        "total_tokens": s.prompt_tokens + s.tokens,
                    },
                    "nan": { "target": s.target, "load_ms": s.load_ms as u64,
                             "prefill_ms": s.prefill_ms as u64, "decode_ms": s.decode_ms as u64 },
                });
                respond_bytes(out, 200, "application/json", body_json.to_string().as_bytes());
            }
            None => json_err(out, 500, &last_err),
        }
    }
}

fn handle_models(cfg: &AppConfig, req: IncomingRequest, out: ResponseOutparam) {
    if !authorized(cfg, &req) {
        return json_err(out, 401, "missing or invalid API key");
    }
    let body = serde_json::json!({
        "object": "list",
        "data": [{ "id": cfg.name, "object": "model", "owned_by": "nan-deployment" }],
    });
    respond_bytes(out, 200, "application/json", body.to_string().as_bytes());
}

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let cfg = match AppConfig::load() {
            Ok(c) => c,
            Err(e) => return json_err(out, 500, &format!("configuration error: {e}")),
        };
        let pq = req.path_with_query().unwrap_or_default();
        let path = pq.split('?').next().unwrap_or("/");
        let method = req.method();
        match (method, path) {
            (Method::Get, "/") | (Method::Get, "") => {
                respond_bytes(out, 200, "text/html; charset=utf-8", CHAT_HTML.as_bytes())
            }
            (Method::Get, "/ping") => respond_bytes(
                out,
                200,
                "application/json",
                format!("{{\"ok\":true,\"pong\":true,\"t\":{}}}", now_ms()).as_bytes(),
            ),
            (Method::Post, "/chat") => handle_chat(&cfg, req, out),
            (Method::Post, "/v1/chat/completions") => handle_completions(&cfg, req, out),
            (Method::Get, "/v1/models") => handle_models(&cfg, req, out),
            _ => json_err(
                out,
                404,
                "not found; routes: GET /, GET /ping, GET /v1/models, POST /v1/chat/completions, POST /chat",
            ),
        }
    }
}

bindings::export!(Component with_types_in bindings);
