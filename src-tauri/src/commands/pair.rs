use super::shell::{env_upsert, run_in_wsl_quiet};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const OPERATOR_PORTAL: &str = "https://178.105.244.59/operator/";
const BRIDGE_DIR: &str = "$HOME/agentcontrol-bridge";

#[derive(Clone, serde::Serialize)]
pub struct PairTokens {
    pub refresh_token: String,
    pub bridge_id: String,
    pub org_id: String,
    pub lan_api_key: String,
}

#[tauri::command]
pub fn open_operator_portal(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(OPERATOR_PORTAL, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Parse `agentcontrol-tray://pair?...` deep links and forward the
/// pairing tokens to the frontend via the `pair-tokens-received` event.
pub fn emit_pair_tokens(app: &AppHandle, url: &Url) {
    if url.scheme() != "agentcontrol-tray" || url.host_str() != Some("pair") {
        return;
    }
    let mut refresh_token = String::new();
    let mut bridge_id = String::new();
    let mut org_id = String::new();
    let mut lan_api_key = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "refresh_token" => refresh_token = value.into_owned(),
            "bridge_id" => bridge_id = value.into_owned(),
            "org_id" => org_id = value.into_owned(),
            "lan_api_key" => lan_api_key = value.into_owned(),
            _ => {}
        }
    }
    if refresh_token.is_empty() || bridge_id.is_empty() || org_id.is_empty() {
        return;
    }
    let _ = app.emit(
        "pair-tokens-received",
        PairTokens {
            refresh_token,
            bridge_id,
            org_id,
            lan_api_key,
        },
    );
}

/// Write the pairing credentials (returned from the portal after sign-in) into
/// the bridge `.env`. Does NOT restart — the wizard calls `restart_bridge_service`
/// separately so the two concerns stay independently retryable.
///
/// `lan_api_key` is the cloud-issued shared secret; the bridge reads it from the
/// `API_KEY` env var (overwriting the random one the install step generated).
#[tauri::command]
pub async fn write_pair_env(
    distro: String,
    refresh_token: String,
    bridge_id: String,
    org_id: String,
    lan_api_key: String,
) -> Result<(), String> {
    let write_env = format!(
        "cd {BRIDGE_DIR} && touch .env && {} && {} && {} && {}",
        env_upsert("BRIDGE_SMOKE_REFRESH_TOKEN", &refresh_token),
        env_upsert("BRIDGE_SMOKE_BRIDGE_ID", &bridge_id),
        env_upsert("BRIDGE_SMOKE_ORG_ID", &org_id),
        env_upsert("API_KEY", &lan_api_key),
    );
    let written = run_in_wsl_quiet(&distro, &write_env).await?;
    if written.exit_code != 0 {
        return Err(format!(
            "failed to write pairing env (exit {})",
            written.exit_code
        ));
    }
    Ok(())
}
