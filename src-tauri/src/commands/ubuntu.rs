use super::shell::{run_wsl_host, CommandResult};
use super::wsl::detect_wsl;

/// Returns the name of an existing WSL distro to reuse, or `None` if a fresh
/// `Ubuntu-22.04` install is needed. Preference order:
///   1. WSL's configured default distro (user said "always default if present")
///   2. First entry in `wsl --list --quiet`
///   3. None — caller should run `install_ubuntu()` and use `"Ubuntu-22.04"`.
#[tauri::command]
pub fn detect_ubuntu() -> Option<String> {
    let wsl = detect_wsl().ok()?;
    if !wsl.installed {
        return None;
    }
    if let Some(d) = wsl.default_distro {
        return Some(d);
    }
    wsl.distros.into_iter().next()
}

#[tauri::command]
pub async fn install_ubuntu() -> Result<CommandResult, String> {
    run_wsl_host(&["--install", "-d", "Ubuntu-22.04"]).await
}
