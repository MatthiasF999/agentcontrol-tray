use super::shell::{run_wsl_host, CommandResult};
use serde::Serialize;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Same CREATE_NO_WINDOW story as shell.rs — the sync `wsl --status` /
// `wsl --list --quiet` calls would otherwise each flash their own console.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn wsl_command() -> Command {
    let cmd = Command::new("wsl");
    #[cfg(target_os = "windows")]
    {
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(target_os = "windows"))]
    cmd
}

// camelCase rename so JS can read `wsl.defaultDistro` directly. Without this,
// the property is `undefined` on the JS side and the v0.0.5 detect-existing
// logic silently misses a configured default distro.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    pub installed: bool,
    pub default_distro: Option<String>,
    pub distros: Vec<String>,
}

#[tauri::command]
pub fn detect_wsl() -> Result<WslStatus, String> {
    if !cfg!(target_os = "windows") {
        return Ok(WslStatus {
            installed: false,
            default_distro: None,
            distros: Vec::new(),
        });
    }
    let status = wsl_command().arg("--status").output();
    let installed = matches!(&status, Ok(o) if o.status.success());
    if !installed {
        return Ok(WslStatus {
            installed: false,
            default_distro: None,
            distros: Vec::new(),
        });
    }
    let default_distro = status.ok().and_then(|o| parse_default_distro(&decode(&o.stdout)));
    Ok(WslStatus {
        installed: true,
        default_distro,
        distros: list_distros(),
    })
}

#[tauri::command]
pub async fn install_wsl() -> Result<CommandResult, String> {
    run_wsl_host(&["--install", "--no-distribution"]).await
}

/// `wsl --list --quiet`, decoded from the UTF-16LE that wsl.exe emits.
pub(crate) fn list_distros() -> Vec<String> {
    let Ok(output) = wsl_command().args(["--list", "--quiet"]).output() else {
        return Vec::new();
    };
    decode(&output.stdout)
        .lines()
        .map(|l| l.trim().trim_end_matches('\r').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn parse_default_distro(status_text: &str) -> Option<String> {
    status_text.lines().find_map(|line| {
        line.split_once(':')
            .filter(|(k, _)| k.to_lowercase().contains("default"))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// wsl.exe writes UTF-16LE on Windows; fall back to UTF-8 elsewhere.
fn decode(bytes: &[u8]) -> String {
    let has_nuls = bytes.iter().take(64).any(|&b| b == 0);
    if has_nuls && bytes.len() >= 2 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}
