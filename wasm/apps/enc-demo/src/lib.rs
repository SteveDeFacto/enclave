//! enc-demo: the first-party sample for encrypted volumes (enclave-vault).
//!
//! Deployed with a wallet-gated `encVolumes` config, this app holds at
//! awaiting_unlock until an authorized wallet delivers the sealed VEK (vault
//! app / enclave-vault-client). Once running, the platform preopens each
//! decrypted volume READ-ONLY at /enc/<name> and lists the names in ENCLAVE_ENC -
//! and this app simply serves what it sees, proving the guest-visible
//! plaintext path end to end. Everything here is plain WASI file I/O
//! (std::fs): identical code for the small tier (NANVOL1, decrypted to
//! enclave RAM) and the large tier (NANVOL2 under the wasmtime vault-fs
//! shim, blocks decrypted on demand).
//!
//! Routes:
//!   GET /              - volume browser (self-contained HTML).
//!   GET /ls            - JSON: every volume in ENCLAVE_ENC, walked recursively.
//!   GET /f/<vol>/<path>- raw file bytes from /enc/<vol>/<path>.
//!   GET /ping          - liveness, touches no volume.
//!
//! What this demonstrates for app authors: your code needs NO crypto, no
//! keys, no HTTP client - by the time it runs, /enc/<name> is a normal
//! directory. The operator's host only ever saw ciphertext.
#[allow(warnings)]
mod bindings;

use std::io::Read;
use std::path::{Path, PathBuf};

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};

static INDEX_HTML: &str = include_str!("index.html");
const MAX_LIST: usize = 10_000; // listing cap per volume (guard against huge trees)

fn enc_names() -> Vec<String> {
    std::env::var("ENCLAVE_ENC")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, u64)>) {
    if out.len() >= MAX_LIST {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            walk(&p, root, out);
        } else if meta.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push((rel.to_string_lossy().replace('\\', "/"), meta.len()));
            }
            if out.len() >= MAX_LIST {
                return;
            }
        }
    }
}

/// /f/<vol>/<path> -> the on-disk path, refusing traversal and volumes not in
/// ENCLAVE_ENC. Plain segment filtering - no "..", no absolute jumps, no empties.
fn resolve(vol: &str, rel: &str) -> Option<PathBuf> {
    if !enc_names().iter().any(|n| n == vol) {
        return None;
    }
    let mut p = PathBuf::from("/enc").join(vol);
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "html" | "htm" => "text/html; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
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
        serde_json::json!({ "error": { "message": msg } })
            .to_string()
            .as_bytes(),
    );
}

/// Stream a file straight from the volume into the response body - the file
/// may be bigger than guest memory wants to hold (NANVOL2 volumes decrypt
/// blocks on demand underneath this read loop).
fn serve_file(out: ResponseOutparam, path: &Path, ctype: &str) {
    let Ok(mut f) = std::fs::File::open(path) else {
        return json_err(out, 404, "no such file in this volume");
    };
    let headers = Fields::new();
    let _ = headers.set(&"content-type".to_string(), &[ctype.as_bytes().to_vec()]);
    let resp = OutgoingResponse::new(headers);
    let _ = resp.set_status_code(200);
    let body = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    let stream = body.write().unwrap();
    let mut buf = [0u8; 4000];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stream.blocking_write_and_flush(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    drop(stream);
    let _ = OutgoingBody::finish(body, None);
}

fn handle_ls(out: ResponseOutparam) {
    let mut vols = serde_json::Map::new();
    for name in enc_names() {
        let root = PathBuf::from("/enc").join(&name);
        let mut files = Vec::new();
        walk(&root, &root, &mut files);
        vols.insert(
            name,
            serde_json::json!({
                "files": files.iter().map(|(p, s)| serde_json::json!({ "path": p, "size": s })).collect::<Vec<_>>(),
                "truncated": files.len() >= MAX_LIST,
            }),
        );
    }
    let body = serde_json::json!({ "volumes": vols });
    respond_bytes(out, 200, "application/json", body.to_string().as_bytes());
}

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let pq = req.path_with_query().unwrap_or_default();
        let path = pq.split('?').next().unwrap_or("/");
        match (req.method(), path) {
            (Method::Get, "/") | (Method::Get, "") => {
                respond_bytes(out, 200, "text/html; charset=utf-8", INDEX_HTML.as_bytes())
            }
            (Method::Get, "/ping") => {
                respond_bytes(out, 200, "application/json", b"{\"ok\":true,\"pong\":true}")
            }
            (Method::Get, "/ls") => handle_ls(out),
            (Method::Get, p) if p.starts_with("/f/") => {
                let rest = &p[3..];
                let Some((vol, rel)) = rest.split_once('/') else {
                    return json_err(out, 400, "use /f/<volume>/<path>");
                };
                match resolve(vol, rel) {
                    Some(disk) => serve_file(out, &disk, content_type(rel)),
                    None => json_err(out, 404, "unknown volume or bad path"),
                }
            }
            _ => json_err(
                out,
                404,
                "not found; routes: GET /, GET /ls, GET /f/<volume>/<path>, GET /ping",
            ),
        }
    }
}

bindings::export!(Component with_types_in bindings);
