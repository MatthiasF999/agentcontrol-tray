use super::shell::{run_in_wsl, run_in_wsl_quiet, CommandResult};
use tauri::AppHandle;

const SERVICE_UNIT: &str = r#"[Unit]
Description=AgentControl Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/agentcontrol-bridge
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5

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
    let probe = "sleep 3; for _ in $(seq 1 15); do \
                 code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health || true); \
                 if [ \"$code\" = \"200\" ]; then exit 0; fi; sleep 2; done; exit 1";
    let result = run_in_wsl_quiet(&distro, probe).await?;
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err("bridge did not report healthy within 30s after restart".to_string())
    }
}
