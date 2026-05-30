# agentcontrol-tray

Desktop tray app for the AgentControl Bridge daemon — analog to Tailscale's
desktop tray for the WireGuard daemon. Runs on the same machine as the
Bridge, exposing a system-tray icon, login + pairing UI, settings, and
status notifications. Cross-platform via Tauri 2.

## Status

**Phase 27.0** — initial Tauri spike. Builds + boots a tray + main window
shell on Linux WSL2. No real features yet — those land in 27.1–27.8.

See `docs/PHASE-27-0-SPIKE.md` for spike findings + the Linux system-deps
operator-action.

## Architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│  agentcontrol-tray   │         │   agentcontrol-app   │
│  (this repo)         │         │   (mobile + web)     │
│                      │         │                      │
│  • Tray icon         │         │  • End-user UI       │
│  • Login + pairing   │         │  • Tasks, notes, …   │
│  • Settings UI       │         │                      │
│  • Bridge ctl        │         │                      │
└──────────┬───────────┘         └──────────┬───────────┘
           │ HTTP localhost                  │ HTTPS
           │ Docker socket                   │ Realtime
           ▼                                 ▼
┌──────────────────────┐         ┌──────────────────────┐
│   Bridge daemon      │◄────────│   Self-hosted        │
│   (Node.js container)│         │   Supabase           │
│                      │         │   (Postgres+Realtime)│
└──────────────────────┘         └──────────────────────┘
```

The tray app talks to **two** systems:

1. **Local Bridge HTTP API** on `localhost:3001` (status, approve, config)
2. **Docker engine socket** (`/var/run/docker.sock` / npipe) to start/stop
   the Bridge container

It also queries Supabase directly via `@supabase/supabase-js` for the
recent-tasks list + multi-bridge view, using the logged-in user's JWT.

## Development

### Prerequisites

* **Linux**: `libwebkit2gtk-4.1-dev`, `libdbus-1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`,
  `pkg-config`. See `docs/PHASE-27-0-SPIKE.md` for the exact apt command.
* **macOS**: Xcode Command Line Tools.
* **Windows**: Microsoft C++ Build Tools + WebView2 (Win10 1803+ ships it).
* **All**: Rust stable (`rustup`) + Node 20+ + pnpm.

### Run

```bash
pnpm install
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

Produces unsigned local binaries:

* Linux: `src-tauri/target/release/agentcontrol-tray` + AppImage + .deb
* macOS: `.app` + `.dmg` (Mac host required)
* Windows: `.exe` + `.msi` (Windows host or cross-build via `cargo xwin`)

## Constraint

Per the AgentControl project rule, this app does **not** require an Apple
Developer Account or Google Play account. Distribution is via direct
download of unsigned builds + self-hosted auto-update (no app stores).
Users accept the OS "unidentified developer" warning on first launch.

## License

Same as the rest of AgentControl (see top-level repo).
