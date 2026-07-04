//! nn-demo: proves the wasi-nn path end to end. GET / runs the baked-in
//! 110-byte ONNX graph (Y = X + B) through the host's ONNX Runtime and
//! reports which execution target served it. `?target=cpu` / `?target=gpu`
//! forces the target (default gpu, falling back to cpu so the same app is
//! also runnable on nodes without a card — the fallback is reported).
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use bindings::wasi::nn::graph::{load, ExecutionTarget, GraphEncoding};
use bindings::wasi::nn::tensor::{Tensor, TensorType};

static MODEL: &[u8] = include_bytes!("model.onnx");
const INPUT: [f32; 4] = [1.0, 2.0, 3.0, 4.0];
const EXPECTED: [f32; 4] = [11.0, 22.0, 33.0, 44.0];

fn nn_err(stage: &str, e: bindings::wasi::nn::errors::Error) -> String {
    format!("{stage}: {:?}: {}", e.code(), e.data())
}

fn run(target: ExecutionTarget) -> Result<Vec<f32>, String> {
    let graph =
        load(&[MODEL.to_vec()], GraphEncoding::Onnx, target).map_err(|e| nn_err("load", e))?;
    let ctx = graph
        .init_execution_context()
        .map_err(|e| nn_err("init", e))?;
    let bytes: Vec<u8> = INPUT.iter().flat_map(|f| f.to_le_bytes()).collect();
    let x = Tensor::new(&[1, 4], TensorType::Fp32, &bytes);
    let outputs = ctx
        .compute(vec![("X".to_string(), x)])
        .map_err(|e| nn_err("compute", e))?;
    let (_, y) = outputs
        .into_iter()
        .next()
        .ok_or("compute returned no outputs")?;
    let data = y.data();
    Ok(data
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

fn attempt(want_gpu: bool, allow_fallback: bool) -> (String, Result<Vec<f32>, String>) {
    if want_gpu {
        let r = run(ExecutionTarget::Gpu);
        if r.is_ok() || !allow_fallback {
            return ("gpu".into(), r);
        }
        let gpu_err = r.unwrap_err();
        let cpu = run(ExecutionTarget::Cpu);
        return (format!("cpu (gpu failed: {gpu_err})"), cpu);
    }
    ("cpu".into(), run(ExecutionTarget::Cpu))
}

fn json_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            c if (c as u32) < 0x20 => format!("\\u{:04x}", c as u32).chars().collect(),
            c => vec![c],
        })
        .collect()
}

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let pq = req.path_with_query().unwrap_or_default();
        let query = pq.split_once('?').map(|(_, q)| q).unwrap_or("");
        let forced = query.split('&').find_map(|kv| {
            kv.strip_prefix("target=").map(|v| v.to_string())
        });
        // default: try gpu, report a cpu fallback; ?target= pins it (no fallback)
        let (target, result) = match forced.as_deref() {
            Some("cpu") => attempt(false, false),
            Some("gpu") => attempt(true, false),
            _ => attempt(true, true),
        };
        let body_json = match result {
            Ok(vals) => {
                let ok = vals.len() == EXPECTED.len()
                    && vals.iter().zip(EXPECTED).all(|(a, b)| (a - b).abs() < 1e-4);
                format!(
                    "{{\"ok\":{ok},\"target\":\"{}\",\"output\":{:?},\"expected\":{:?}}}",
                    json_escape(&target),
                    vals,
                    EXPECTED
                )
            }
            Err(e) => format!(
                "{{\"ok\":false,\"target\":\"{}\",\"error\":\"{}\"}}",
                json_escape(&target),
                json_escape(&e)
            ),
        };
        let headers = Fields::new();
        let _ = headers.set(&"content-type".to_string(), &[b"application/json".to_vec()]);
        let resp = OutgoingResponse::new(headers);
        let body = resp.body().unwrap();
        ResponseOutparam::set(out, Ok(resp));
        let stream = body.write().unwrap();
        let _ = stream.blocking_write_and_flush(body_json.as_bytes());
        drop(stream);
        let _ = OutgoingBody::finish(body, None);
    }
}

bindings::export!(Component with_types_in bindings);
