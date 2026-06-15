use super::shell::{env_upsert, run_in_wsl_quiet, shell_quote};
use rand::RngCore;

const PLACEHOLDER: &str = "change-me-generate-a-long-random-string";
const BRIDGE_DIR: &str = "$HOME/agentcontrol-bridge";

// Bridge needs these to reach the AgentControl backend. SUPABASE_URL and
// SUPABASE_FUNCTIONS_URL point at the same Hetzner Caddy the installer
// already downloads the bridge tarball from. SUPABASE_ANON_KEY is a long-
// lived public JWT (role=anon) — it's already shipped to every web client
// in the operator-portal bundle, so embedding it here doesn't widen any
// trust boundary.
const SUPABASE_URL: &str = "https://178.105.244.59";
const SUPABASE_FUNCTIONS_URL: &str = "https://178.105.244.59/functions/v1";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgwMjcxNDM2LCJleHAiOjIwOTU2MzE0MzZ9.X6qsRCvwhSg-dAQVQd188B8YoE1fZPi8I07nDnmww2A";

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
         {} && {} && {} && {} && {}",
        env_upsert("CLAUDE_HOME", &claude_home),
        env_upsert("SUPABASE_URL", SUPABASE_URL),
        env_upsert("SUPABASE_FUNCTIONS_URL", SUPABASE_FUNCTIONS_URL),
        env_upsert("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY),
        env_upsert("NODE_TLS_REJECT_UNAUTHORIZED", "0"),
    );
    let result = run_in_wsl_quiet(&distro, &cmd).await?;
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("write_env_file failed with exit code {}", result.exit_code))
    }
}
