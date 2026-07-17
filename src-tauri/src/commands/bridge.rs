use super::shell::{run_in_wsl, run_in_wsl_args, CommandResult};
use crate::config;
use tauri::AppHandle;
use tokio::time::{sleep, Duration};

/// Local bridge `/pair` endpoint. Probed with a DIRECT-args curl (no `bash -c`)
/// so no shell quoting crosses the Windows → wsl.exe boundary; the JSON body is
/// parsed in Rust below.
const PAIR_URL: &str = "http://127.0.0.1:3001/pair";

// Bridge tarball is served from the `install.<host>` subdomain.
// The bridge repo is private, so GitHub's `archive/refs/heads/main.tar.gz`
// endpoint would 404 without an auth header — baking a token into the
// tray is a non-starter. The tarball lives on the host at
// `/srv/install/bridge.tar.gz` (gitignored in the supabase repo), refreshed
// out of band when the bridge ships a new version. URL host is configurable
// via the `HETZNER_HOST` build-time env (see `crate::config`).
const BRIDGE_DIR: &str = "$HOME/agentcontrol-bridge";

#[tauri::command]
pub async fn download_bridge(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    // The `install.<host>` subdomain serves a public Let's Encrypt cert, so
    // the curl verifies TLS normally — no `-k` needed.
    let cmd = format!(
        "mkdir -p {dir} && curl -fsSL {url} | tar -xz -C {dir} --strip-components=1",
        dir = BRIDGE_DIR,
        url = config::bridge_tarball_url(),
    );
    run_in_wsl(app, distro, cmd, event_id).await
}

#[tauri::command]
pub async fn npm_install_bridge(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = format!("cd {BRIDGE_DIR} && npm install --no-fund --no-audit");
    run_in_wsl(app, distro, cmd, event_id).await
}

/// Compile the bridge TypeScript; required before `npm start` runs `dist/index.js`.
#[tauri::command]
pub async fn npm_run_build_bridge(
    app: AppHandle,
    distro: String,
    event_id: String,
) -> Result<CommandResult, String> {
    let cmd = format!("cd {BRIDGE_DIR} && npm run build");
    run_in_wsl(app, distro, cmd, event_id).await
}

/// Query the bridge's `/pair` endpoint and return a one-word summary:
/// `"paired"`, `"unpaired"`, `"expired"`, or `"unreachable"`. Used by the
/// onboarding gate to skip the wizard when the bridge is already wired
/// up. Discovers the distro internally via `detect_ubuntu()` — the
/// onboarding flow doesn't persist its chosen distro, and falling back
/// to the seed value `"Ubuntu-22.04"` mis-targets users on
/// `Ubuntu` / `Ubuntu-24.04` / `Debian` / etc.
#[tauri::command]
pub async fn bridge_pair_state() -> Result<String, String> {
    let Some(distro) = super::ubuntu::detect_ubuntu() else {
        return Ok("unreachable".to_string());
    };
    // Direct-args curl: `wsl -d <distro> -- curl -fsS <url>` — the args go
    // straight to curl, so there is zero shell quoting for wsl.exe to mangle.
    // On connection-refused / non-2xx, `-fsS` yields empty stdout → parse fails
    // → "unreachable" (the desired "bridge not up yet" signal).
    let json = run_in_wsl_args(&distro, &["curl", "-fsS", PAIR_URL]).await?;
    Ok(parse_pair_state(&json).unwrap_or_else(|| "unreachable".to_string()))
}

/// Extract the `state` field ("paired" / "unpaired" / "expired" / …) from a
/// `/pair` JSON body. Returns `None` when the body is empty or unparseable.
fn parse_pair_state(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    Some(value.get("state")?.as_str()?.to_string())
}

/// Ask the running bridge for its current pairing claim code via the local
/// HTTP `/pair` endpoint.
///
/// Earlier revisions force-restarted the bridge here + grepped the
/// journal. That created a feedback loop with systemd `Restart=always`:
/// each bridge boot fires one `bridge-claim` call, the rate limiter on
/// the Supabase edge function caps that machine at ~5/min, and any
/// extra restart (from this function, from the user reopening the
/// onboarding wizard, or from a downstream startup failure) hits the
/// limit → 429 → no new claim code → tray polls forever, restarts
/// again, repeat.
///
/// Instead: the bridge already exposes `GET /pair` (the legacy LAN
/// pairing UI's data source). It returns the active claim code if the
/// bridge is unpaired, plus expiry. Poll that — no restart, no
/// journal grep, no rate-limit cascade.
#[tauri::command]
pub async fn wait_for_claim_code(distro: String) -> Result<String, String> {
    for _ in 0..30 {
        // Direct-args curl (see `bridge_pair_state`); parse the claim code in Rust.
        let json = run_in_wsl_args(&distro, &["curl", "-fsS", PAIR_URL]).await?;
        if let Some(code) = parse_claim_code(&json) {
            return Ok(code);
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err("bridge did not expose a claim code on /pair within 30s".to_string())
}

/// Extract a well-formed `AAAA-BBBB` claim code from a `/pair` JSON body's
/// `code` field. Returns `None` when the body is unparseable, the field is
/// missing/null (bridge already paired), or the value isn't the expected shape.
fn parse_claim_code(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let code = value.get("code")?.as_str()?;
    is_claim_code(code).then(|| code.to_string())
}

/// A claim code is exactly `XXXX-XXXX` with uppercase-alphanumeric groups.
fn is_claim_code(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 9
        && bytes.iter().enumerate().all(|(i, &c)| {
            if i == 4 {
                c == b'-'
            } else {
                c.is_ascii_uppercase() || c.is_ascii_digit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_state_from_paired_body() {
        let json = r#"{"state":"paired","bridgeId":"b-1","orgId":"o-1"}"#;
        assert_eq!(parse_pair_state(json).as_deref(), Some("paired"));
    }

    #[test]
    fn parses_state_from_unpaired_body() {
        let json = r#"{"state":"unpaired","code":"AB12-CD34","expiresAt":123}"#;
        assert_eq!(parse_pair_state(json).as_deref(), Some("unpaired"));
    }

    #[test]
    fn pair_state_none_on_empty_or_garbage() {
        assert_eq!(parse_pair_state(""), None);
        assert_eq!(parse_pair_state("not json"), None);
        assert_eq!(parse_pair_state(r#"{"other":1}"#), None);
    }

    #[test]
    fn parses_claim_code_from_unpaired_body() {
        let json = r#"{"state":"unpaired","code":"AB12-CD34","expiresAt":123}"#;
        assert_eq!(parse_claim_code(json).as_deref(), Some("AB12-CD34"));
    }

    #[test]
    fn claim_code_none_when_paired_has_no_code() {
        let json = r#"{"state":"paired","bridgeId":"b-1","orgId":"o-1"}"#;
        assert_eq!(parse_claim_code(json), None);
    }

    #[test]
    fn claim_code_rejects_malformed_values() {
        assert_eq!(parse_claim_code(r#"{"code":"ab12-cd34"}"#), None, "lowercase");
        assert_eq!(parse_claim_code(r#"{"code":"AB12CD34"}"#), None, "no dash");
        assert_eq!(parse_claim_code(r#"{"code":"AB1-CD34"}"#), None, "wrong length");
        assert_eq!(parse_claim_code(r#"{"code":null}"#), None, "null code");
        assert_eq!(parse_claim_code(""), None, "empty body");
    }
}
