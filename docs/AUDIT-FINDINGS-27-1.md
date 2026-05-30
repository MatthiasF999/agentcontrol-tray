# Phase 27.1 audit findings

Two foreground Explore-agents (no team_name, after agent-teams launcher
bug surfaced) produced these inputs to the 27.1 blueprint.

## Bridge HTTP API gap-list

(Source: `bridge-api-auditor` Explore subagent, 2026-05-31)

| # | Capability | Status | Existing route | Gap / additive proposal |
|---|---|---|---|---|
| 1 | Health check | ✅ exists | `GET /health` → `{ok, version}` (public, no auth) | none |
| 2 | Autonomous status | ❌ missing | — | ADD `GET /autonomous/status` → `{running_count, claimed_ids, task_ids_pending_approval}` |
| 3 | Pair accept-code | ❌ missing | `GET /pair`, `POST /pair/complete` (app↔bridge handoff) | ADD `POST /pair/accept` — tray POSTs `{pair_code, supabase_url, refresh_token}`; bridge persists token via the existing `bridge-refresh` RPC, replacing env-injection in `scripts/smoke-pairing.ts` |
| 4 | Task approval | ❌ missing | — | ADD `POST /autonomous/approve/{taskId}` → flips `autonomous_tasks.status` from `awaiting_approval` → `executing` |
| 5 | Config get/set | ❌ missing | `loadConfig()` internal-only | ADD `GET /config` + `PUT /config` (subset: `autonomous.enabled`, `autonomous.maxConcurrent`, `autonomous.defaultSandbox`, log-level) |
| 6 | Pair status | ✅ exists (partial) | `GET /pair` → `BridgePairingStatus` `{state, bridgeId?, orgId?}` | sufficient |

**Surface size estimate**: 4 net-new routes / 5 methods for 27.2-27.6.

**Auth pattern**: Bridge uses static `API_KEY` bearer for legacy LAN
routes; cloud-mode routes add `X-User-JWT` after the API_KEY gate.
Tray will reuse the API_KEY pattern (the app already does this).

## Tauri 2 plugin inventory

(Source: `tauri-plugin-researcher` Explore subagent, 2026-05-31)

| # | Need | npm package | Cargo crate | One-liner |
|---|---|---|---|---|
| 1 | Secure storage | `@tauri-apps/plugin-stronghold` | `tauri-plugin-stronghold` | IOTA Stronghold engine; argon2-hashed encrypted vaults |
| 2 | HTTP client | `@tauri-apps/plugin-http` | `tauri-plugin-http` | Native Rust HTTP; CORS-free for localhost |
| 3 | Notifications | `@tauri-apps/plugin-notification` | `tauri-plugin-notification` | Native OS notify with click handlers |
| 4 | Auto-updater | `@tauri-apps/plugin-updater` | `tauri-plugin-updater` | Pull-based; signed-update support; GitHub releases or self-hosted |
| 5 | Store / KV | `@tauri-apps/plugin-store` | `tauri-plugin-store` | Per-OS app-data persistence |
| 6 | Single-instance | (Rust-only) | `tauri-plugin-single-instance` | Prevents second launch; focuses existing window |
| 7 | Deep-link | `@tauri-apps/plugin-deep-link` | `tauri-plugin-deep-link` | Registers `agentcontrol-tray://auth-callback` URI scheme |
| 8 | Shell open | (already have) | `tauri-plugin-opener@2` | already in Cargo.toml |

**Tauri 2 Wayland tray status (as of 2026-05-31)**: Tray icons fail
on Wayland per issue #14234 (open since Oct 2025) — AppImage works,
.deb doesn't; X11 unaffected. KDE/GNOME shell integration bugs
(#4647) marked not-planned 2022.

**Install order recommendation**: stronghold + http + notification +
store land in 27.1 (auth + settings backbone); single-instance +
deep-link land in 27.2 (window-mgmt + magic-link flow stable); shell
already shipped. Updater (27.7) last.

## Layer 2 — Wayland tray

The Wayland-tray bug surfaced by the plugin researcher is a real
concern for our primary Linux dev environment (WSLg = XWayland under
the hood). Probe with `pnpm tauri dev` will show:

- ✅ If tray surfaces on WSLg → Layer 2 informational, document distro
  matrix in PHASE-27-0-SPIKE.md
- ❌ If tray missing on WSLg → Layer 2 promoted to operator-action
  (recommend X11 distros for self-host until Tauri/upstream-Wayland
  issues land); document in PHASE-27-0-SPIKE.md hard-commit-scope
- ⚠️ If tray flaky → Layer 2 documented + per-distro test matrix
