//! vault: the web UI for NaN's wallet-gated encrypted volumes.
//!
//! A tiny wasi:http component that serves a self-contained browser app. All
//! of the cryptography (scripts/nan-vault.mjs via @noble), the chain access
//! (viem) and the attestation verifier (@tinfoilsh/verifier) are VENDORED
//! into vault.js at build time - the page loads nothing from a CDN, because
//! a script fetched at runtime could exfiltrate the wallet-derived vault key
//! or the unsealed VEK. See js/README notes in js/build.mjs.
//!
//! Routes:
//!   GET /             - the vault app (self-contained HTML).
//!   GET /vault.js     - the vendored crypto + app bundle (generated, checked in).
//!   GET /config.json  - embedded defaults overlaid with NAN_CONFIG (the
//!                       deployment's CID-verified configCid JSON): contract
//!                       addresses, RPC, chain id, attestation repo.
//!   GET /ping         - liveness.
//!
//! What the app does (the browser side of scripts/nan-vault-client.mjs):
//! connect wallet -> sign DERIVE_MESSAGE -> derive X25519 -> register the
//! pubkey on NanVolumeAccess -> unseal own sealedVEK -> resolve the
//! deployment's runner enclave from chain state (NanDeployments.get(id).runner
//! = keccak256 of the NanRegistry endpoint) -> verify THAT enclave's
//! attestation -> seal the VEK to its per-boot vault pubkey -> SIWE ->
//! POST /v1/deployments/:id/unlock-sealed. Owner panel: createVolume, member
//! list (getMemberPage), grant/revoke.
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};

static VAULT_HTML: &str = include_str!("vault.html");
static VAULT_JS: &str = include_str!("vault.js");

/// Embedded defaults for /config.json. Every key can be overridden per
/// deployment through NAN_CONFIG (shallow merge, unknown keys pass through).
/// volumeAccess is set at go-live (the contract is hand-deployed); until then
/// the UI asks for it (or takes ?contract= in the URL).
const CONFIG_DEFAULTS: &str = r#"{
  "chainId": 8453,
  "rpc": "https://mainnet.base.org",
  "volumeAccess": "0x4e3Dc12FF865e259F6bBD97689Df6Ccc7103e7dD",
  "deployments": "0x81037A2081bc000F12B8aA771bede0d36742ec4b",
  "registry": "0x13deE63b80353a15C6E03D54240EE463B420353F",
  "repo": "SteveDeFacto/nan"
}"#;

fn config_json() -> Result<String, String> {
    let mut cfg: serde_json::Value =
        serde_json::from_str(CONFIG_DEFAULTS).map_err(|e| e.to_string())?;
    if let Ok(raw) = std::env::var("NAN_CONFIG") {
        if !raw.trim().is_empty() {
            let over: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("NAN_CONFIG is not valid JSON: {e}"))?;
            let over = over
                .as_object()
                .ok_or("NAN_CONFIG must be a JSON object")?;
            let map = cfg.as_object_mut().unwrap();
            for (k, v) in over {
                map.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(cfg.to_string())
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

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let pq = req.path_with_query().unwrap_or_default();
        let path = pq.split('?').next().unwrap_or("/");
        match (req.method(), path) {
            (Method::Get, "/") | (Method::Get, "") => {
                respond_bytes(out, 200, "text/html; charset=utf-8", VAULT_HTML.as_bytes())
            }
            (Method::Get, "/vault.js") => respond_bytes(
                out,
                200,
                "application/javascript; charset=utf-8",
                VAULT_JS.as_bytes(),
            ),
            (Method::Get, "/config.json") => match config_json() {
                Ok(body) => respond_bytes(out, 200, "application/json", body.as_bytes()),
                Err(e) => json_err(out, 500, &format!("configuration error: {e}")),
            },
            (Method::Get, "/ping") => {
                respond_bytes(out, 200, "application/json", b"{\"ok\":true,\"pong\":true}")
            }
            _ => json_err(
                out,
                404,
                "not found; routes: GET /, GET /vault.js, GET /config.json, GET /ping",
            ),
        }
    }
}

bindings::export!(Component with_types_in bindings);
