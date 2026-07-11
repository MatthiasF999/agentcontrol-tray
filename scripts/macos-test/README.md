# macOS Test Harness

Automated end-to-end smoke of the **bridge** (native launchd path) and the
**tray `.app`** on a real macOS host, run as a GitHub Actions workflow.

macOS cannot be virtualised off a Darwin host (Apple SLA + kernel), so there
is **no local iteration outside a real Mac** — `act` cannot emulate a
`macos-15` runner. The only automation path is GitHub's hosted `macos-15`
runner (Apple Silicon, ephemeral, always fresh).

## Trigger

```bash
gh workflow run macos-test.yml            # manual
gh run watch                              # follow the run
```

or via the GitHub UI (**Actions → macOS Test Harness → Run workflow**). It
also auto-smokes on:

- push to `main` touching `src-tauri/**`, `scripts/macos-test/**`, or the
  workflow file
- PRs touching those same paths

## Jobs

| Job      | Runner     | What it does                                              |
| -------- | ---------- | -------------------------------------------------------- |
| `bridge` | `macos-15` | installs the bridge via `install-mac.sh`, loads the launchd LaunchAgent, health-probes `localhost:3001`, checks `api.<host>` reachability |
| `tray`   | `macos-15` | builds the `.app` (`pnpm tauri build --target aarch64-apple-darwin --bundles app`), launches it, drives native chrome via AppleScript, screenshots |

Both upload `output/` (result.json + logs + screenshots) as an artifact,
**always** (`if: always()`) — download from the run's **Summary → Artifacts**.

## Files

- `helpers.sh` — shared primitives: `Save-Screenshot`, `Run-AppleScript`,
  `Wait-Window`, `Wait-Http`, `Write-Result` (jq-based). Sourced, not run.
- `install-mac.sh` — **half-shipped** macOS bridge installer (see below).
- `bridge-runner.sh` — bridge job body.
- `tray-runner.sh` — tray job body.

## `install-mac.sh` is half-shipped

The production install host serves only `wsl.sh` + `bridge.tar.gz` (the
Windows/Linux/WSL path). **There is no `install.agent-control.io/mac.sh`
yet.** `install-mac.sh` vendors the native-macOS equivalent in-repo:
download tarball → `npm install && npm run build` → write `.env`
(`PORT=3001` + API key) → `~/Library/LaunchAgents/io.agentcontrol.bridge.plist`
→ `launchctl bootstrap`.

**Follow-up (separate PR):** promote it to
`install.agent-control.io/mac.sh` so
`curl -fsSL https://install.agent-control.io/mac.sh | bash` works like
`wsl.sh` does today.

## Known limitations

- **First runs land `degraded`, not `pass`.** `install.<host>/bridge.tar.gz`
  is gated; until it is reachable from the runner the bridge install step
  fails and the job records `degraded` (it still exits 0 so the smoke stays
  green — read `result.json`). Set `STRICT=1` to hard-fail instead.
- **Webview UI is not deep-driven.** The tray UI is a Tauri WKWebView; its
  buttons are DOM nodes invisible to the macOS Accessibility API, so
  AppleScript drives only native chrome (window, menu-bar extra).
  Screenshots are the visual check. Deep UI driving would need a webdriver
  (`tauri-driver` / WKWebView remote inspector) — future work.
- **`screencapture` may be blank** on a headless runner; the frame is still
  uploaded for post-mortem.
- **No local iteration** except on a real macOS host (see top).

## `result.json`

Each runner writes `output/result.json` with a top-level `status`
(`pass` / `degraded` / `fail`), a timestamp, and per-check booleans
(`install_ok`, `launchctl_ok`, `health_ok`, … for bridge;
`found_ok`, `launch_ok`, `window_ok`, … for tray).
