use super::shell::{env_upsert, run_in_wsl_capture, run_in_wsl_quiet};
use crate::config;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const BRIDGE_DIR: &str = "$HOME/agentcontrol-bridge";
const ADMIN_PAIR_URL: &str = "http://127.0.0.1:3001/admin/pair";

#[derive(Clone, serde::Serialize)]
pub struct PairTokens {
    pub refresh_token: String,
    pub bridge_id: String,
    pub org_id: String,
    pub lan_api_key: String,
}

#[tauri::command]
pub fn open_operator_portal(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(config::operator_portal_url(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Pure parser for the `agentcontrol-tray://pair?...` deep link the operator
/// portal opens after redeeming the claim. Returns `None` when the URL is not a
/// pair link or is missing one of the three required identity fields. Kept
/// side-effect-free so it can be unit-tested without a Tauri app handle.
pub fn parse_pair_url(url: &Url) -> Option<PairTokens> {
    if url.scheme() != "agentcontrol-tray" || url.host_str() != Some("pair") {
        return None;
    }
    let mut refresh_token = String::new();
    let mut bridge_id = String::new();
    let mut org_id = String::new();
    let mut lan_api_key = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "refresh_token" => refresh_token = value.into_owned(),
            "bridge_id" => bridge_id = value.into_owned(),
            "org_id" => org_id = value.into_owned(),
            "lan_api_key" => lan_api_key = value.into_owned(),
            _ => {}
        }
    }
    if refresh_token.is_empty() || bridge_id.is_empty() || org_id.is_empty() {
        return None;
    }
    Some(PairTokens {
        refresh_token,
        bridge_id,
        org_id,
        lan_api_key,
    })
}

/// Parse `agentcontrol-tray://pair?...` deep links and forward the
/// pairing tokens to the frontend via the `pair-tokens-received` event.
pub fn emit_pair_tokens(app: &AppHandle, url: &Url) {
    if let Some(tokens) = parse_pair_url(url) {
        let _ = app.emit("pair-tokens-received", tokens);
    }
}

/// Phase 65 — push the minted identity to the running bridge's
/// `POST /admin/pair`, which refreshes the token in-process (no restart) and
/// persists `lan_api_key` + `label` to its `.env`. The bridge authenticates
/// the call with the install-time `API_KEY` already in its `.env`, so we read
/// that out first. The JSON body is delivered through a single-quoted heredoc
/// so tokens containing shell metacharacters can't break out of the command.
/// `curl -w` appends the HTTP status so a non-2xx (e.g. binding mismatch) is
/// surfaced as an `Err` for the wizard's retry path.
#[tauri::command]
pub async fn push_pair_to_bridge(
    distro: String,
    refresh_token: String,
    bridge_id: String,
    org_id: String,
    lan_api_key: String,
    label: String,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "refresh_token": refresh_token,
        "bridge_id": bridge_id,
        "org_id": org_id,
        "lan_api_key": lan_api_key,
        "label": label,
    })
    .to_string();
    let script = format!(
        "cd {BRIDGE_DIR} && \
         KEY=$(grep -m1 '^API_KEY=' .env | cut -d= -f2-) && \
         cat > .acpair.json <<'ACPAIR_EOF'\n{payload}\nACPAIR_EOF\n\
         RESP=$(curl -sS -X POST {ADMIN_PAIR_URL} \
           -H \"Authorization: Bearer $KEY\" \
           -H 'content-type: application/json' \
           --data @.acpair.json -w '\\n__HTTP__%{{http_code}}'); \
         rm -f .acpair.json; \
         printf '%s' \"$RESP\""
    );
    let out = run_in_wsl_capture(&distro, &script).await?;
    let (body, code) = out
        .rsplit_once("__HTTP__")
        .ok_or_else(|| format!("bridge /admin/pair unreachable: {out}"))?;
    if code.trim().starts_with('2') {
        Ok(())
    } else {
        Err(format!(
            "bridge /admin/pair returned HTTP {} — {}",
            code.trim(),
            body.trim()
        ))
    }
}

/// Write the pairing credentials (returned from the portal after sign-in) into
/// the bridge `.env`. Does NOT restart — the wizard calls `restart_bridge_service`
/// separately so the two concerns stay independently retryable.
///
/// `lan_api_key` is the cloud-issued shared secret; the bridge reads it from the
/// `API_KEY` env var (overwriting the random one the install step generated).
#[tauri::command]
pub async fn write_pair_env(
    distro: String,
    refresh_token: String,
    bridge_id: String,
    org_id: String,
    lan_api_key: String,
) -> Result<(), String> {
    let write_env = format!(
        "cd {BRIDGE_DIR} && touch .env && {} && {} && {} && {}",
        env_upsert("BRIDGE_SMOKE_REFRESH_TOKEN", &refresh_token),
        env_upsert("BRIDGE_SMOKE_BRIDGE_ID", &bridge_id),
        env_upsert("BRIDGE_SMOKE_ORG_ID", &org_id),
        env_upsert("API_KEY", &lan_api_key),
    );
    let written = run_in_wsl_quiet(&distro, &write_env).await?;
    if written.exit_code != 0 {
        return Err(format!(
            "failed to write pairing env (exit {})",
            written.exit_code
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("valid test url")
    }

    #[test]
    fn parses_all_fields() {
        let tokens = parse_pair_url(&url(
            "agentcontrol-tray://pair?refresh_token=rt&bridge_id=bid&org_id=org&lan_api_key=key",
        ))
        .expect("should parse");
        assert_eq!(tokens.refresh_token, "rt");
        assert_eq!(tokens.bridge_id, "bid");
        assert_eq!(tokens.org_id, "org");
        assert_eq!(tokens.lan_api_key, "key");
    }

    #[test]
    fn url_decodes_query_values() {
        let tokens = parse_pair_url(&url(
            "agentcontrol-tray://pair?refresh_token=a%2Bb%2Fc&bridge_id=bid&org_id=org",
        ))
        .expect("should parse");
        assert_eq!(tokens.refresh_token, "a+b/c");
        assert!(tokens.lan_api_key.is_empty());
    }

    #[test]
    fn rejects_wrong_scheme_or_host() {
        assert!(parse_pair_url(&url("https://pair/?refresh_token=rt&bridge_id=b&org_id=o")).is_none());
        assert!(parse_pair_url(&url(
            "agentcontrol-tray://other?refresh_token=rt&bridge_id=b&org_id=o"
        ))
        .is_none());
    }

    #[test]
    fn rejects_missing_required_fields() {
        assert!(parse_pair_url(&url("agentcontrol-tray://pair?bridge_id=b&org_id=o")).is_none());
        assert!(parse_pair_url(&url("agentcontrol-tray://pair?refresh_token=rt&org_id=o")).is_none());
        assert!(parse_pair_url(&url("agentcontrol-tray://pair?refresh_token=rt&bridge_id=b")).is_none());
    }
}
