/**
 * Bundled snapshot of /CHANGELOG.md, embedded into the JS bundle so the
 * SettingsScreen AboutCard renders the latest release notes inline
 * without a network round-trip. Phase 43 Add-30.
 *
 * Sync convention: when /CHANGELOG.md is edited, paste the entire file
 * contents into the template literal below in the same commit. The
 * parser (src/lib/changelog.ts) is pure and unit-testable; this file
 * is data, not behaviour, so it has no test. A future Phase 43.x
 * iteration can replace this with a `?raw` Vite import once
 * `resolveJsonModule` + `assetsInclude` settle for `.md` in Tauri.
 *
 * Wire-future: AboutCard also accepts a remote-fetch override via
 * VITE_CHANGELOG_URL, which is the analog of the app's
 * `EXPO_PUBLIC_CHANGELOG_URL`.
 */
export const CHANGELOG_BUNDLED_MARKDOWN = `# Changelog

All notable changes to the AgentControl Tray application (Tauri 2,
desktop tray app) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it cuts its first signed release. Until then, entries are grouped
by phase (see \`docs/PHASE-*-SUMMARY.md\`) and the \`[Unreleased]\` section
collects work-in-progress.

Future entries will be auto-appended by the Phase 38 release-planner
when releases ship through the operator-portal.

## [Unreleased]

### Added
- Phase 43 Add-30 — **tray "About" CHANGELOG card** in SettingsScreen.
  Shows the latest 2 versions inline (parsed in-app from a bundled
  snapshot of /CHANGELOG.md, keep-a-changelog format). "Show all"
  link routes to operator-portal Releases (Add-31, out of tray scope).
- Phase 43 Add-25 — **CHANGELOG Unreleased gate** wired into
  \`release-gates\` job in \`.github/workflows/ci.yml\`. Mirrors bridge
  ci.yml mandatory gate #5.
- Phase 37 Add-82 — **\`doc-set-gate\` job** promoted from supabase
  ci.yml to tray ci.yml. PR-only, only on \`^feat/phase-\` branches.
  Diff vs origin/main must touch at least one of \`.claude/memory.md\`,
  \`docs/PHASE-*-SUMMARY.md\`, \`CLAUDE.md\`, or \`CHANGELOG.md\`. Enforces
  the doc-set protocol cross-repo.
- biome + line-limits enforcement (\`scripts/check-line-limits.mjs\` +
  \`biome.json\`). New \`pnpm lint\` / \`pnpm lint:fix\` / \`pnpm format\`
  scripts; \`pnpm check\` chains \`pnpm lint && pnpm tsc --noEmit\` as
  the TS-side smoke gate.
- Phase 38.8 — tray-side backlog UI (Quick-add FAB on HomeScreen +
  \`BacklogConsumptionScreen\` + \`useStandupDigest\` native notification
  on \`backlog_standup_tasks\` → 'delivered'). Tray stays
  consumption-only per architect §10.2; transitions stay in app.

## Historic releases (pre-CHANGELOG)

- **Phase 38.8** — Backlog consumption UI (this CHANGELOG starts here)
- **Phase 32.4** — Process template edit flow + auto-advance gate UI
- **Phase 27** — Tray foundation (Tauri 2 scaffold, tray icon, basic
  command surface). See \`docs/PHASE-27-SUMMARY.md\`.
- **Phase 28** — Cloud-mode + bridge runtime config UI. See
  \`docs/PHASE-28-SUMMARY.md\`.
`;
