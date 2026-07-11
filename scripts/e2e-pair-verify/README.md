# e2e pair-flow verifier

An end-to-end guard for the **installer magic-link → pair-bridge return path**.

## The bug this catches

Dogfood, 2026-07-11: after magic-link sign-in from the Windows installer, the
browser landed on the app's default authed route **`/Main/inbox/inbox`**
instead of returning to **`/pair-bridge/?claim_code=...`**, so the bridge was
never claimed. The user wants this class of bug caught automatically — you
should not be able to hit it by hand.

### Root cause shape

The tray opens `https://app.<host>/pair-bridge/?claim_code=XXXX&label=...` in the
browser (`openPairInstallerSignIn`, `src/onboarding/api.ts`). When the visitor
is signed out, that page requests a magic link whose `redirect_to` must be the
pair-bridge callback. If that callback URL is **not in Supabase Auth's redirect
allow-list**, GoTrue silently rewrites `redirect_to` to **`SITE_URL`** (the app
root). The SPA then routes the now-authed user to its default inbox
(`/Main/inbox/inbox`). Net effect: the claim code is dropped and pairing stalls.

## How it works

`verify-pair-flow.mjs`:

1. Mints a magic-link for a seeded test user via the **GoTrue admin API**
   (`admin.auth.admin.generateLink`, `type: 'magiclink'`), passing
   `redirectTo = https://app.<host>/pair-bridge/?claim_code=...`.
2. Follows the `action_link` redirect chain **manually** (`redirect: 'manual'`),
   exactly like a browser, preserving GoTrue's appended hash fragment.
3. Asserts the landing URL's path starts with `/pair-bridge/` **and** the
   `claim_code` survived. If GoTrue fell back to `SITE_URL`, the path is `/`
   (app root → SPA inbox) and the assertion **fails loudly**.
4. *(optional)* Polls the bridge's local `/pair` endpoint until `state` flips to
   `paired` (Component 2).

### What it does and does not cover

- ✅ **GoTrue redirect honoring / allow-list** — the actual dogfood root cause.
  Caught at the HTTP-redirect layer, no browser needed.
- ✅ **`claim_code` preservation** across the redirect.
- ⚠️ **SPA client-side routing** (the literal `/Main/inbox/inbox` navigation
  that runs *after* the SPA loads and does the PKCE exchange) is **not**
  executed here — that needs a real JS engine. HTTP-level, the broken case
  surfaces as "landed on `SITE_URL` (`/`)" rather than the literal inbox path;
  they are the same failure. A Playwright layer that drives the real SPA and
  asserts the final in-app route is the natural follow-up (Playwright is
  already available in this workspace).

## Running

Requires Node 20+ (uses global `fetch`, `node --test`). `@supabase/supabase-js`
resolves from the repo's `node_modules` (already a dependency).

```bash
export SUPABASE_URL="https://api.agent-control.io"
export SUPABASE_SERVICE_ROLE_KEY="<service_role JWT>"   # NEVER commit
export APP_URL="https://app.agent-control.io"
export TEST_EMAIL="e2e-installer-test@agentcontrol.dev" # optional
export CLAIM_CODE="TEST-0000"                            # optional
export LABEL="e2e-verify"                                # optional
# Optional Component-2 bridge poll (run on the host with the bridge up):
# export BRIDGE_PAIR_URL="http://127.0.0.1:3001/pair"

node scripts/e2e-pair-verify/verify-pair-flow.mjs
```

Exit `0` = pass, `1` = assertion/flow failure, `2` = missing env.

### Service-role key handling

The `service_role` JWT bypasses RLS — treat it like a root password.

- **Preferred:** export `SUPABASE_SERVICE_ROLE_KEY` in the shell / CI secret
  store for a single run; never persist it.
- **Local convenience:** a `scripts/e2e-pair-verify/.env` file is git-ignored
  (`*.local` and an explicit ignore entry). `source` it before running — it is
  never committed.
- The script **redacts** `token=` params in its logged redirect chain.

### Bridge port note

The brief mentioned `:3000`, but the tray's Rust command
(`src-tauri/src/commands/bridge.rs`) probes **`http://127.0.0.1:3001/pair`** and
parses `{"state": "...", "code": "..."}`. This verifier defaults to `:3001`.
Override with `BRIDGE_PAIR_URL` if your bridge listens elsewhere.

## Test user

See `seed-test-user.sql` — **reference SQL, NOT a migration, DO NOT AUTO-APPLY.**
It is guarded (`-v e2e_seed=1`) and a no-op otherwise. Prefer creating the auth
user via the GoTrue admin API (`admin.auth.admin.createUser`); `generateLink`
will also lazily create the user in most GoTrue configs.

## Unit tests

Fully mocked (no network, no Supabase). The centerpiece asserts the check
**fails** on the SITE_URL-fallback regression and **passes** when the
pair-bridge callback is honored.

```bash
node --test 'scripts/e2e-pair-verify/*.test.mjs'
```
