use super::shell::run_in_wsl_quiet;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn open_claude_oauth(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://claude.ai", None::<&str>)
        .map_err(|e| e.to_string())
}

/// True once `claude login` has written credentials inside the WSL distro.
#[tauri::command]
pub async fn poll_claude_creds(distro: String) -> Result<bool, String> {
    let result = run_in_wsl_quiet(&distro, "test -f $HOME/.claude/.credentials.json").await?;
    Ok(result.exit_code == 0)
}
