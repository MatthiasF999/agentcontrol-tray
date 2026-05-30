# Phase 28 — Bridge cross-repo deltas + tray architectural corrections

**Status**: Complete. 5 commits across two repos (3 bridge, 2 tray)
plus this summary. Phase-27's cross-repo gaps are now shipped end-to-end
— the tray's UI surface stops being "ready against placeholder routes"
and is ready against the real ones.

**Scope**: Land the four bridge routes flagged in
`agentcontrol-tray/docs/PHASE-27-2-CROSS-REPO.md` Delta A + revisit the
spec's architectural assumptions, correcting two over-specifications
that emerged during implementation.

## Commit ledger

| # | Repo | Commit | Subject |
|---|---|---|---|
| 1 | bridge | `41405c5` | POST /pair/accept — Tray-initiated pairing |
| 2 | bridge | `98ddbde` | GET /autonomous/status — in-memory executor snapshot |
| 3 | tray | `5cab6de` | approve direct-to-Supabase + pair-form alignment with Bridge |
| 4 | bridge | `757b6f4` | GET /config — read-only BridgeConfig public view |
| 5 | tray | `65c0c2d` | Quick-pair UI using existing pair_bridge RPC |

## Phase-27 cross-repo spec — status

The four bridge deltas from `PHASE-27-2-CROSS-REPO.md` reconciled against
what actually shipped:

| Route | Phase-27 plan | Phase-28 outcome | Status |
|---|---|---|---|
| `POST /pair/accept` | New route mirroring /pair/complete pattern, 5-shape response matrix | Shipped as `pair-accept.ts` + sibling test (5/5 passing). Mounted in mountCloudRoutes() before API_KEY. Body uses camelCase (refreshToken, bridgeId, orgId) matching the existing /pair/complete contract — corrected from the snake_case + supabase_url shape sketched in 27.2 | ✅ shipped |
| `GET /autonomous/status` | Returns running_count + claimed task IDs + pending-approval IDs | Shipped as `autonomous-status.ts` returning running + code-review in-flight subsets only. The "pending-approval" piece intentionally moved to tray's direct supabase Realtime subscription (already wired in 27.5's useRecentTasks) — bridge doesn't track that in memory | ✅ shipped (scope refined) |
| `POST /autonomous/approve/{taskId}` | New bridge route mutating autonomous_tasks.status | **Skipped — design correction**. The autonomous_tasks RLS already lets owner JWTs write `approved_at` + `approved_by` directly via PostgREST; the column-RLS trigger (supabase 0035) explicitly allows end-user updates while blocking bridge JWTs. Bridge round-trip would be wasteful. Tray now calls supabase directly | ✅ shipped tray-side, no bridge route needed |
| `GET /config` + `PUT /config` | Bridge runtime config CRUD | **GET shipped**, **PUT deferred** — runtime config mutation needs subsystem re-boot semantics (executor pump cycle for maxConcurrent, in-process config persistence story). Operator path remains: edit .env + restart bridge. PUT lives in a future iter once a clear "what mutates, how it persists" model is decided | ⚠️ partial (GET ✅, PUT deferred) |

The fifth optional Delta B (`bridge_mint_token` Supabase RPC):

| Item | Phase-27 plan | Phase-28 outcome | Status |
|---|---|---|---|
| `bridge_mint_token` SECURITY DEFINER RPC | New migration + 4-case test for quick-pair flow | **Skipped — existing infrastructure suffices**. Migration 0003's `pair_bridge(p_code, p_org_id, p_label, p_tailscale_host)` already does exactly what quick-pair needs: owner/admin caller, locks + claims a bridge_claims row, mints bridge + refresh_token. No new RPC needed. Tray's QuickPair component calls the existing RPC | ✅ shipped tray-side via existing RPC |

## Architectural corrections (design pivots during implementation)

### Correction 1 — Approve direct-to-Supabase (commit 5cab6de)

**Phase-27 assumption**: tray → bridge `/autonomous/approve/{taskId}` → bridge → supabase update.

**Discovery**: autonomous_tasks's column-RLS trigger
(`supabase/migrations/0035`) explicitly allows end-user JWTs to mutate
`approved_at` + `approved_by` while blocking bridge JWTs. The
existing owner-update RLS policy gates which orgs the user can
approve in. So tray can go direct.

**Why this is better**: one fewer hop, RLS already covers auth,
bridge stays focused on heavy operations. Bridge's existing
`waitForApproval` poller still sees the flip on its next tick.

**Cost**: Removed `approveTask()` from BridgeClient (dead code).
Removed the planned `/autonomous/approve/{taskId}` bridge route from
the plan.

### Correction 2 — Quick-pair via existing pair_bridge RPC (commit 65c0c2d)

**Phase-27 assumption**: new Supabase RPC `bridge_mint_token` for
the quick-pair UX, plus migration + 4-case test.

**Discovery**: Migration 0003 already has `pair_bridge(p_code,
p_org_id, p_label, p_tailscale_host)` doing exactly that — owner/admin
caller, locks bridge_claims row, mints bridge + refresh_token. The
"new RPC" plan would have duplicated existing infrastructure.

**Why this is better**: zero new supabase migrations, zero new RLS
analysis, zero new tests. Just a tray-side hook + UI.

**Cost**: Corrected BridgePairingState type union in tray (had
fictional 'claimed' variant from a 27.2 design sketch; actual variants
are 'unpaired' / 'expired' / 'paired'). One tray-side commit covers
both the QuickPair component and the type-correction follow-ups in
useTraySync + HomeScreen.

### Correction 3 — Pair-accept body shape (in commit 41405c5)

**Phase-27 spec**: body `{bridge_id, refresh_token, supabase_url}` in
snake_case.

**Discovery**: existing `/pair/complete` route uses camelCase
(`refreshToken, bridgeId, orgId`) matching the rest of the bridge
HTTP surface. Supabase URL is redundant — bridge has it from env via
`config.supabaseFunctionsUrl`.

**Why this is better**: consistency with existing bridge contracts;
fewer redundant fields.

**Cost**: tray's BridgeAcceptRequest interface updated to camelCase;
PairScreen form gains an Org ID field (now required since bridge
verifies binding).

## What you can verify locally

```bash
# Bridge — all 4 routes
cd ~/projects/private/agentcontrol-bridge
npm test -- src/routes/pair-accept.test.ts \
              src/routes/autonomous-status.test.ts \
              src/routes/config.test.ts
# Should report: 13 tests pass across 3 files

npm run lint                # clean (2 pre-existing warnings in cogneeSearch)
npm run typecheck           # clean
```

```bash
# Tray
cd ~/projects/private/agentcontrol-tray
pnpm exec tsc --noEmit      # clean
cd src-tauri && cargo check # clean (already verified in Phase 27)
```

## What requires runtime smoke (operator-action)

The TDD-mocked tests cover the routes in isolation. End-to-end
smoke still wants a paired live bridge + supabase + tray boot — the
real-OS verification matrix from PHASE-27-SUMMARY still applies.

Specific to Phase 28:
- `pnpm tauri dev` on Linux WSLg → click "Sign in" → magic-link → on
  pair screen, "Quick pair" panel should populate orgs and complete
  the bridge handshake against a live unpaired bridge
- After pairing, HomeScreen status-LED should turn green and recent
  tasks should populate from supabase Realtime
- Approve a task in HomeScreen → row status should flip in <2s via
  Realtime (bridge waitForApproval poller picks it up)

## File diff summary

```
bridge/
├── src/autonomous/surfaceLifecycle.ts       +25 lines (snapshot getter)
├── src/index.ts                             +27 lines (4 new mount lines + imports)
├── src/routes/
│   ├── autonomous-status.ts                 NEW — 27 lines
│   ├── autonomous-status.test.ts            NEW — 94 lines (3 tests)
│   ├── config.ts                            NEW — 70 lines
│   ├── config.test.ts                       NEW — 113 lines (5 tests)
│   ├── pair-accept.ts                       NEW — 108 lines
│   └── pair-accept.test.ts                  NEW — 218 lines (5 tests)

tray/
├── src/bridge/
│   ├── bridgeClient.ts                      type fix — BridgePairingState union
│   ├── useOrgsList.ts                       NEW — 77 lines
│   ├── useTraySync.ts                       claimed → unpaired
├── src/screens/
│   ├── HomeScreen.tsx                       claimed → unpaired
│   ├── PairScreen.tsx                       quick-pair primary, manual collapsed
│   ├── QuickPair.tsx                        NEW — 129 lines
│   └── RecentTasksCard.tsx                  approve → direct-supabase
└── docs/PHASE-28-SUMMARY.md                 NEW — this file
```

## What lands next

- **27.7 cross-repo finalization**: Tauri signer keypair generation
  + per-release signing flow remains operator-action per
  `PHASE-27-7-AUTOUPDATE.md`. Self-hosted GitHub release pipeline can
  start whenever you decide to publish builds
- **Real-OS runtime verification**: macOS / Windows builds need
  native hosts; Linux WSLg `pnpm tauri dev` is the one I can't run
  headless in this session
- **PUT /config** (deferred from 28.4): once a runtime config
  mutation + persistence story is agreed, the route is ~30 lines
  inside the existing `configRouter` factory
- **Auto-restart after /pair/accept**: today the bridge's autonomous
  executors only spin up at boot when `loadToken()` returns non-null.
  After a runtime pairing via /pair/accept the bridge needs a manual
  restart for autonomous mode to kick in. Honest gap, not blocking
  for first-pair UX. Lands as `28.x bootstrap-trigger` whenever
  someone needs it (probably the first user who pairs and wonders
  why no tasks run)

## Constraint check

- ✅ Co-Authored-By trailer preserved on every commit
- ✅ No `--no-verify` or hook bypass
- ✅ Branch + ff-merge discipline on bridge repo (3 branches, 3 merges)
- ✅ TDD on bridge — every new src/routes/*.ts has sibling .test.ts
- ✅ Bridge lint clean (only 2 pre-existing warnings in unrelated cogneeSearch)
- ✅ Bridge line-limit + test-coverage + protocol-sync all green
- ✅ No Apple/Google account-pflichtige operations
- ✅ Cross-repo discipline: bridge ↔ supabase ↔ tray independent codebases, no inter-import
