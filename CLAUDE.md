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

## Tooling + scripts

- **pnpm** is the package manager (not npm). `pnpm install` after clone.
- **dev**: `pnpm tauri dev` — vite + tauri together.
- **build**: `pnpm tauri build` — produces unsigned binaries (AppImage /
  .deb on Linux, .app / .dmg on macOS, .exe / .msi on Windows).
- **typecheck (frontend)**: `pnpm tsc --noEmit` — runs as part of
  `pnpm build` (which is `tsc && vite build`).
- **Rust check**: `cd src-tauri && cargo check` for the Rust side; full
  build via `cargo build --release` (or via `pnpm tauri build`).
- **No test runner wired yet** (Phase 27/28 spike — tests deferred).
  Treat `pnpm check` (= `pnpm lint && pnpm tsc --noEmit`) plus
  `cargo check` as the smoke gate.
- **Linter / formatter (TS side)**: Biome 2.4 (`biome.json`) +
  `scripts/check-line-limits.mjs`. Run via `pnpm lint`; auto-fix safe
  issues with `pnpm lint:fix`; format-only with `pnpm format`. Rust
  side stays on `cargo fmt`.

## Hard limits (enforced by `scripts/check-line-limits.mjs` — `pnpm lint` fails on violation)

Biome has no line-count rule, so the limits live in
`scripts/check-line-limits.mjs` (TypeScript-AST based), invoked by
`pnpm lint`.

- **Functions ≤ 50 lines** (non-blank). Hard — no exception.
- **`src/components/**` + `src/hooks/**` ≤ 150 lines** (non-blank). A
  single file may raise its ceiling up to 250 with one marker:
  `// line-limit:250 -- reason: <why>`. Use sparingly.
- **Everything else under `src/` ≤ 250 lines**. Over the limit → split
  it, don't raise it.
- **`src-tauri/` is skipped** — Rust side has its own discipline
  (`cargo fmt` + `cargo check`).

Pre-existing offenders (Phase 27/28/32/38 code that landed before the
limits existed) are tracked in `scripts/.line-limits-grandfather`. New
violations must be fixed at the source — the grandfather list shrinks,
never grows.

## Clean code (https://cln.co/) — the review rubric

**Canonical rubric (Add-38):** the 7-principle definitions (SRP / SoC /
DRY / KISS / YAGNI / LoD / DIP) live in the sibling `supabase` repo at
`supabase/docs/AGENT-METHODOLOGY.md` §"Clean-Code rubric (cln.co)" —
single source of truth across all four repos. The gloss below is the
tray-specific reading.

Every change is reviewed against CleanCode Principles. The ones that
bite most here: **SRP** (one screen / hook, one reason to change),
**SoC** (UI ≠ data-fetching ≠ Tauri-command glue), **DRY** (shared
logic in `src/lib/` and `src/bridge/`), **KISS / YAGNI**, **LoD** (the
tray *reads* daemon + Supabase state, never re-derives it), **DIP**
(depend on `BridgeClient` / `SupabaseClient` interfaces, not their
innards).

## TypeScript

- `strict: true`. **No `any`** (Biome `suspicious/noExplicitAny` is an
  error). Use `unknown` + narrowing, or a real type.

See `README.md` for the system-deps list (Linux needs
`libwebkit2gtk-4.1-dev` + friends) and the cross-platform build matrix.

## Design system (light-only, one accent, glass-over-atmosphere)

The tray mirrors `agentcontrol-app`'s visual language so the two feel like one
product. Canonical rationale — the *why* behind every rule — lives in the
sibling repo at `agentcontrol-app/docs/DESIGN-GUIDE.md`. The tray follows it;
it does not fork it.

- **Source of truth:** `src/theme/tokens.css` (every `var(--ac-*)` custom
  property) and its TS mirror `src/theme/tokens.ts` (`Colors.*` for inline
  `style={{}}`). Keep the two in sync. Light-only by design — no dark mode, no
  `prefers-color-scheme` branch.
- **Font:** Geist Variable, bundled as a self-hosted WOFF2 at
  `public/fonts/GeistVariable.woff2` (Vercel's Geist, SIL OFL 1.1 — see the
  co-located `Geist-LICENSE.txt`). Declared via `@font-face` in `tokens.css`;
  referenced only through `--ac-font-sans` (Inter + system-ui remain as
  pre-swap fallbacks).
- **Never hard-code a colour outside `src/theme/`** — reference a `var(--ac-*)`
  token (CSS) or a `Colors.*` value (inline TSX).

### Enforcement layers

1. **Mechanical:** `scripts/check-design-tokens.mjs` (run by `pnpm lint`) fails
   on raw hex / `rgb()` / `rgba()` / `hsl()` literals in `.ts` / `.tsx` outside
   `src/theme/`. Escape hatch: `// design-token:allow -- reason: <why>` (line)
   or `// design-token:allow-file -- reason: <why>` (file).
2. **Agent:** `.claude/agents/design-guard.md` reviews the softer patterns
   (light-only, one-accent, no decorative gradients on cards, typography via
   the font token, cross-screen consistency).
3. **Command:** `/design-review [path]` spawns design-guard against changed
   files (or an explicit target). Run before committing UI changes.

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

## Parallel teammates on this repo

When 2+ Claude teammates work in this repo simultaneously, each MUST use:

  git worktree add /tmp/<repo-name>-<branch-slug> <branch>

instead of `git checkout <branch>` in the shared clone. Reason:
git branch refs are global per-repo (not per-worktree), so a sibling
teammate's `git checkout other-branch` instantly yanks your HEAD off
your branch and a subsequent push can clobber refs. Worktrees give
each teammate isolated HEAD + working tree.

Pattern:
  cd /tmp/<repo-name>-<branch-slug>
  # do work, commit, push
  cd /<original-path>
  git worktree remove /tmp/<repo-name>-<branch-slug>

Reference: feedback_agent_teams_worktree_isolation_incomplete memory.
