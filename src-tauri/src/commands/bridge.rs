use super::shell::{run_in_wsl, run_in_wsl_capture, CommandResult};
use tauri::AppHandle;
use tokio::time::{sleep, Duration};

// Self-hosted tarball on the same Hetzner Caddy that serves /pair-installer.
// The bridge repo is private, so GitHub's `archive/refs/heads/main.tar.gz`
// endpoint would 404 without an auth header — and baking a token into the
// installer is a non-starter. The tarball lives on the host's
// `install/bridge.tar.gz` (gitignored in the supabase repo), refreshed out
// of band when the bridge ships a new version.
const TARBALL_URL: &str = "https://178.105.244.59/install/bridge.tar.gz";
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
        url = TARBALL_URL,
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

/// Poll the bridge journal for the one-time claim code (`AB12-CD34`).
///
/// The bridge mints a code with a 10-minute TTL the first time it boots
/// without a stored token. If the SignIn screen is reached more than a
/// few minutes later (e.g. user re-runs the installer), the original
/// code is already expired and we need a fresh one — so this function
/// kicks `systemctl --user restart` first to force the bridge through
/// the bootCloudMode path again. After the restart we look at the last
/// 10 minutes of journal to give the bootstrap room and to forgive a
/// slow first request.
#[tauri::command]
pub async fn wait_for_claim_code(distro: String) -> Result<String, String> {
    let _ = run_in_wsl_capture(
        &distro,
        "systemctl --user restart agentcontrol-bridge 2>&1 || true",
    )
    .await;
    let cmd = "journalctl --user -u agentcontrol-bridge --since '10 minutes ago' \
               --no-pager 2>/dev/null | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' | tail -1";
    for _ in 0..30 {
        let out = run_in_wsl_capture(&distro, cmd).await?;
        if !out.is_empty() {
            return Ok(out);
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err("no claim code found in bridge logs within 30s".to_string())
}
