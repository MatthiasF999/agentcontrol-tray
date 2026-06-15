use super::shell::{env_upsert, run_in_wsl_quiet, shell_quote};
use crate::config;
use rand::RngCore;

const PLACEHOLDER: &str = "change-me-generate-a-long-random-string";
const BRIDGE_DIR: &str = "$HOME/agentcontrol-bridge";

#[tauri::command]
pub fn generate_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Materialise the bridge `.env` from its bundled `.env.example`:
///   - inject the generated `API_KEY` (replaces the placeholder)
///   - point `CLAUDE_HOME` at the WSL Claude config dir
///   - wire `SUPABASE_URL`, `SUPABASE_FUNCTIONS_URL`, `SUPABASE_ANON_KEY`
///     so the bridge can reach the bridge-claim edge function on boot
///   - set `NODE_TLS_REJECT_UNAUTHORIZED=0` so Node accepts the Caddy
///     internal cert (TODO: ship the CA + use `NODE_EXTRA_CA_CERTS` instead)
///   - set `PORT=3001` — tray's `bridgeClient` + `systemd::restart_bridge_service`
///     health-probe both target localhost:3001. The bridge's bundled
///     `.env.example` defaults to 3000 (matching its dev / Docker
///     defaults), so we override here so the new systemd-installed
///     instance lands on the port the tray actually queries.
#[tauri::command]
pub async fn write_env_file(
    distro: String,
    api_key: String,
    claude_home: String,
) -> Result<(), String> {
    let key = shell_quote(&api_key);
    let cmd = format!(
        "cd {BRIDGE_DIR} && cp -n .env.example .env && \
         sed -i \"s|{PLACEHOLDER}|$(printf %s {key})|\" .env && \
         {} && {} && {} && {} && {} && {}",
        env_upsert("CLAUDE_HOME", &claude_home),
        env_upsert("SUPABASE_URL", &config::base_url()),
        env_upsert("SUPABASE_FUNCTIONS_URL", &config::supabase_functions_url()),
        env_upsert("SUPABASE_ANON_KEY", config::SUPABASE_ANON_KEY),
        env_upsert("NODE_TLS_REJECT_UNAUTHORIZED", "0"),
        env_upsert("PORT", "3001"),
    );
    let result = run_in_wsl_quiet(&distro, &cmd).await?;
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("write_env_file failed with exit code {}", result.exit_code))
    }
}
