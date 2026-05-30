use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct DockerRunResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize)]
pub struct DockerAvailability {
    pub installed: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Probe for `docker` in PATH and report version. Used by the tray to decide
/// whether to render the bridge container-control buttons at all.
#[tauri::command]
pub fn docker_available() -> DockerAvailability {
    let output = match Command::new("docker").arg("--version").output() {
        Ok(o) => o,
        Err(e) => {
            return DockerAvailability {
                installed: false,
                version: None,
                error: Some(e.to_string()),
            };
        }
    };
    if !output.status.success() {
        return DockerAvailability {
            installed: false,
            version: None,
            error: Some(String::from_utf8_lossy(&output.stderr).into_owned()),
        };
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    DockerAvailability { installed: true, version: Some(version), error: None }
}

/// Run a docker compose subcommand in the supplied directory. The tray uses
/// this to start/stop/restart the bridge profile. We deliberately keep this
/// generic (caller passes the verb + flags) rather than baking specific
/// commands — the supabase compose project may evolve its profile names and
/// we don't want to re-release the tray for that.
#[tauri::command]
pub fn docker_compose(
    compose_dir: String,
    args: Vec<String>,
) -> Result<DockerRunResult, String> {
    if compose_dir.trim().is_empty() {
        return Err("compose_dir is empty".to_string());
    }
    if args.is_empty() {
        return Err("args is empty".to_string());
    }
    // Allowlist verbs to prevent the React side from triggering arbitrary
    // docker commands. `compose` plus a few known-safe subcommands.
    const ALLOWED_VERBS: &[&str] = &["up", "down", "restart", "ps", "logs", "config"];
    let verb = args.first().map(|s| s.as_str()).unwrap_or("");
    if !ALLOWED_VERBS.contains(&verb) {
        return Err(format!("verb '{}' not in allowlist", verb));
    }
    let mut cmd = Command::new("docker");
    cmd.arg("compose").current_dir(&compose_dir);
    for a in &args {
        cmd.arg(a);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(DockerRunResult {
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}
