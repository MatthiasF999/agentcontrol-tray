# Changelog

All notable changes to the AgentControl Tray application (Tauri 2,
desktop tray app) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it cuts its first signed release. Until then, entries are grouped
by phase (see `docs/PHASE-*-SUMMARY.md`) and the `[Unreleased]` section
collects work-in-progress.

Future entries will be auto-appended by the Phase 38 release-planner
when releases ship through the operator-portal.

## [Unreleased]

### Added
- Phase 63 — **Windows bootstrapper.** A tiny (~106 KB) version-stable
  `setup.exe` served at one fixed URL
  (`https://install.agent-control.io/setup.exe`) always installs the
  latest tray (Chrome `ChromeSetup.exe` pattern). It reads
  `install.agent-control.io/latest.json`, downloads the real signed
  Tauri installer, SHA256-verifies it, and hands off with `/S`. Built
  with stock NSIS (no third-party plugins — TLS download + JSON parse +
  SHA256 delegated to a hidden PowerShell worker), so CI builds it on a
  plain Linux runner. Dark UI matching the tray palette. The release
  workflow builds + deploys `setup.exe` + `latest.json` on every tagged
  release. See `bootstrapper/README.md`.

### Changed
- Phase 60 — **redesigned the first-launch install wizard.** The onboarding
  flow now renders inside a dark, splash-matching shell (`#0e1116` bg +
  `#818cf8→#4f46e5` gradient) with a 35/65 left-rail step list (check /
  pulsing-current / empty-pending circles) and pill buttons. Expanded from
  5 to 8 steps: added **Welcome** (feature pitch) and **License** (terms
  acceptance) steps, and reworked the old `Setup` screen into a
  **System check** that probes WSL2 + Docker before collecting the git
  identity. The reducer state-machine, 11-step install engine, live WSL
  log streaming, and all existing Tauri commands are reused unchanged.
  Bumped to `0.6.0` (UX-breaking first-run flow).

- Phase 56.3 — **migrated to the multi-subdomain production domain.** The
  default host is now `agent-control.io` (was the `178.105.244.59`
  self-signed Hetzner box), with each role on its own Let's Encrypt
  subdomain: `api.` (Supabase REST/auth + edge functions), `app.`
  (end-user web + `/pair-bridge`), `operator.` (admin portal + download),
  `install.` (bridge tarball). Bumped to `0.5.0` — breaking, since the
  single-host assumption is gone.

### Removed
- Phase 56.3 — **dropped the self-signed-cert workarounds.** No more
  `NODE_TLS_REJECT_UNAUTHORIZED=0` in the bridge `.env` writer and no
  `curl -k` for the tarball download — the LE certs verify normally.

### Added
- Phase 55.3.0 — **folded the standalone bridge installer into the tray.**
  First-run onboarding (WSL2 + Ubuntu + system deps + Node 22 + Claude
  Code CLI + git config + bridge download/build + `.env` + pairing) now
  runs inside the tray (`src/onboarding/`), gated on a persisted
  `bridge.setup.done.v1` flag. New Tauri commands ported from the
  installer under `src-tauri/src/commands/`.

### Changed
- Phase 55.3.0 — **bridge now runs as a `systemctl --user` service**
  (WSL on Windows, native on Linux) instead of a tray-child process.
  Quitting the tray no longer stops the bridge (Tailscale pattern).
  `BridgeSupervisor` drives start/stop/restart/status via systemctl.
- Phase 55.3.0 — **dropped the bundled bridge** (`bundle.resources` +
  `bundle-bridge.sh`); tray bundles are dramatically smaller. Release
  artifacts are now one portable file per platform (AppImage / portable
  `.exe` / `.app.zip`); Windows builds with `--no-bundle`.

- Phase 43 Add-30 — **tray "About" CHANGELOG card** in SettingsScreen.
  Shows the latest 2 versions inline (parsed in-app from a bundled
  snapshot of /CHANGELOG.md, keep-a-changelog format). "Show all"
  link routes to operator-portal Releases (Add-31, out of tray scope).
  New `src/lib/changelog.ts` (pure parser, no deps) +
  `src/lib/changelogBundled.ts` + `src/screens/AboutCard.tsx`.

- Phase 43 Add-25 — **CHANGELOG Unreleased gate** wired into `release-gates`
  job in `.github/workflows/ci.yml`. Mirrors bridge ci.yml mandatory gate
  #5 — `CHANGELOG.md` must keep `## [Unreleased]` at the top so the
  release-planner has a landing spot for work-in-progress.

- Phase 37 Add-82 — **`doc-set-gate` job** promoted from supabase
  ci.yml to tray ci.yml. PR-only, only on `^feat/phase-` branches.
  Diff vs origin/main must touch at least one of `.claude/memory.md`,
  `docs/PHASE-*-SUMMARY.md`, `CLAUDE.md`, or `CHANGELOG.md`. Enforces
  the doc-set protocol cross-repo.

- biome + line-limits enforcement (`scripts/check-line-limits.mjs` +
  `biome.json`). New `pnpm lint` / `pnpm lint:fix` / `pnpm format`
  scripts; `pnpm check` chains `pnpm lint && pnpm tsc --noEmit` as the
  TS-side smoke gate. Pre-existing Phase 27/28/32/38 offenders are
  recorded in `scripts/.line-limits-grandfather` and shrink over time.
- Phase 38.8 — tray-side backlog UI (Quick-add FAB on HomeScreen +
  `BacklogConsumptionScreen` + `useStandupDigest` native notification
  on `backlog_standup_tasks` → 'delivered'). Tray stays consumption-only
  per architect §10.2; transitions stay in app.

### Blocked on operator action (Phase 39)
- First signed `v0.1.0` AppImage (Linux WSL2)
- Per-OS bundles (macOS via host build, Windows via `cargo-xwin` or native)
- `tauri-plugin-updater` signed-manifest flow (Tauri signer keypair
  generation is operator-action)

## Historic releases (pre-CHANGELOG)

- **Phase 38.8** — Backlog consumption UI (this CHANGELOG starts here)
- **Phase 32.4** — Process template edit flow + auto-advance gate UI
- **Phase 27** — Tray foundation (Tauri 2 scaffold, tray icon, basic
  command surface). See `docs/PHASE-27-SUMMARY.md`.
- **Phase 28** — Cloud-mode + bridge runtime config UI. See
  `docs/PHASE-28-SUMMARY.md`.
