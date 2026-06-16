use super::shell::{run_in_wsl, run_in_wsl_capture, CommandResult};
use crate::config;
use tauri::AppHandle;
use tokio::time::{sleep, Duration};

// Bridge tarball lives on the same Hetzner Caddy that serves /app/*.
// The bridge repo is private, so GitHub's `archive/refs/heads/main.tar.gz`
// endpoint would 404 without an auth header — baking a token into the
// tray is a non-starter. The tarball lives on the host at
// `/srv/install/bridge.tar.gz` (gitignored in the supabase repo), refreshed
// out of band when the bridge ships a new version. URL host is configurable
// via the `HETZNER_HOST` build-time env (see `crate::config`).
const BRIDGE_DIR: &str = "$HOME/agentcontrol-bridge";

#[tauri::command]
pub async fn download_bridge(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    // `-k` because the Hetzner Caddy serves an internal CA cert (IP literal
    // for `default_sni`), which Ubuntu inside WSL doesn't trust by default.
    // Tightening this means either shipping the CA, switching to a public
    // domain + Let's Encrypt, or signing the tarball and checking the sig
    // post-download — none of which are critical-path for the first ship.
    let cmd = format!(
        "mkdir -p {dir} && curl -fsSLk {url} | tar -xz -C {dir} --strip-components=1",
        dir = BRIDGE_DIR,
        url = config::bridge_tarball_url(),
    );
    run_in_wsl(app, distro, cmd, event_id).await
}

#[tauri::command]
pub async fn npm_install_bridge(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = format!("cd {BRIDGE_DIR} && npm install --no-fund --no-audit");
    run_in_wsl(app, distro, cmd, event_id).await
}

/// Compile the bridge TypeScript; required before `npm start` runs `dist/index.js`.
#[tauri::command]
pub async fn npm_run_build_bridge(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = format!("cd {BRIDGE_DIR} && npm run build");
    run_in_wsl(app, distro, cmd, event_id).await
}

/// Query the bridge's `/pair` endpoint and return a one-word summary:
/// `"paired"`, `"unpaired"`, `"expired"`, or `"unreachable"`. Used by the
/// onboarding gate to skip the wizard when the bridge is already wired up.
#[tauri::command]
pub async fn bridge_pair_state(distro: String) -> Result<String, String> {
    let probe = "curl -fsS http://127.0.0.1:3001/pair 2>/dev/null | \
                 grep -oE '\"state\"[[:space:]]*:[[:space:]]*\"[a-z]+\"' | \
                 grep -oE '[a-z]+' | tail -1";
    let out = run_in_wsl_capture(&distro, probe).await?;
    Ok(if out.is_empty() {
        "unreachable".to_string()
    } else {
        out
    })
}

/// Ask the running bridge for its current pairing claim code via the local
/// HTTP `/pair` endpoint.
///
/// Earlier revisions force-restarted the bridge here + grepped the
/// journal. That created a feedback loop with systemd `Restart=always`:
/// each bridge boot fires one `bridge-claim` call, the rate limiter on
/// the Supabase edge function caps that machine at ~5/min, and any
/// extra restart (from this function, from the user reopening the
/// onboarding wizard, or from a downstream startup failure) hits the
/// limit → 429 → no new claim code → tray polls forever, restarts
/// again, repeat.
///
/// Instead: the bridge already exposes `GET /pair` (the legacy LAN
/// pairing UI's data source). It returns the active claim code if the
/// bridge is unpaired, plus expiry. Poll that — no restart, no
/// journal grep, no rate-limit cascade.
#[tauri::command]
pub async fn wait_for_claim_code(distro: String) -> Result<String, String> {
    let probe = "curl -fsS http://127.0.0.1:3001/pair 2>/dev/null | \
                 grep -oE '\"code\"[[:space:]]*:[[:space:]]*\"[A-Z0-9]{4}-[A-Z0-9]{4}\"' | \
                 grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' | tail -1";
    for _ in 0..30 {
        let out = run_in_wsl_capture(&distro, probe).await?;
        if !out.is_empty() {
            return Ok(out);
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err("bridge did not expose a claim code on /pair within 30s".to_string())
}
