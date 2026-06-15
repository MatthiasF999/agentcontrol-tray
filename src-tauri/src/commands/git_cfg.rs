use super::shell::{run_in_wsl, run_in_wsl_capture, shell_quote, CommandResult};
use super::ubuntu::detect_ubuntu;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConfig {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Pre-flight read of `git config --global user.{name,email}` from inside the
/// WSL distro that the installer will write into. Lets the Setup screen
/// pre-fill the fields so users with an existing dotfile don't retype them.
/// Returns `{name: None, email: None}` when no distro is registered yet.
#[tauri::command]
pub async fn read_git_config() -> Result<GitConfig, String> {
    let Some(distro) = detect_ubuntu() else {
        return Ok(GitConfig {
            name: None,
            email: None,
        });
    };
    Ok(GitConfig {
        name: read_one(&distro, "user.name").await,
        email: read_one(&distro, "user.email").await,
    })
}

async fn read_one(distro: &str, key: &str) -> Option<String> {
    // `|| true` so a missing key (exit 1) doesn't bubble up as an error.
    let cmd = format!("git config --global --get {key} || true");
    let value = run_in_wsl_capture(distro, &cmd).await.ok()?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[tauri::command]
pub async fn configure_git(
    app: AppHandle,
    distro: String,
    name: String,
    email: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = format!(
        "git config --global user.name {} && git config --global user.email {}",
        shell_quote(&name),
        shell_quote(&email),
    );
    run_in_wsl(app, distro, cmd, event_id).await
}
