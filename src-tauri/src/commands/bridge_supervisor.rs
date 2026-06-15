// bridge_supervisor.rs — Phase 55.3.0
//
// The bridge no longer runs as a child of the tray. After folding the
// installer in, the bridge is a long-lived `systemctl --user` service
// (inside WSL Ubuntu on Windows, native on Linux) or a launchd agent on
// macOS. The tray is a Tailscale-style controller: it starts / stops /
// restarts the service and reports its status, but quitting the tray does
// NOT stop the bridge.
//
// Why a struct with no state?
// ---------------------------
// systemctl is the single source of truth for "is the bridge running".
// The supervisor holds no `Child` handle anymore — every method shells out
// to the service manager. The struct stays so it can live as Tauri managed
// state (mirrors the previous shape lib.rs + the menu handlers expect).

use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Same CREATE_NO_WINDOW story as commands/shell.rs — the synchronous
// systemctl-over-wsl calls would otherwise each flash their own console.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SERVICE: &str = "agentcontrol-bridge";

pub struct BridgeSupervisor;

impl BridgeSupervisor {
    pub fn new() -> Self {
        Self
    }

    /// `systemctl --user start agentcontrol-bridge` (idempotent — a
    /// no-op if the service is already active).
    pub fn start(&self) -> Result<(), String> {
        self.systemctl(&["start", SERVICE])
    }

    /// `systemctl --user stop agentcontrol-bridge`. Best-effort.
    pub fn stop(&self) {
        let _ = self.systemctl(&["stop", SERVICE]);
    }

    /// `systemctl --user restart agentcontrol-bridge`.
    pub fn restart(&self) -> Result<(), String> {
        self.systemctl(&["restart", SERVICE])
    }

    /// `systemctl --user is-active` exits 0 when the unit is running.
    pub fn is_running(&self) -> bool {
        self.status(&["is-active", "--quiet", SERVICE])
            .map(|code| code == 0)
            .unwrap_or(false)
    }

    /// Run a systemctl --user invocation, returning Err on non-zero exit
    /// so the caller can surface the failure (e.g. WSL not installed yet).
    fn systemctl(&self, args: &[&str]) -> Result<(), String> {
        match self.status(args)? {
            0 => Ok(()),
            code => Err(format!("systemctl {} exited {code}", args.join(" "))),
        }
    }

    /// Build + run the platform-specific service-manager command, returning
    /// its exit code. Windows routes through `wsl -d <distro> --`; Linux runs
    /// natively; macOS is not yet wired (launchd support pending).
    fn status(&self, args: &[&str]) -> Result<i32, String> {
        let mut cmd = self.command(args)?;
        let status = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("spawn service manager: {e}"))?;
        Ok(status.code().unwrap_or(-1))
    }

    #[cfg(target_os = "windows")]
    fn command(&self, args: &[&str]) -> Result<Command, String> {
        let distro = super::ubuntu::detect_ubuntu()
            .ok_or_else(|| "no WSL distro registered — run onboarding first".to_string())?;
        let mut cmd = Command::new("wsl");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.args(["-d", &distro, "--", "systemctl", "--user"]);
        cmd.args(args);
        Ok(cmd)
    }

    #[cfg(target_os = "linux")]
    fn command(&self, args: &[&str]) -> Result<Command, String> {
        let mut cmd = Command::new("systemctl");
        cmd.arg("--user");
        cmd.args(args);
        Ok(cmd)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    fn command(&self, _args: &[&str]) -> Result<Command, String> {
        // macOS launchd (launchctl load/unload
        // ~/Library/LaunchAgents/dev.agentcontrol.bridge.plist) is not yet
        // implemented — see Phase 55.3.x. Surface a clear error rather than
        // silently pretending the bridge is managed.
        Err("bridge service control not yet supported on this platform".to_string())
    }
}

impl Default for BridgeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}
