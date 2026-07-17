use super::shell::{run_in_wsl, run_in_wsl_args, run_in_wsl_quiet, CommandResult};
use tauri::AppHandle;
use tokio::time::{sleep, Duration};

const SERVICE_UNIT: &str = r#"[Unit]
Description=AgentControl Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/agentcontrol-bridge
ExecStart=/usr/bin/env npm start
Restart=always
# 30s instead of 5s. The bridge calls `bridge-claim` once per cold boot
# and the edge function rate-limits per machine_fp (~5/min); a 5s gap
# would hit the limit within one minute of crash-looping. 30s keeps us
# well inside the bucket while still recovering "quickly enough" from
# a transient failure (network blip, supabase restart).
RestartSec=30

[Install]
WantedBy=default.target
"#;

#[tauri::command]
pub async fn install_systemd_service(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    // `restart` instead of `enable --now`: if the bridge was already
    // running from a previous install (or a previous installer run with a
    // stale .env), `enable --now` is a no-op and the bridge keeps using
    // the old env. The `--quiet` form on restart succeeds whether or not
    // the service was previously active, so it's safe for both first-
    // install and re-run cases.
    let cmd = format!(
        "mkdir -p $HOME/.config/systemd/user && \
         cat > $HOME/.config/systemd/user/agentcontrol-bridge.service <<'UNIT_EOF'\n\
         {SERVICE_UNIT}\
         UNIT_EOF\n\
         systemctl --user daemon-reload && \
         systemctl --user enable agentcontrol-bridge && \
         systemctl --user restart agentcontrol-bridge"
    );
    run_in_wsl(app, distro, cmd, event_id).await
}

/// Restart the bridge service (so it picks up freshly-written pairing env) and
/// wait for `/health` to report 200 for up to ~30s.
#[tauri::command]
pub async fn restart_bridge_service(distro: String) -> Result<(), String> {
    run_in_wsl_quiet(&distro, "systemctl --user restart agentcontrol-bridge").await?;
    // Poll `/health` in Rust with a direct-args curl. The previous inline bash
    // probe used `-w '%{http_code}'` and `[ "$code" = "200" ]`; those nested
    // quotes get mangled crossing the Windows → wsl.exe boundary, so the probe
    // returned empty and the restart falsely reported unhealthy. `%{http_code}`
    // passed as a literal curl arg (no shell) is quote-free and survives intact.
    sleep(Duration::from_secs(3)).await;
    for _ in 0..15 {
        let code = run_in_wsl_args(
            &distro,
            &[
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "http://127.0.0.1:3001/health",
            ],
        )
        .await
        .unwrap_or_default();
        if code == "200" {
            return Ok(());
        }
        sleep(Duration::from_secs(2)).await;
    }
    Err("bridge did not report healthy within 30s after restart".to_string())
}
