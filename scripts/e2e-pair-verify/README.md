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

- `host-orchestrator.sh` stages **both** `verify-pair-flow.mjs` and
  `verify-pair-flow-spa.mjs` into the RO `staging` mount, and — for the `wsl`
  flow — stages `pair-verify.env` if present.
- `sandbox-runner-wsl.ps1` runs `Step-VerifyPairFlow` after `Step-VerifyBridge`:
  `wsl -d Ubuntu-22.04 -u root -e bash -lc "PAIR_VERIFY_ENV=… node …verify-pair-flow.mjs"`,
  writes `output/pair-flow.json`, and records the step `pass` / `fail` / `skip`.
- `Step-VerifyPairFlowSpa` runs **after** it (higher-value, catches strictly
  more), writing `output/pair-flow-spa.json` + `output/spa-*.png`. It records
  **`skip`** when `pair-verify.env` is absent **or** Playwright is not installed
  in the guest (it probes for `playwright` / `playwright-core` first) — so the
  run still passes on a machine without Playwright.

> Only the **WSL** runner (`sandbox-runner-wsl.ps1`) has the pair-flow steps;
> the GUI-installer runner (`sandbox-runner.ps1`) drives the tray UI in-sandbox
> and has no Node/WSL context to run these verifiers. (The brief referenced a
> `runner-vm.ps1` — no such file exists in this repo.)

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

## SPA-level verifier (`verify-pair-flow-spa.mjs`)

The HTTP verifier asserts the **HTTP redirect chain** ends at `/pair-bridge/`.
It never runs the SPA, so it cannot see the app's **client-side** navigation:
after the magic link lands on the callback, `AuthCallbackScreen.tsx` runs a PKCE
exchange and then `window.location.href = /pair-bridge/...` (fixed in PR #41). If
that client-side routing regressed, the HTTP check would stay **green** while a
real browser ends up on `/Main/inbox/`.

`verify-pair-flow-spa.mjs` closes that gap. It drives the **deployed** app in a
**headless Chromium (Playwright)**:

1. Mints the same admin magic link (reuses `generateMagicLink` from the HTTP
   verifier — identical GoTrue admin REST call).
2. `page.goto(/pair-bridge/?claim_code=…)` — the screen the tray opens.
3. `page.goto(actionLink)` — consumes the magic link exactly as clicking it from
   the email would; GoTrue verifies, the SPA boots, `AuthCallbackScreen` runs.
4. Waits for the SPA's **client-side** router to settle, then asserts
   `page.url()` (the real client-side URL) starts with `/pair-bridge/` and is
   **not** the authed inbox. A `waitForURL` timeout is turned into a descriptive
   assertion, not an opaque Playwright error.
5. Screenshots `spa-1-pair-landing`, `spa-2-post-auth`, `spa-3-final` into
   `SPA_SCREENSHOT_DIR` (default `./output`).

It prints one machine-readable line: `SPAFLOW_JSON {"pass":true,...}` (exit `0` /
`1` / `2`, same convention as the HTTP verifier).

### Playwright variant: `playwright-core` (or full `playwright`)

The default launcher lazily imports **full `playwright`** (uses its bundled
browsers if present) and falls back to **`playwright-core`** (driven by a channel
or explicit binary). The lazy import means the **unit tests need nothing
installed** — they inject a fake browser. Extra env for `playwright-core`:

- `PLAYWRIGHT_CHANNEL` — `chromium` | `chrome` | `msedge`
- `PLAYWRIGHT_EXECUTABLE_PATH` — explicit Chromium binary
- `SPA_NAV_TIMEOUT_MS` (default 30000), `SPA_SCREENSHOT_DIR` (default `./output`)

> **Guest-side prerequisite — not a build-time dep.** Playwright is **not**
> vendored into this repo and **not** `npm install`ed at build time. It must be
> present in the **run environment** (the WSL guest / VM / CI runner). Install it
> there, e.g. `npm i -g playwright && npx playwright install chromium`, or point
> `PLAYWRIGHT_EXECUTABLE_PATH` at a system Chromium. When it is absent the
> sandbox step records **`skip`** (see below) and the run still passes.

```bash
# same env as the HTTP verifier, plus Playwright available on the machine:
node scripts/e2e-pair-verify/verify-pair-flow-spa.mjs
```

### When to run each

- **HTTP (`verify-pair-flow.mjs`)** — fast, zero-dep, no browser. The quick
  gate: catches the GoTrue redirect-allow-list regression (SITE_URL fallback).
  Run it everywhere, always.
- **SPA (`verify-pair-flow-spa.mjs`)** — definitive, but needs Playwright +
  Chromium. Catches **strictly more**: the client-side routing regression a
  green HTTP check would miss. Run it after the HTTP check, wherever a browser
  is available. A red SPA result with a green HTTP result localizes the bug to
  the SPA router, not GoTrue's allow-list.

### Service-role key handling

The `service_role` JWT bypasses RLS — treat it like a root password.

- **Sandbox:** rides in via the RO-mounted `staging/pair-verify.env`; never on a
  command line, never committed (gitignored, `.example` template only).
- **Standalone:** export the env var for one run, or a gitignored
  `scripts/e2e-pair-verify/.env` you `source`.
- The script **redacts** `token` / `access_token` / `refresh_token` in all
  logged URLs and in `pair-flow.json`.

### Test user

The dedicated e2e user (`e2e-installer-test@agentcontrol.dev`) is **provisioned
by the backend's canonical migration
`agentcontrol-supabase/migrations/0150_e2e_installer_test_user.sql`** (merged +
applied to prod; idempotent + non-destructive). **Do not hand-provision this
user** — no seed SQL lives here anymore. For details see the backend's
`docs/E2E-TEST-USER.md` and, for a one-off out-of-band provision, its
`scripts/provision-e2e-user.mjs`.

## What it does and does not cover

- ✅ **GoTrue redirect honoring / allow-list** — the actual dogfood root cause,
  caught at the HTTP-redirect layer, no browser needed.
- ✅ **`claim_code` preservation** across the redirect.
- ✅ **SPA client-side routing** (the literal `/Main/inbox/inbox` navigation the
  SPA performs after loading + PKCE exchange) — now covered by the sibling
  **`verify-pair-flow-spa.mjs`** (Playwright, headless Chromium). The HTTP
  verifier still cannot see it (it needs a JS engine); run the SPA verifier for
  that layer. See **[SPA-level verifier](#spa-level-verifier-verify-pair-flow-spamjs)**.
- ⚠️ **bridge → paired** (`BRIDGE_PAIR_URL` poll) only completes when a real
  pairing is driven (tray/browser POSTing to `/admin/pair`). The sandbox step
  does not drive that, so it runs the redirect assertion only.

### Bridge port note

The brief mentioned `:3000`, but the tray's Rust command
(`src-tauri/src/commands/bridge.rs`) probes **`http://127.0.0.1:3001/pair`** and
parses `{"state":"...","code":"..."}`. This verifier defaults to `:3001`;
override with `BRIDGE_PAIR_URL`.

## Unit tests

Fully mocked (no network, no Supabase, **no Playwright install**). The HTTP
suite's centerpiece asserts the check **fails** on the SITE_URL-fallback
regression and **passes** when the pair-bridge callback is honored. The SPA
suite injects a **fake Playwright browser/page** and asserts it **fails** when
the SPA client-side-routes to the inbox (the PR #41 regression shape) and
**passes** when it settles on `/pair-bridge/`.

```bash
node --test 'scripts/e2e-pair-verify/*.test.mjs'   # runs both suites
```
