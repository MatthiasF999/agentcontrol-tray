---
description: Audit tray UI files against the AgentControl design system via the design-guard subagent. Flags raw hex literals, decorative gradients, dark-mode assumptions, off-token colours, and cross-screen drift — with concrete fixes.
argument-hint: <optional file or directory path; defaults to all currently changed files>
---

# /design-review

Spawn the **design-guard** subagent and have it audit the design conformance of
the given tray files (React-web / Tauri webview — not React Native).

## Behavior

1. If `$ARGUMENTS` is provided, treat it as the audit target (file path,
   directory, or comma-separated list). Pass it verbatim to the agent.
2. If no `$ARGUMENTS`, get the list of currently changed files:
   ```
   git diff --name-only HEAD --diff-filter=ACMR -- 'src/**/*.ts' 'src/**/*.tsx' 'src/**/*.css'
   ```
   If the working tree is clean, fall back to:
   ```
   git diff --name-only HEAD~1 --diff-filter=ACMR -- 'src/**/*.ts' 'src/**/*.tsx' 'src/**/*.css'
   ```
3. Spawn the agent with the target list and these instructions:
   - List every violation as `path:line  RULE  detail  →  fix`.
   - Group by file.
   - Don't auto-fix; report only.
4. Return the agent's verdict. If clean, say so; otherwise the list of findings.

## When to use

- Before committing UI changes.
- Periodically to catch off-token / dark-palette drift.
- After adding a new screen, to check it conforms to its siblings.

## Related

- Mechanical lint: `pnpm lint` runs `scripts/check-design-tokens.mjs`, which
  enforces the strict subset (no raw hex / rgb literals in `.ts` / `.tsx`
  outside `src/theme/`). The agent covers the softer patterns (light-only,
  one-accent, no decorative gradients, cross-screen consistency).
- Canonical rationale: `agentcontrol-app/docs/DESIGN-GUIDE.md`.
