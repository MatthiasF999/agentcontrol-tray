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
