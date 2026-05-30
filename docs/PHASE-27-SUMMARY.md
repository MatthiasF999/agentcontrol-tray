# Phase 27 — AgentControl Bridge Tray App

**Status**: Complete to honest end-of-autonomous-reach. 10 commits, 1962 LOC
TS + Rust + CSS, 8 iter shipped across one focused session. Runtime
verification on each target OS is operator-action.

**Scope**: Desktop tray app on the AgentControl Bridge daemon's host —
analog to Tailscale's daemon-host tray for the WireGuard daemon. Tauri 2
shell + React/TS in webview. Pairing UI replaces operator-only
env-injection. Login via Supabase Magic-link with deep-link auth callback.

## Cumulative commit ledger

| # | Commit | Subject |
|---|---|---|
| 1 | `453e58b` | [phase-27.0] initial Tauri 2 scaffold + tray spike |
| 2 | `6054a87` | [phase-27.0] close-out: cargo check ✅ + audit findings for 27.1 |
| 3 | `3e42d17` | [phase-27.1] Login UI scaffold — Supabase config + magic-link + deep-link auth callback |
| 4 | `7501468` | [phase-27.2] Bridge-pairing UI + cross-repo spec for /pair/accept |
| 5 | `579c141` | [phase-27.3] dynamic tray status + Bridge HTTP polling pipeline |
| 6 | `c1cf5ea` | [phase-27.3.1] include_image! path fix — drop the ../ prefix |
| 7 | `807c075` | [phase-27.4] Settings UI — Account + App + Bridge sections |
| 8 | `91f6677` | [phase-27.5] Recent tasks list + native approval notifications |
| 9 | `f4241ec` | [phase-27.6] Container control — Docker compose start/stop/restart via tray |
| 10 | `f1fa3ae` | [phase-27.7] Auto-update + multi-bridge UI |

## Layer ledger

| # | Diagnose | Resolution | Status |
|---|---|---|---|
| 0 | Rust toolchain absent | `rustup` user-space install (no sudo) | ✅ closed @ 27.0 |
| 1 | Linux Tauri sys-deps absent (`webkit2gtk-4.1`, `dbus-1`, `appindicator3`, `rsvg2`, `build-essential`) | Operator-action via `scripts/install-linux-deps.sh` (one sudo `apt install`) | ✅ closed @ 27.0 close-out |
| 2 | Wayland tray (Tauri #14234) — `.deb` tray fails on Wayland; AppImage works; X11 unaffected | Documented + AppImage-first packaging recommended for Linux distribution | 📋 informational @ 27.7 (verify in 27.7 runtime smoke) |
| 3 | `Image::from_bytes` doesn't exist in Tauri 2.11.2 | Use `tauri::include_image!` macro (PNG decode at compile time) | ✅ closed @ 27.3 |
| 4 | `include_image!` path resolution mis-rooted (`../icons/...` resolved to project root, not src-tauri) | Drop `../` — manifest-dir is the macro's base | ✅ closed @ 27.3.1 |
| 5 | `argon2` 0.5 API (`hash_raw`, `Config`, `Variant::Argon2id`) doesn't exist — it's the rust-argon2 v3 surface, not the RustCrypto rewrite at v0.5 | Stronghold deferred to 27.7 polish; 27.1 uses `tauri-plugin-store` for session persistence | 📋 deferred @ 27.1 |
| 6 | Agent-teams launcher tries to exec `claude` at `/.local/share/claude/versions/2.1.150` which doesn't exist (current is 2.1.157) | Operator-action: `ln -sf 2.1.157 /.local/share/claude/versions/2.1.150` (one-time fix for any version-skew gap) | ✅ closed mid-session |
| 7 | Background-spawned teammates registered in team-config but never fire their first turn (inbox messages stay `read=false`) | Pivoted to foreground Agent calls (no `team_name`) for the two audit teammates; reports came back inline | 📋 documented @ 27.0 close-out commit |

## Cross-repo follow-ups (consolidated)

These are tray-side spec'd + UI-ready; backend implementation lives in
sibling repos and is not part of Phase 27's deliverable.

### `agentcontrol-bridge` additions

(All routes mounted **before** the API_KEY middleware unless noted.)

| Route | Method | Purpose | Phase doc |
|---|---|---|---|
| `/pair/accept` | POST | Tray-initiated pairing — `{bridge_id, refresh_token, supabase_url}` → persist token via existing `writeToken()` | `docs/PHASE-27-2-CROSS-REPO.md` Delta A |
| `/autonomous/status` | GET | `{running_count, claimed_ids, task_ids_pending_approval}` for tray-icon status | `docs/AUDIT-FINDINGS-27-1.md` |
| `/autonomous/approve/{taskId}` | POST | Flips `autonomous_tasks.status` `awaiting_approval` → `executing` | `docs/AUDIT-FINDINGS-27-1.md` |
| `/config` | GET + PUT | Bridge runtime config subset (auto-approve, sandbox-mode, max-concurrent, log-level) | `docs/AUDIT-FINDINGS-27-1.md` |

Each route requires a TDD test sibling per bridge `CLAUDE.md`.

### `supabase` additions

| RPC / migration | Purpose | Phase doc |
|---|---|---|
| `bridge_mint_token(p_org_id, p_bridge_name)` SECURITY DEFINER RPC | Optional "quick-pair" UI — admin caller mints bridge + refresh-token in one round-trip | `docs/PHASE-27-2-CROSS-REPO.md` Delta B |

Operator-paste pairing UI (27.2) works against Delta A alone using
existing operator-side token-mint. Delta B is the UI-polish add-on.

### `agentcontrol-tray` operator-actions

| Action | Trigger |
|---|---|
| Linux apt-install of Tauri sys-deps | `bash scripts/install-linux-deps.sh` |
| Tauri signer keypair generation + pubkey paste into `tauri.conf.json` | Before first `pnpm tauri build` (build fails loud on the placeholder) |
| macOS `.app` build | Requires Mac host (cross-build from Linux not supported) |
| Windows `.exe` build | Native (Win + MS C++ Build Tools) or cross-build via `cargo xwin` |

## Architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│  agentcontrol-tray   │         │   agentcontrol-app   │
│  (this repo)         │         │   (mobile + web)     │
│                      │         │                      │
│  Tray status LED ←───────────┐ │  End-user UI         │
│  Login + pairing UI          │ │                      │
│  Settings UI                 │ │                      │
│  Bridge container ctl        │ │                      │
│  Recent tasks + approve      │ │                      │
│  Auto-update (Tauri)         │ │                      │
└──────┬───────┬──────┘         │ └──────┬───────────────┘
       │       │ Docker socket  │        │ HTTPS
       │       └────────────────────┐    │ Realtime
       │ HTTP localhost:3001        │    │
       ▼                            ▼    ▼
┌──────────────────────┐       ┌──────────────────────┐
│   Bridge daemon      │◄──────│   Self-hosted        │
│   (Node.js container)│       │   Supabase           │
│                      │       │   (Postgres+Realtime)│
└──────────────────────┘       └──────────────────────┘
```

- **Tray → local Bridge**: Tauri native HTTP plugin (CORS-free).
  6 routes consumed: `/health`, `/pair`, `/pair/accept` (pending),
  `/autonomous/status` (pending), `/autonomous/approve/{taskId}` (pending),
  `/config` GET/PUT (pending).
- **Tray → Supabase**: `@supabase/supabase-js` with Realtime channels.
  Uses tray-stored Supabase URL + anon key. Magic-link auth via
  `agentcontrol-tray://auth-callback` URI scheme handled by
  `tauri-plugin-deep-link`.
- **Tray → Docker engine**: shell-out via `docker compose` (allowlisted
  verbs: up, down, restart, ps, logs, config). Cross-platform via the
  docker CLI (Unix socket vs npipe handled by CLI).

## File map

```
agentcontrol-tray/
├── docs/
│   ├── PHASE-27-0-SPIKE.md             27.0 Tauri scaffold + Layer 1 apt-install gate
│   ├── PHASE-27-2-CROSS-REPO.md        27.2 Bridge Delta A + Supabase Delta B specs
│   ├── PHASE-27-7-AUTOUPDATE.md        27.7 signer keypair + per-release flow
│   ├── AUDIT-FINDINGS-27-1.md          Audit reports + Bridge gap-list
│   └── PHASE-27-SUMMARY.md             (this file)
├── scripts/
│   └── install-linux-deps.sh           Idempotent apt-install for Tauri Linux deps
├── src/                                React + TS frontend
│   ├── App.tsx                         Status-machine router (loading/config/login/signed-in/settings)
│   ├── App.css                         Design tokens, dark-mode-aware
│   ├── auth/
│   │   ├── AuthContext.tsx             Supabase session + status machine
│   │   ├── ConfigScreen.tsx            First-run Supabase URL + anon key
│   │   ├── LoginScreen.tsx             Magic-link form
│   │   └── deepLinkHandler.ts          agentcontrol-tray://auth-callback parser
│   ├── bridge/
│   │   ├── bridgeClient.ts             Typed HTTP wrapper for localhost:3001
│   │   ├── BridgeClientContext.tsx     Singleton provider
│   │   ├── usePairingStatus.ts         4s polling on GET /pair
│   │   ├── useTraySync.ts              Mirrors pair-state into Rust tray icon + tooltip
│   │   ├── useRecentTasks.ts           supabase-js select + Realtime subscription
│   │   └── useBridgesList.ts           supabase-js select on bridges (RLS-gated)
│   ├── lib/
│   │   ├── storage.ts                  tauri-plugin-store adapters (settings + Supabase session)
│   │   ├── supabase.ts                 Singleton client factory
│   │   ├── appSettings.ts              Settings hook + AppSettings type
│   │   ├── notifier.ts                 tauri-plugin-notification wrapper
│   │   ├── docker.ts                   Tauri command wrappers (checkDocker + composeRun)
│   │   └── updater.ts                  tauri-plugin-updater wrapper
│   └── screens/
│       ├── HomeScreen.tsx              Status + Account + RecentTasks + ContainerControl
│       ├── PairScreen.tsx              Manual pair form (paste bridge_id + refresh-token)
│       ├── SettingsScreen.tsx          Account + App + Bridge + Bridges-list + Updater
│       ├── RecentTasksCard.tsx         Top-5 list with status badges + Approve button
│       ├── ContainerControlCard.tsx    Start/Restart/Stop docker compose
│       ├── BridgesListCard.tsx         All-bridges from supabase + "this machine" badge
│       └── UpdaterCard.tsx             Check + Install + relaunch
└── src-tauri/                          Rust shell
    ├── src/
    │   ├── lib.rs                      Tray + window + 8 plugin inits + invoke_handler
    │   ├── main.rs                     Entry
    │   └── docker.rs                   docker_available + docker_compose Tauri commands
    ├── icons/
    │   ├── status-{green,yellow,red}-{16,32}.png   Dynamic tray status PNGs
    │   └── ...                         Default Tauri bundle icons
    ├── capabilities/default.json       Permissions (window, opener, notification, store, deep-link, http, updater, process)
    ├── tauri.conf.json                 Bundle + plugins config (deep-link scheme + updater endpoint)
    └── Cargo.toml                      8 Tauri plugins + tauri 2 with tray-icon feature
```

## New patterns surfaced (Phase 27)

These are candidates for the `agentcontrol-bridge` / `supabase` Pattern
catalog (`supabase/docs/AGENT-METHODOLOGY.md`) update — Phase 27 is the
first iter to apply them across an entire codebase scaffolding from zero.

### Pattern: Thin-shell tray over daemon-API

A desktop tray app's value is **not** in re-implementing the daemon's
logic — it's in giving the daemon a discoverable UI. Architectural
rule: the tray talks **only** to (a) the local daemon's HTTP API and
(b) the cloud control plane the daemon also talks to. Never re-derive
state the daemon already owns.

Applied: BridgeClient is read-mostly; the one mutator (`acceptPairing`)
delegates persistence entirely to the bridge. The tray has zero
knowledge of bridge-token.json's schema or location.

### Pattern: Operator-action placeholders that fail loud

Config values requiring out-of-band action (signing keys, secrets,
production URLs) ship as **placeholders that crash the build**, not
empty strings that work-but-misbehave. The placeholder string is
descriptive enough to grep + the failure message points to the action.

Applied: `"REPLACE_WITH_TAURI_SIGNER_PUBKEY_PHASE_27_7_OPERATOR_ACTION"`
in `tauri.conf.json`. Any `pnpm tauri build` fails with the placeholder
visible, telling operator exactly what doc to read.

### Pattern: Cross-repo spec as deliverable with client-side error pointer

When tray-side ships ahead of the backend route it consumes, two
discipline lines hold the gap honest:

1. A doc (`docs/PHASE-27-2-CROSS-REPO.md`) specifies the additive route
   contract, status codes, test cases — granular enough that the
   sibling repo's TDD-driven workflow can pick it up directly.
2. The client code **detects the 404** and surfaces a precise pointer
   to that doc, not a generic "something went wrong".

This means: shipped tray code documents its own backend gaps at the
exact UI surface where they'll bite. Self-documenting honest-rot.

Applied: PairScreen, RecentTasksCard, SettingsScreen all have this
shape. The 404 → cross-repo-doc-pointer is a 4-line check that any
future iter can copy.

### Pattern: Foreground Agent fallback when agent-teams launcher breaks

The Claude Code agent-teams system is research-preview with a known
limitation: launcher binary path can drift across `claude` versions,
leaving teammates registered-but-never-firing. Two-line workaround:

1. Symlink the missing version to the current one in
   `~/.local/share/claude/versions/`.
2. For one-shot audit tasks, prefer foreground `Agent()` calls
   without `team_name` — they execute synchronously and return
   reports inline.

Reserve team-spawning for tasks where teammates genuinely need to
message each other; for read-only research + audit, foreground is more
reliable today.

## Verification

| Layer | Status | Method |
|---|---|---|
| `pnpm tsc --noEmit` | ✅ clean across all 8 iter | Per-iter check before commit (with one 27.4 fix for unused import) |
| `cargo check` (src-tauri) | ✅ clean across all 8 iter | Per-iter check before commit |
| `pnpm tauri dev` end-to-end runtime | ⏸ partial — 27.0 probe reached 480/493 crates compile (timeout-killed) | Operator-action: run full `pnpm tauri dev` on Linux WSLg to verify tray surfaces, Wayland tray Layer 2 |
| `pnpm tauri build` (Linux AppImage + .deb) | ⏸ untested | Operator-action: needs Tauri signer pubkey first |
| `pnpm tauri build` (macOS .app) | ⏸ untested | Operator-action: Mac host required |
| `pnpm tauri build` (Windows .exe) | ⏸ untested | Operator-action: Win host or cross-build |
| Login flow end-to-end | ⏸ untested | Operator-action: needs real Supabase + Magic-link delivery |
| Pairing flow end-to-end | ⏸ untested | Operator-action: needs Bridge Delta A first |
| Recent tasks live update | ⏸ untested | Operator-action: needs paired bridge + autonomous task |

Honest-rot: **scaffold + UI flow + spec is complete; real-runtime
verification across 3 OSes + cross-repo backend deltas is operator-action**.

## Per-iter LOC (rough)

| Iter | Net LOC | Files |
|---|---|---|
| 27.0 | +200 (scaffold) + ~50 docs | 9 source + 2 docs + scripts |
| 27.1 | +500 source + 80 css | 6 source files |
| 27.2 | +200 source + 100 doc | 4 source + 1 cross-repo doc |
| 27.3 | +120 source + 35 Rust | 2 source + lib.rs |
| 27.4 | +250 source | 3 source files |
| 27.5 | +210 source + 50 css | 3 source files |
| 27.6 | +180 source + 80 Rust | 3 source + 1 Rust module |
| 27.7 | +250 source + 100 doc | 4 source + 1 doc |
| 27.8 | (this file) | 1 doc |

Total: 1962 LOC across src/ + src-tauri/src/, plus 5 docs.

## Next-iter candidates

- **27.2 follow-up — quick-pair UI**: Once Bridge Delta A + Supabase
  Delta B land, add ~30 lines to PairScreen for the one-click flow
- **27.3 follow-up — bridge `/autonomous/status` consumption**: useAutonomousStatus hook + status sub-line on HomeScreen
- **27.4 follow-up — bridge `/config` consumption**: real Bridge config
  form once Delta C lands
- **27.7 follow-up — stronghold migration**: replace `tauri-plugin-store` session persistence with encrypted vault once per-OS key-derivation strategy decided (machine-id + per-install salt + argon2 0.5 modern API)
- **27.7 follow-up — multi-channel updater**: wire `updateChannel` setting to a `{channel}` placeholder in `tauri.conf.json` updater endpoints (needs release-infrastructure precondition: ship `latest-stable.json` + `latest-beta.json`)
- **27.x — Login UI for joining new orgs**: ConfigScreen could surface an org-list picker after login if user belongs to multiple
- **Operator-portal cross-link**: from BridgesListCard, link "View in operator portal" → opens browser via `tauri-plugin-opener`

## Constraint check

- ✅ No Apple Developer Account required (unsigned macOS dev-builds work locally)
- ✅ No Google Play Account required (we don't ship Android via Tauri 2 here)
- ✅ Self-hosted: updater endpoint is GitHub releases (self-hosted-able to any HTTPS URL), no Tauri-cloud or third-party SaaS
- ✅ Multi-tenant: BridgesListCard surfaces all of user's accessible orgs; pairing flow takes org_id from minted refresh-token
- ✅ Co-authored-by trailer preserved on every commit
- ✅ No `--no-verify` or hook bypass
