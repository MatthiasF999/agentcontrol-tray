# Phase 27.0 — Tauri spike (initial scaffold)

**Date**: 2026-05-30
**Goal**: Verify Tauri 2 cross-platform viability for the AgentControl
Bridge tray app on Linux, macOS, Windows. Scaffold + initial commit.
**Hard-commit-scope**: if Tauri 2 tray API blocked on our target
platforms → flag as Layer N, fall back to Electron in 27.1 blueprint.

## Stack chosen

| Component | Choice | Rationale |
|---|---|---|
| Shell | Tauri 2.x (latest stable) | ~3 MB binary, no embedded Chromium, OS-native webview, built-in tray + notifications + auto-updater |
| Frontend | React 19 + TypeScript 5.8 + Vite 7 | Aligned with `agentcontrol-app` (familiar surface for cross-repo work) |
| Pkg manager | pnpm | Aligned with rest of project |
| Rust toolchain | stable (rustup) | rustup user-space install — no sudo needed for the toolchain |

## Spike findings

### ✅ Works

1. `npm create tauri-app@latest` scaffold generates clean Tauri 2 +
   React + TS project on first try.
2. `pnpm install` resolves cleanly (Tauri 2.11 CLI + React 19 + TS 5.8 +
   Vite 7 — no resolution conflicts).
3. Rust 1.96 stable installs via rustup user-space; no sudo required for
   the toolchain itself.
4. Tray icon code uses Tauri 2's first-party `tauri::tray::TrayIconBuilder`
   API (no external plugin needed). `Cargo.toml` declares
   `tauri = { features = ["tray-icon"] }` to enable.

### ⚠️ Operator-action required — Linux system-deps (Layer 1)

Tauri's webkit-based webview requires GTK + WebKitGTK + supporting
system libraries that must be installed via the system package manager
with sudo. On Ubuntu 24.04 (our WSL2 baseline):

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libdbus-1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  build-essential \
  curl wget file pkg-config
```

This is the **only** sudo touchpoint for Phase 27.0. Without it
`cargo check` fails at the first sys-crate (`libdbus-sys` panics with
"Package 'dbus-1' not found"). The Tauri 2.x prerequisite docs at
https://tauri.app/start/prerequisites/ list the same packages.

For other distros:

| Distro | Command |
|---|---|
| Fedora 40+ | `sudo dnf install webkit2gtk4.1-devel dbus-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel curl wget file` |
| Arch | `sudo pacman -S --needed webkit2gtk-4.1 dbus libappindicator-gtk3 librsvg base-devel curl wget file` |
| Debian 12+ | same as Ubuntu 24.04 |

### ❌ Cannot verify in this iter

| Platform | Reason | Resolved how |
|---|---|---|
| macOS `.app` build | Mac host required for codegen | 27.0 follow-up — operator runs `pnpm tauri build` on Mac to verify |
| Windows `.exe` native | Win host required for Microsoft C++ Build Tools | 27.0 follow-up — operator on Win11 or `cargo xwin` cross-build attempt in 27.1 |
| Tray on Wayland | WSL2 has WSLg + Wayland but apt-deps gate ran first | Verify after operator runs apt install above |

## Files added in this scaffold

```
agentcontrol-tray/
├── CLAUDE.md                          NEW — repo conventions for Claude
├── README.md                          REWRITE — replaced default scaffold copy
├── docs/PHASE-27-0-SPIKE.md           NEW — this file
├── index.html                         EDIT — title "AgentControl"
├── src/App.tsx                        REWRITE — status-LED + placeholder shell
├── src/App.css                        REWRITE — Inter-stack, dark-mode aware
├── src-tauri/Cargo.toml               EDIT — description + tray-icon feature
├── src-tauri/src/lib.rs               REWRITE — TrayIconBuilder + window.hide on close
└── src-tauri/tauri.conf.json          EDIT — window hidden-by-default, min size
```

Default scaffold artefacts (react.svg, tauri.svg, vite.svg, default
"Welcome to Tauri + React" content) removed.

## Layer ledger

| # | Diagnose | Fix | Status |
|---|---|---|---|
| 0 | Rust toolchain absent | rustup user-space install | ✅ closed |
| 1 | Linux Tauri system-deps absent (sudo required) | apt install command above | 🔵 operator-action |

## Next iter (27.1) preconditions

1. Operator runs the apt-install command above (or distro equivalent).
2. `cargo check` from `src-tauri/` succeeds.
3. `pnpm tauri dev` launches a window + tray icon on Linux WSLg.

Once those preconditions land, 27.1 scaffolds the Login UI (Supabase
Magic-link via custom URL scheme + per-OS secure storage).

## Hard-commit-scope honored

This spike commits **scaffold + config + initial Rust tray code** only.
No dev-build, no end-to-end smoke. If the Linux apt-install reveals
Tauri 2 doesn't tray-on-Wayland (known issue tracker #11187, #11543),
the iter pivots to:

- (a) X11-fallback documentation as operator-action, OR
- (b) Hard-pivot to Electron for 27.1 blueprint (would need ADR commit)

Either path is honest-rot — the spike's job is to **find out**, not to
guarantee a green build.
