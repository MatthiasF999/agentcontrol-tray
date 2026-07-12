# e2e pair-flow verifier

An end-to-end guard for the **installer magic-link → pair-bridge return path**.
It runs as a step **inside the Windows-Sandbox WSL flow** (right after the bridge
installs) so the regression can't ship, and also runs standalone from any host.

## The bug this catches

Dogfood, 2026-07-11: after magic-link sign-in from the Windows installer, the
browser landed on the app's default authed route **`/Main/inbox/inbox`** instead
of returning to **`/pair-bridge/?claim_code=...`**, so the bridge was never
claimed. You should not be able to hit this by hand.

### Root cause shape

The tray opens `https://app.<host>/pair-bridge/?claim_code=XXXX&label=...`
(`openPairInstallerSignIn`, `src/onboarding/api.ts`). A signed-out visitor
requests a magic link whose `redirect_to` must be that pair-bridge callback. If
the callback is **not in Supabase Auth's redirect allow-list**, GoTrue silently
rewrites `redirect_to` → **`SITE_URL`** (the app root); the SPA then routes the
authed user to its inbox and the claim code is dropped.

## How it works

`verify-pair-flow.mjs` (zero npm deps — Node ≥ 20 built-ins + global `fetch`):

1. Mints a magic-link for a seeded test user via GoTrue's admin REST API
   (`POST /auth/v1/admin/generate_link`, `type: magiclink`),
   `redirect_to = https://app.<host>/pair-bridge/?claim_code=...`.
2. Follows the `action_link` redirect chain **manually** (`redirect: 'manual'`),
   like a browser, preserving GoTrue's appended hash fragment.
3. **Asserts** the landing path starts with `/pair-bridge/` and `claim_code`
   survived. SITE_URL fallback → path `/` → the assertion **fails loudly**.
4. *(optional)* Polls the bridge `/pair` endpoint until `state === paired`
   (only meaningful when a full pairing is actually driven — see limitations).

It prints one machine-readable line the PowerShell harness greps:

```
PAIRFLOW_JSON {"pass":true,"finalUrl":"...","pathname":"/pair-bridge/","claimCode":"TEST-0000"}
```

Exit `0` = pass, `1` = assertion/flow failure, `2` = missing config.

## Running inside the Windows Sandbox (primary)

Wired into the WSL flow (`scripts/sandbox-test/`, stacked on
`phase66d.wsl/sandbox-wsl-flow`):

- `host-orchestrator.sh` stages `verify-pair-flow.mjs` into the RO `staging`
  mount, and — for the `wsl` flow — stages `pair-verify.env` if present.
- `sandbox-runner-wsl.ps1` runs `Step-VerifyPairFlow` after `Step-VerifyBridge`:
  `wsl -d Ubuntu-22.04 -u root -e bash -lc "PAIR_VERIFY_ENV=… node …verify-pair-flow.mjs"`,
  writes `output/pair-flow.json`, and records the step `pass` / `fail` / `skip`.

Enable it by dropping a **gitignored** `scripts/sandbox-test/pair-verify.env`
(copy `pair-verify.env.example`) with the service_role key. Without that file
the step records **`skip`** and the run still passes. Then:

```bash
cd scripts/sandbox-test && ./host-orchestrator.sh --flow wsl
```

## Running standalone

Node ≥ 20. Zero npm deps.

```bash
export SUPABASE_URL=https://api.agent-control.io
export SUPABASE_SERVICE_ROLE_KEY=<service_role JWT>   # NEVER commit
export APP_URL=https://app.agent-control.io
# export BRIDGE_PAIR_URL=http://127.0.0.1:3001/pair   # optional
node scripts/e2e-pair-verify/verify-pair-flow.mjs
```

Or point `PAIR_VERIFY_ENV` at a KEY=VALUE file (same keys as
`pair-verify.env.example`) instead of exporting.

### Service-role key handling

The `service_role` JWT bypasses RLS — treat it like a root password.

- **Sandbox:** rides in via the RO-mounted `staging/pair-verify.env`; never on a
  command line, never committed (gitignored, `.example` template only).
- **Standalone:** export the env var for one run, or a gitignored
  `scripts/e2e-pair-verify/.env` you `source`.
- The script **redacts** `token` / `access_token` / `refresh_token` in all
  logged URLs and in `pair-flow.json`.

### Test user

Provisioned out-of-band as the dedicated e2e user
(`e2e-installer-test@agentcontrol.dev`) — see the backend's
`docs/E2E-TEST-USER.md` / migration `0150` / `provision-e2e-user.mjs` produced by
the parallel test-user teammate. `seed-test-user.sql` here is **reference SQL
only, NOT a migration, DO NOT AUTO-APPLY** (guarded `-v e2e_seed=1`, no-op
otherwise); prefer the canonical provisioning script.

## What it does and does not cover

- ✅ **GoTrue redirect honoring / allow-list** — the actual dogfood root cause,
  caught at the HTTP-redirect layer, no browser needed.
- ✅ **`claim_code` preservation** across the redirect.
- ⚠️ **SPA client-side routing** (the literal `/Main/inbox/inbox` navigation the
  SPA performs after loading + PKCE exchange) is **not** executed here — that
  needs a JS engine. HTTP-level, the broken case surfaces as "landed on
  `SITE_URL` (`/`)", the same failure. A Playwright layer driving the real SPA
  is the natural follow-up (Playwright is available in this workspace).
- ⚠️ **bridge → paired** (`BRIDGE_PAIR_URL` poll) only completes when a real
  pairing is driven (tray/browser POSTing to `/admin/pair`). The sandbox step
  does not drive that, so it runs the redirect assertion only.

### Bridge port note

The brief mentioned `:3000`, but the tray's Rust command
(`src-tauri/src/commands/bridge.rs`) probes **`http://127.0.0.1:3001/pair`** and
parses `{"state":"...","code":"..."}`. This verifier defaults to `:3001`;
override with `BRIDGE_PAIR_URL`.

## Unit tests

Fully mocked (no network, no Supabase). The centerpiece asserts the check
**fails** on the SITE_URL-fallback regression and **passes** when the pair-bridge
callback is honored.

```bash
node --test 'scripts/e2e-pair-verify/*.test.mjs'
```
