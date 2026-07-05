//! App configuration: model geometry, chat template, sampling defaults and
//! the optional API key. Defaults come from the embedded assets/app-config.json
//! (pinned next to the model it describes); a deployment can override any
//! field through the NAN_CONFIG env var - a JSON object the platform passes
//! from the deployment's on-chain configCid (CID-verified by the enclave
//! before it reaches us). Publish the app once, deploy it per-model/per-key.

use serde::Deserialize;

pub static APP_CONFIG_JSON: &[u8] = include_bytes!("../assets/app-config.json");

#[derive(Deserialize, Clone)]
pub struct AppConfig {
    /// model name reported by /v1/models and echoed in completions
    pub name: String,
    pub n_layers: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    pub vocab: usize,
    pub eos: Vec<u32>,
    /// chat template: "chatml" | "llama3" | "gemma" | "phi3" | "raw"
    pub template: String,
    pub system_prompt: String,
    pub max_prompt_tokens: usize,
    pub default_max_new: usize,
    pub max_new_cap: usize,
    pub rep_penalty: f32,
    pub rep_window: usize,
    /// when set, /v1/* requires `Authorization: Bearer <api_key>`. The chat
    /// UI and legacy /chat stay open - gate those with a PRIVATE deployment.
    #[serde(default)]
    pub api_key: Option<String>,
    /// reserved for fetch-at-boot models (0.4): url + sha256 of an external
    /// model; ignored by this version, accepted so configs can carry it now
    #[serde(default)]
    pub model_url: Option<String>,
    #[serde(default)]
    pub model_sha256: Option<String>,
}

impl AppConfig {
    /// Embedded defaults, overlaid with NAN_CONFIG (if present and valid).
    /// Unknown NAN_CONFIG fields are ignored; a malformed NAN_CONFIG is
    /// reported so a bad deployment config fails loudly instead of silently
    /// serving the wrong model shape.
    pub fn load() -> Result<AppConfig, String> {
        let base: serde_json::Value = serde_json::from_slice(APP_CONFIG_JSON)
            .map_err(|e| format!("embedded app-config.json: {e}"))?;
        let merged = match std::env::var("NAN_CONFIG") {
            Ok(raw) if !raw.trim().is_empty() => {
                let over: serde_json::Value = serde_json::from_str(&raw)
                    .map_err(|e| format!("NAN_CONFIG is not valid JSON: {e}"))?;
                merge(base, over)
            }
            _ => base,
        };
        serde_json::from_value(merged).map_err(|e| format!("config: {e}"))
    }
}

fn merge(mut base: serde_json::Value, over: serde_json::Value) -> serde_json::Value {
    if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

/// A rendered prompt plus the strings that should terminate generation for
/// this template (in addition to the tokenizer-level EOS ids).
pub struct Rendered {
    pub prompt: String,
    pub stop_strings: Vec<String>,
}

pub fn render_template(
    template: &str,
    system: &str,
    msgs: &[(String, String)], // (role, content), roles pre-filtered to user/assistant
) -> Result<Rendered, String> {
    let mut p = String::new();
    let stops: Vec<String>;
    match template {
        "chatml" => {
            p.push_str(&format!("<|im_start|>system\n{system}<|im_end|>\n"));
            for (role, content) in msgs {
                p.push_str(&format!("<|im_start|>{role}\n{content}<|im_end|>\n"));
            }
            p.push_str("<|im_start|>assistant\n");
            stops = vec!["<|im_end|>".into(), "<|im_start|>".into()];
        }
        "llama3" => {
            p.push_str(&format!(
                "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|>"
            ));
            for (role, content) in msgs {
                p.push_str(&format!(
                    "<|start_header_id|>{role}<|end_header_id|>\n\n{content}<|eot_id|>"
                ));
            }
            p.push_str("<|start_header_id|>assistant<|end_header_id|>\n\n");
            stops = vec!["<|eot_id|>".into()];
        }
        "gemma" => {
            // gemma has no system role; fold it into the first user turn
            let mut first = true;
            for (role, content) in msgs {
                let r = if role == "assistant" { "model" } else { "user" };
                let c = if first && r == "user" && !system.is_empty() {
                    first = false;
                    format!("{system}\n\n{content}")
                } else {
                    first = false;
                    content.clone()
                };
                p.push_str(&format!("<start_of_turn>{r}\n{c}<end_of_turn>\n"));
            }
            p.push_str("<start_of_turn>model\n");
            stops = vec!["<end_of_turn>".into()];
        }
        "phi3" => {
            p.push_str(&format!("<|system|>\n{system}<|end|>\n"));
            for (role, content) in msgs {
                p.push_str(&format!("<|{role}|>\n{content}<|end|>\n"));
            }
            p.push_str("<|assistant|>\n");
            stops = vec!["<|end|>".into()];
        }
        "raw" => {
            // plain concatenation for base models: no roles, no control tokens
            if !system.is_empty() {
                p.push_str(system);
                p.push_str("\n\n");
            }
            for (_, content) in msgs {
                p.push_str(content);
                p.push('\n');
            }
            stops = vec![];
        }
        other => return Err(format!("unknown template '{other}' (chatml|llama3|gemma|phi3|raw)")),
    }
    Ok(Rendered { prompt: p, stop_strings: stops })
}
