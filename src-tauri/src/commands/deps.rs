use super::shell::{run_in_wsl_streamed, CommandResult};
use tauri::AppHandle;

/// All three commands install system-wide packages and so must run as `root`.
/// Going through `sudo` instead would hang forever — `sudo` reads its password
/// prompt from `/dev/tty`, not piped stdin, so the installer never sees a
/// prompt and the call sits there with a blank wsl.exe window. Running with
/// `wsl -u root` skips `sudo` entirely.

#[tauri::command]
pub async fn apt_install_deps(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = "DEBIAN_FRONTEND=noninteractive apt-get update && \
               DEBIAN_FRONTEND=noninteractive apt-get install -y \
               build-essential git curl python3 openssl ca-certificates";
    run_in_wsl_streamed(app, &distro, Some("root"), cmd, &event_id).await
}

#[tauri::command]
pub async fn install_node22(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
               DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs";
    run_in_wsl_streamed(app, &distro, Some("root"), cmd, &event_id).await
}

#[tauri::command]
pub async fn install_claude_cli(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = "npm install -g @anthropic-ai/claude-code";
    run_in_wsl_streamed(app, &distro, Some("root"), cmd, &event_id).await
}
