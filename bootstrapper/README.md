# AgentControl Windows bootstrapper (Phase 63)

A tiny, version-stable installer entry point — the Chrome `ChromeSetup.exe`
pattern. One URL always installs the latest tray:

```
https://install.agent-control.io/setup.exe
```

Users never have to find the right per-version `*-setup.exe` again. Post-install
upgrades stay with the in-app Tauri updater (Phase 27.7); the bootstrapper only
solves *first install*.

## How it works

```
setup.exe (this, ~106 KB)
   │  GET https://install.agent-control.io/latest.json
   │  parse windows.url + windows.sha256
   │  download the real signed installer → %TEMP%
   │  SHA256-verify
   ▼
agentcontrol-tray_<ver>_x64-setup.exe  /S   (real Tauri NSIS installer)
   │  POSTINSTALL hook launches tray + onboarding
   ▼  done
```

### Why PowerShell instead of NSIS plugins

The brief called for the INetC + Crypto plugins. The build host's stock NSIS
ships none of them, and the bundled `NSISdl` cannot do HTTPS. Rather than
vendor three Windows-only plugin DLLs (INetC + a SHA256 plugin + nsJSON), the
three plugin-shaped jobs — **TLS download, JSON parse, SHA256** — are delegated
to a hidden PowerShell worker (`fetch.ps1`). PowerShell ships on every Win10/11.

Result: **zero third-party NSIS plugins**, so `makensis` builds the EXE on any
Linux CI runner. NSIS still owns the dark UI and a real, live progress bar fed
from the worker. The worker talks back only through small files in `%TEMP%`
(`phase.txt`, `pct.txt`, `result.txt`, …) — see the header in `fetch.ps1`.

### Theme

Matches the tray palette: `#0e1116` background, `#818cf8` brand text,
`#4f46e5` progress accent. `XPStyle off` so the progress bar honours the custom
colors instead of the Aero theme.

Phase 63b makes the window **frameless** (Chrome-installer style): the native
caption — title bar, "AgentControl Setup" title text, and the top-left window
icon — is stripped via `SetWindowLong`, leaving only custom `—` / `✕` buttons
floating in the top-right and a drag-from-anywhere body. There is no live
`WndProc` subclass (NSIS System-plugin callbacks can't safely service
OS-dispatched window messages during `nsDialogs::Show`); instead a 30 ms
interaction timer polls the cursor + mouse-button state to drive hover, click,
and the drag (`ReleaseCapture` + `WM_NCLBUTTONDOWN`/`HTCAPTION`). Still zero
third-party plugins.

```
                                       ┌──────┬──────┐
                                       │  —   │  ✕   │  ← floating min + close
                                       └──────┴──────┘     (subtle hover)

                    [ app icon ]                          ← #0e1116, no caption

                   AgentControl                           ← #818cf8, 20pt bold

            Downloading AgentControl 0.5.0...             ← #94a3b8
            ████████████████░░░░░░░░░░░░                  ← #4f46e5 on #0e1116
                        62%

        (drag the body anywhere to move the window)
```

## Build

```bash
apt-get install -y nsis        # or: brew install makensis
./build.sh                     # → setup.exe
```

## latest.json schema

Served at `https://install.agent-control.io/latest.json`. See
`latest.json.example`. **This is NOT the Tauri-updater `latest.json`** (which
lives on the GitHub release and has a `platforms` map). Different consumer,
different schema; they coexist.

```json
{
  "version": "0.5.0",
  "released_at": "2026-06-29T23:12:23Z",
  "windows": {
    "url": "https://github.com/.../agentcontrol-tray_0.5.0_x64-setup.exe",
    "sha256": "<hex>",
    "signature": "<base64 minisign, optional/informational>"
  }
}
```

`sha256` is the security boundary the bootstrapper enforces. `signature` is the
Tauri minisign sig of the installer (informational; the bootstrapper does not
verify it — the SHA256 + HTTPS chain is the gate).

## Deploy

The release workflow (`.github/workflows/build-release.yml`, job
`bootstrapper`) builds `setup.exe`, generates `latest.json` from the freshly
released Windows asset, and scp's both to the install host:

```
/opt/static-sites/install/setup.exe
/opt/static-sites/install/latest.json
```

served by nginx at `install.agent-control.io` (alongside the existing
`wsl.sh` / `bridge.tar.gz` bridge-installer assets — the job adds files, never
clobbers them).

### Operator setup — required GitHub secret

| Secret | What |
| --- | --- |
| `INSTALL_HOST_SSH_KEY` | Private SSH deploy key. Its **public** half must be in `root@178.105.244.59:~/.ssh/authorized_keys`. Used to scp `setup.exe` + `latest.json` to `/opt/static-sites/install/`. |

The deploy step targets the public IP `178.105.244.59` (the `hetzner-supabase`
Tailscale alias is controller-local and not reachable from GitHub-hosted
runners) with `StrictHostKeyChecking=accept-new`.
