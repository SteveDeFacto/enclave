//! llm-chat: a small LLM (SmolLM2-135M-Instruct, ONNX q4f16) compiled into a
//! wasm component, with a built-in web chat UI, running on NaN's wasi-nn GPU
//! interface.
//!
//! Routes:
//!   GET  /       - the chat page (self-contained HTML, no external assets).
//!   POST /chat   - {messages:[{role,content}], target?, max_tokens?} ->
//!                  Server-Sent Events: {"delta":"..."} per token, then
//!                  {"done":true, ...stats}. Errors stream as {"error":"..."}.
//!   GET  /ping   - liveness, touches no wasi-nn.
//!
//! Generation: autoregressive decode with the model's KV cache. The trick
//! that makes this cheap through wasi-nn: `compute()` returns OWNED tensor
//! resources for the 60 `present.*` KV tensors, and we hand those handles
//! straight back as the next step's `past_key_values.*` inputs - the cache
//! bytes never cross into guest memory. Only the logits are read out
//! (one vocab row per decode step).
#[allow(warnings)]
mod bindings;

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

static MODEL: &[u8] = include_bytes!("../assets/model_q4f16.onnx");
static TOKENIZER_JSON: &[u8] = include_bytes!("../assets/tokenizer.json");
static CHAT_HTML: &str = include_str!("chat.html");

// SmolLM2-135M geometry (config.json of the pinned export)
const N_LAYERS: u32 = 30;
const N_KV_HEADS: u32 = 3;
const HEAD_DIM: u32 = 64;
const VOCAB: usize = 49152;
const EOS: u32 = 2; // <|im_end|>

const SYSTEM_PROMPT: &str =
    "You are a helpful AI assistant named SmolLM, trained by Hugging Face";
// Prompt budget: KV traffic and prefill cost grow with context; a chat demo
// does not need more. Oldest turns are dropped (system prompt kept).
const MAX_PROMPT_TOKENS: usize = 768;
const PREFILL_CHUNK: usize = 128;
const DEFAULT_MAX_NEW: usize = 200;
const MAX_NEW_CAP: usize = 400;
const MAX_BODY_BYTES: usize = 64 * 1024;
const REP_PENALTY: f32 = 1.3;
const REP_WINDOW: usize = 64;

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

fn empty_past() -> Vec<(String, Tensor)> {
    let mut past = Vec::with_capacity((N_LAYERS * 2) as usize);
    for l in 0..N_LAYERS {
        for kind in ["key", "value"] {
            past.push((
                format!("past_key_values.{l}.{kind}"),
                Tensor::new(&[1, N_KV_HEADS, 0, HEAD_DIM], TensorType::Fp32, &[]),
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
    /// logits of the LAST position, parsed to f32
    logits: Vec<f32>,
    /// present.* KV tensors renamed to past_key_values.* for the next step
    past: Vec<(String, Tensor)>,
}

/// One forward pass. `past` is consumed (the host drops the old cache).
fn step(
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
    let mut next_past = Vec::with_capacity((N_LAYERS * 2) as usize);
    for (name, tensor) in outputs {
        if name == "logits" {
            if read_logits {
                let data = tensor.data();
                // full logits are [1, new_len, VOCAB] f32; keep the last row
                let row = VOCAB * 4;
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
    if next_past.len() != (N_LAYERS * 2) as usize {
        return Err(format!("expected {} KV outputs, got {}", N_LAYERS * 2, next_past.len()));
    }
    if read_logits && logits.len() != VOCAB {
        return Err("model returned no logits".into());
    }
    Ok(StepResult { logits, past: next_past })
}

fn pick_token(logits: &mut [f32], recent: &[u32]) -> u32 {
    // greedy + repetition penalty over the recent window: a 135M model loops
    // badly without it
    for &t in recent {
        let l = &mut logits[t as usize];
        if *l > 0.0 {
            *l /= REP_PENALTY;
        } else {
            *l *= REP_PENALTY;
        }
    }
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in logits.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best as u32
}

struct GenStats {
    target: String,
    prompt_tokens: usize,
    tokens: usize,
    load_ms: u128,
    prefill_ms: u128,
    decode_ms: u128,
}

/// Run the full chat completion; `emit` receives text deltas and returns
/// false when the client is gone (generation stops).
fn generate(
    tok: &Tokenizer,
    prompt_ids: &[u32],
    target: ExecutionTarget,
    tname: &str,
    max_new: usize,
    emit: &mut dyn FnMut(&str) -> bool,
) -> Result<GenStats, String> {
    let t0 = now_ms();
    let graph = load(&[MODEL.to_vec()], GraphEncoding::Onnx, target)
        .map_err(|e| nn_err("load", e))?;
    let ctx = graph
        .init_execution_context()
        .map_err(|e| nn_err("init", e))?;
    let load_ms = now_ms() - t0;

    // -- prefill, in chunks so no single logits tensor gets huge
    let t1 = now_ms();
    let ids: Vec<i64> = prompt_ids.iter().map(|&t| t as i64).collect();
    let mut past = empty_past();
    let mut done = 0usize;
    let mut logits = Vec::new();
    while done < ids.len() {
        let end = (done + PREFILL_CHUNK).min(ids.len());
        let last = end == ids.len();
        let r = step(&ctx, &ids[done..end], past, done, last)?;
        past = r.past;
        if last {
            logits = r.logits;
        }
        done = end;
    }
    let prefill_ms = now_ms() - t1;

    // -- decode
    let t2 = now_ms();
    let mut generated: Vec<u32> = Vec::new();
    let mut emitted = 0usize; // chars of decoded text already sent
    let mut total_len = ids.len();
    loop {
        let recent: Vec<u32> = if generated.is_empty() {
            prompt_ids[prompt_ids.len().saturating_sub(REP_WINDOW)..].to_vec()
        } else {
            generated[generated.len().saturating_sub(REP_WINDOW)..].to_vec()
        };
        let next = pick_token(&mut logits, &recent);
        if next == EOS || generated.len() >= max_new {
            break;
        }
        generated.push(next);

        // incremental detokenization: decode everything, emit the stable
        // suffix; hold back while the tail is an incomplete UTF-8 sequence
        if let Ok(text) = tok.decode(&generated, true) {
            if !text.ends_with('\u{FFFD}') && text.len() > emitted {
                // .get() guards the rare case where re-decoding shifted an
                // earlier byte boundary
                if let Some(delta) = text.get(emitted..) {
                    if !emit(delta) {
                        break; // client disconnected
                    }
                    emitted = text.len();
                }
            }
        }

        let r = step(&ctx, &[next as i64], past, total_len, true)?;
        past = r.past;
        logits = r.logits;
        total_len += 1;
    }
    let decode_ms = now_ms() - t2;

    Ok(GenStats {
        target: tname.to_string(),
        prompt_tokens: prompt_ids.len(),
        tokens: generated.len(),
        load_ms,
        prefill_ms,
        decode_ms,
    })
}

// -------------------------------------------------------------------- http --

#[derive(Deserialize)]
struct ChatReq {
    messages: Vec<ChatMsg>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    max_tokens: Option<usize>,
}

#[derive(Deserialize)]
struct ChatMsg {
    role: String,
    content: String,
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

/// Build the ChatML prompt; drops oldest turns until it fits the budget.
fn build_prompt(tok: &Tokenizer, messages: &[ChatMsg]) -> Result<Vec<u32>, String> {
    let mut msgs: Vec<&ChatMsg> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .collect();
    if msgs.is_empty() {
        return Err("no user/assistant messages".into());
    }
    loop {
        let mut prompt = format!("<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n");
        for m in &msgs {
            prompt.push_str(&format!("<|im_start|>{}\n{}<|im_end|>\n", m.role, m.content));
        }
        prompt.push_str("<|im_start|>assistant\n");
        let enc = tok
            .encode(prompt.as_str(), true)
            .map_err(|e| format!("tokenize: {e}"))?;
        let ids = enc.get_ids().to_vec();
        if ids.len() <= MAX_PROMPT_TOKENS || msgs.len() <= 1 {
            if ids.len() > MAX_PROMPT_TOKENS {
                return Err(format!(
                    "message too long: {} tokens (limit {MAX_PROMPT_TOKENS})",
                    ids.len()
                ));
            }
            return Ok(ids);
        }
        msgs.remove(0); // drop the oldest turn and retry
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

fn handle_chat(req: IncomingRequest, out: ResponseOutparam) {
    // Parse the request BEFORE opening the response so real errors can carry
    // proper status codes.
    let parsed: Result<ChatReq, String> = read_body(&req)
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| format!("bad JSON: {e}")));
    let creq = match parsed {
        Ok(c) => c,
        Err(e) => {
            return respond_bytes(
                out,
                400,
                "application/json",
                serde_json::json!({ "error": e }).to_string().as_bytes(),
            );
        }
    };

    let tok = match Tokenizer::from_bytes(TOKENIZER_JSON) {
        Ok(t) => t,
        Err(e) => {
            return respond_bytes(
                out,
                500,
                "application/json",
                serde_json::json!({ "error": format!("tokenizer: {e}") })
                    .to_string()
                    .as_bytes(),
            );
        }
    };
    let prompt_ids = match build_prompt(&tok, &creq.messages) {
        Ok(ids) => ids,
        Err(e) => {
            return respond_bytes(
                out,
                400,
                "application/json",
                serde_json::json!({ "error": e }).to_string().as_bytes(),
            );
        }
    };
    let max_new = creq.max_tokens.unwrap_or(DEFAULT_MAX_NEW).min(MAX_NEW_CAP).max(1);

    // open the SSE stream
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
    let attempts: Vec<(ExecutionTarget, &str)> = match mode {
        "cpu" => vec![(ExecutionTarget::Cpu, "cpu")],
        "gpu" => vec![(ExecutionTarget::Gpu, "gpu")],
        _ => vec![(ExecutionTarget::Gpu, "gpu"), (ExecutionTarget::Cpu, "cpu")],
    };

    let mut last_err = String::new();
    let mut ok = false;
    for (i, (target, tname)) in attempts.iter().enumerate() {
        if i > 0 && !send(serde_json::json!({ "notice": format!("gpu failed ({last_err}); retrying on cpu") })) {
            break;
        }
        let mut emit = |delta: &str| send(serde_json::json!({ "delta": delta }));
        match generate(&tok, &prompt_ids, *target, tname, max_new, &mut emit) {
            Ok(s) => {
                let gen_s = (s.decode_ms as f64) / 1000.0;
                let tok_per_s = if gen_s > 0.0 { s.tokens as f64 / gen_s } else { 0.0 };
                send(serde_json::json!({
                    "done": true, "target": s.target,
                    "prompt_tokens": s.prompt_tokens, "tokens": s.tokens,
                    "load_ms": s.load_ms as u64, "prefill_ms": s.prefill_ms as u64,
                    "decode_ms": s.decode_ms as u64,
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

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
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
            (Method::Post, "/chat") => handle_chat(req, out),
            _ => respond_bytes(
                out,
                404,
                "application/json",
                b"{\"error\":\"not found; routes: GET /, GET /ping, POST /chat\"}",
            ),
        }
    }
}

bindings::export!(Component with_types_in bindings);
