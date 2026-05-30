# agentcontrol-tray — Claude conventions

## Repo purpose

Desktop tray app on the Bridge-daemon host. Tauri 2 + React/TS in webview,
Rust shell. Analog to Tailscale's daemon-host tray.

## Sibling repos

- `bridge` (Node.js) — the daemon this tray manages. Local HTTP API at
  `localhost:3001`.
- `agentcontrol-app` (React Native + Expo Web) — end-user mobile/web UI.
  **Different audience**: app = end-users; tray = daemon-host operator.
  Do NOT duplicate features that belong in the app.
- `supabase` (self-hosted) — coordination plane. Tray reads from
  `bridges` + `autonomous_tasks` tables via `@supabase/supabase-js`.

## Stack conventions

- **Tauri 2** (not Electron) for footprint + match to self-hosted ethos
- **Rust shell**: only tray, window-management, IPC commands, OS-keychain
- **React + TS** in webview for all UI
- **No native fancy** — webview-first; reach for native only when web
  can't do it (tray, notifications, OS secure storage, Docker socket)
- **Single window**: hidden by default, shown via tray-click or
  `show_main_window` Rust command. Closing the window hides it
  (`prevent_close`), doesn't quit. Quit only via tray-menu "Quit".

## Constraints (carry-over from main AgentControl project)

- No Apple Developer / Google Play accounts required (local-deploy only)
- Multi-tenant + team-fähig (same RLS surface as app)
- Bridge-token storage in `bridge-data` Docker volume (existing — tray
  drives the pairing, doesn't change persistence)
- Self-hosted Supabase as coordination plane

## Pattern catalog cross-ref

This repo applies Pattern 1 (Architect-Pre-Step) and Pattern 2
(Aggressive context-forking via agent teams) heavily. See
`supabase/docs/AGENT-METHODOLOGY.md` in sibling repo.

## What this repo is NOT

- Not the end-user app (that's `agentcontrol-app`)
- Not the operator-portal admin UI (that's served by supabase Caddy)
- Not a replacement for `agentctl` CLI (CLI stays for headless servers)
