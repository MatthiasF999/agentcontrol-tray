// bridge_supervisor.rs — Phase 39.11 MVP
//
// Spawns the Node.js bridge as a child of the tray process. The bridge
// code lives in `resources/bridge/dist/` + `resources/bridge/node_modules/`,
// bundled by the build script. We just need a `node` binary on the user's
// PATH (Node 20+) to launch it. The first-run wizard in 39.12 will check
// for that prereq and link to https://nodejs.org if missing.
//
// Why not Tauri sidecar?
// ---------------------
// Sidecar embeds the bridge as a single executable. That would require
// `pkg`/`bun build --compile` cross-builds, and better-sqlite3 + casbin
// native modules don't pack reliably. Using system Node + bundled
// dist/+node_modules sidesteps both. Trade-off: user installs Node once.
//
// Why a separate module?
// ---------------------
// lib.rs is at ~120 lines and growing. SoC: spawn/kill/status sit here,
// tray-icon + window + menu wiring stays in lib.rs.

use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

/// Wraps the spawned Node child so the tray can kill it on quit.
pub struct BridgeSupervisor {
    child: Arc<Mutex<Option<Child>>>,
}

impl BridgeSupervisor {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Spawn `node <resource-dir>/bridge/dist/index.js`. Returns an
    /// `Err` if Node is unreachable OR spawn fails; the tray surfaces
    /// the failure in the menu so the user can install Node and retry.
    pub fn spawn(&self, app: &AppHandle) -> Result<u32, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {}", e))?;
        let bridge_entry = resource_dir.join("bridge").join("dist").join("index.js");
        if !bridge_entry.exists() {
            return Err(format!(
                "bridge entry missing at {} — installer build script did not bundle it",
                bridge_entry.display()
            ));
        }

        // Probe node first for a clean error.
        let node_check = Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if node_check.is_err() || !node_check.unwrap().success() {
            return Err("node binary not found on PATH (install Node 20+ from https://nodejs.org)".into());
        }

        // Spawn detached-ish: inherit stdio so logs land in the parent
        // terminal in `tauri dev`. In a packaged release the parent has
        // no terminal; output is silently discarded (Phase 39.12 will
        // pipe it to a viewable log file).
        let mut cmd = Command::new("node");
        cmd.arg(&bridge_entry)
            .env("PORT", "3001")
            // Bridge resource dir = its working directory. Lets bridge
            // resolve relative paths (db/schema.sql, etc.) the same way
            // a manual `cd resources/bridge && node dist/index.js`
            // would.
            .current_dir(resource_dir.join("bridge"));

        // The tray launches the bridge in "local-bridge" mode: each
        // user runs their own, authenticated as themselves. No env
        // overrides here — the bridge reads .env from its working dir.

        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn bridge: {}", e))?;
        let pid = child.id();
        let mut guard = self.child.lock().unwrap();
        *guard = Some(child);
        Ok(pid)
    }

    /// Send SIGTERM (Unix) / TerminateProcess (Windows) to the bridge.
    /// Idempotent — no-op if the bridge already exited.
    pub fn kill(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Returns true if the bridge child is still running. Reaps zombie
    /// state by calling `try_wait` — if the child exited since the
    /// last poll, we update the supervisor state.
    pub fn is_running(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
            None => false,
        }
    }
}

impl Default for BridgeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}
