use tokio::process::Command;

/// Best-effort host machine name, used as the pairing label so a bridge is
/// recognisable in the operator portal. `hostname` exists on Windows, macOS and
/// Linux; falls back to a generic label if it returns nothing.
#[tauri::command]
pub async fn get_machine_label() -> Result<String, String> {
    let output = Command::new("hostname")
        .output()
        .await
        .map_err(|e| format!("failed to run hostname: {e}"))?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        Ok("agentcontrol-bridge".to_string())
    } else {
        Ok(name)
    }
}
