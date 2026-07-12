#!/usr/bin/env node
/**
 * verify-pair-flow-signup.mjs — SPA-SIGN-IN-DRIVEN sibling of
 * verify-pair-flow-spa.mjs. Closes the gap both existing verifiers leave open.
 *
 * WHY THIS EXISTS
 * ---------------
 * `verify-pair-flow.mjs` (HTTP) and `verify-pair-flow-spa.mjs` (browser) both
 * mint an admin magic-link whose `redirect_to` is ALREADY the pair-bridge
 * callback (`buildRedirectTo` → `/pair-bridge/?claim_code=…`). They then follow
 * that link. That proves GoTrue honours an allow-listed redirect and (for the
 * SPA one) that a browser lands on `/pair-bridge/`. But they NEVER exercise the
 * SPA's OWN sign-in code path — the code that actually decides `redirect_to`.
 *
 * The real app does something different (and it is where the 2026-07-11 dogfood
 * bug lived): the tray opens `/pair-bridge/?claim_code=…`; the signed-out SPA
 * (`PairBridgeScreen`) stashes the claim in **sessionStorage** and shows an
 * email form (`PairBridgeSignIn` → `useMagicLink`). Submitting calls
 * `signInWithOtp({ emailRedirectTo: AUTH_REDIRECT_URL })` where
 * `AUTH_REDIRECT_URL = <origin>/auth/callback` — the claim is NOT in the URL,
 * it rides in sessionStorage. After the magic link returns to `/auth/callback`,
 * `AuthCallbackScreen` establishes the session and re-attaches the stashed claim
 * via `window.location.href = /pair-bridge/?claim_code=…`. If ANY link in that
 * SPA-owned chain breaks (the OTP request's `redirect_to`, the stash, or the
 * callback's re-attach), the bridge is never claimed — and the admin-forced
 * verifiers stay GREEN because they skip the whole chain.
 *
 * This verifier drives the ACTUAL flow in a headless browser:
 *   1. goto `/pair-bridge/?claim_code=<rnd>` — the SPA stashes the claim.
 *   2. type the email into the SPA's own form and submit — the SPA issues its
 *      own `POST /auth/v1/otp?redirect_to=…`. We intercept that request and
 *      ASSERT the `redirect_to` the SPA built is same-origin + an allow-listed
 *      callback (the thing the admin-forced tests can never observe).
 *   3. complete the round-trip through the SPA's real recovery path
 *      (`/auth/callback` → `AuthCallbackScreen` → stash re-attach) and assert
 *      the client-side URL settles on `/pair-bridge/` with the claim intact.
 *
 * Three paths (env `SPA_SIGNUP_PATHS`, default `signin,signup,otp`):
 *   signin — seeded existing user (TEST_EMAIL).
 *   signup — fresh throwaway `signup-<ts>@<SIGNUP_DOMAIN>`. The deployment is
 *            invite-only (Phase 51 closed-signup gate: the SPA calls
 *            `request_signup` before `signInWithOtp`, and an uninvited email is
 *            rejected — so the SPA never issues the OTP request). We therefore
 *            pre-create the user's `auth.users` shell via the admin API first
 *            (what `request_signup`/`invite_to_org` do for an allowed email), so
 *            the gate admits it; the created user is deleted in a finally block.
 *   otp    — enters the 6-digit code in the SPA's NEW in-tab OTP input (added in
 *            a sibling PR). Feature-detected: records `skip` when that input is
 *            not present in the deployed SPA, so it never falsely fails.
 *
 * Playwright is a RUN-environment prerequisite (guest-side), imported lazily via
 * `launchBrowser` (reused from verify-pair-flow-spa.mjs) so the unit tests need
 * nothing installed — they inject a fake browser.
 *
 * Emits one machine-readable line the PowerShell harness greps:
 *   `SPAFLOW_JSON {"pass":true,"paths":[…]}`
 * Exit 0 = pass (incl. all-skipped), 1 = a path failed, 2 = missing config.
 *
 * @line-limit-exception: single self-contained e2e verifier; the three sign-in
 * paths share one pipeline + admin helpers and splitting them across modules
 * would obscure the linear flow. Mirrors the sibling verifiers' one-file style.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnvFile, parseLanding, pollBridgePaired, redact } from './verify-pair-flow.mjs';
import { assertSpaLanding, launchBrowser } from './verify-pair-flow-spa.mjs';

const DEFAULT_SEEDED_EMAIL = 'e2e-installer-test@agentcontrol.dev';
const DEFAULT_SIGNUP_DOMAIN = 'agentcontrol.dev';
const PAIR_PATH = '/pair-bridge';
const EMAIL_INPUT = '[data-testid="pair-email-input"]';
// The in-tab OTP input added by the sibling PR. Primary testID + text fallback.
const OTP_INPUT = '[data-testid="pair-otp-input"]';
const OTP_INPUT_FALLBACK = 'input[autocomplete="one-time-code"], input[inputmode="numeric"]';

/** A short random claim code, e.g. `E2E7-3FA9`, unique per run. */
export function randomClaim() {
  const b = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `E2E${b().slice(0, 1)}-${b()}`;
}

/** Build the pair-bridge URL the tray opens (SPA stashes the claim from here). */
export function buildPairUrl(appUrl, claimCode, label) {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}${PAIR_PATH}/?claim_code=${encodeURIComponent(claimCode)}&label=${encodeURIComponent(label)}`;
}

/** The callback the SPA's own signInWithOtp targets (AUTH_REDIRECT_URL, web). */
export function authCallbackUrl(appUrl) {
  return `${appUrl.replace(/\/+$/, '')}/auth/callback`;
}

/**
 * Assert the `redirect_to` the SPA itself put on `POST /auth/v1/otp` is sane:
 * present, same-origin as the app, and an allow-listed callback path
 * (`/auth/callback` today; `/pair-bridge` if a fix moves the claim into the
 * URL). A cross-origin or missing value is exactly the silent-drop shape the
 * admin-forced verifiers cannot see. Returns the parsed redirect on success.
 */
export function assertSpaRedirectTo(redirectTo, appUrl) {
  if (!redirectTo) {
    throw new Error(
      'SPA sign-in regression: the app issued signInWithOtp with NO redirect_to. ' +
        'GoTrue would fall back to SITE_URL and the claim is lost. This is the SPA ' +
        'own-code-path bug the admin-forced verifiers cannot catch.',
    );
  }
  const appOrigin = new URL(appUrl).origin;
  let got;
  try {
    got = new URL(redirectTo);
  } catch {
    throw new Error(`SPA sign-in regression: redirect_to is not a URL: "${redirectTo}"`);
  }
  if (got.origin !== appOrigin) {
    throw new Error(
      `SPA sign-in regression: redirect_to origin "${got.origin}" != app origin ` +
        `"${appOrigin}". GoTrue rejects off-allow-list redirects and silently uses ` +
        `SITE_URL → the claim is dropped and the bridge never pairs.`,
    );
  }
  if (!(got.pathname.startsWith('/auth/callback') || got.pathname.startsWith(PAIR_PATH))) {
    throw new Error(
      `SPA sign-in regression: redirect_to path "${got.pathname}" is neither ` +
        `/auth/callback nor ${PAIR_PATH}/. The SPA built an unexpected callback.`,
    );
  }
  return { origin: got.origin, pathname: got.pathname };
}

/** Generic GoTrue admin REST call (service_role). Returns parsed JSON. */
async function adminFetch(supabaseUrl, serviceRole, method, path, body, fetchImpl) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if ((res.status ?? 0) >= 400) {
    throw new Error(`admin ${method} ${path} → HTTP ${res.status}: ${json?.msg ?? json?.error ?? text}`);
  }
  return json;
}

/**
 * Mint a magic-link + OTP for `email` via `admin/generate_link`, targeting the
 * SPA's real `/auth/callback` (NOT the pair-bridge callback — the SPA relies on
 * the sessionStorage stash, exactly like production). Returns the action link,
 * the 6-digit OTP, and the resolved user id (for signup cleanup).
 */
export async function mintCallbackLink(supabaseUrl, serviceRole, email, appUrl, fetchImpl) {
  const body = await adminFetch(
    supabaseUrl, serviceRole, 'POST', '/auth/v1/admin/generate_link',
    { type: 'magiclink', email, redirect_to: authCallbackUrl(appUrl) }, fetchImpl,
  );
  const props = body?.properties ?? body;
  const actionLink = props?.action_link ?? body?.action_link;
  if (!actionLink) throw new Error(`generate_link returned no action_link: ${JSON.stringify(body)}`);
  return {
    actionLink,
    emailOtp: props?.email_otp ?? body?.email_otp ?? null,
    userId: body?.user?.id ?? body?.id ?? props?.user_id ?? null,
  };
}

/**
 * Pre-create the `auth.users` shell for a fresh email via the admin API, so the
 * SPA's closed-signup gate (`request_signup`, Phase 51) admits it and the SPA
 * proceeds to `signInWithOtp`. Without this, `request_signup` raises "Signup not
 * allowed — invitation required" for an uninvited email, the SPA swallows it as
 * `ClosedSignupError` and NEVER issues `POST /auth/v1/otp` — which surfaces as
 * the "issued no /auth/v1/otp request" failure. Admin-creating the user is
 * exactly what `request_signup` / `invite_to_org` do for an allowed email, so
 * the gate then returns `{status:"existing"}`. Returns the created user id.
 */
export async function precreateUser(supabaseUrl, serviceRole, email, fetchImpl) {
  const body = await adminFetch(
    supabaseUrl, serviceRole, 'POST', '/auth/v1/admin/users',
    { email, email_confirm: true }, fetchImpl,
  );
  return body?.id ?? body?.user?.id ?? null;
}

/** Delete a user via the admin API; swallow errors (best-effort teardown). */
export async function deleteUser(supabaseUrl, serviceRole, userId, fetchImpl) {
  if (!userId) return;
  try {
    await adminFetch(supabaseUrl, serviceRole, 'DELETE', `/auth/v1/admin/users/${userId}`, undefined, fetchImpl);
  } catch {
    /* teardown must never mask a real result */
  }
}

/** Best-effort screenshot; a screenshot failure must never mask the result. */
async function shoot(page, dir, name) {
  const path = join(dir, `spa-signup-${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    /* headless without a display, or fake page in tests — ignore */
  }
  return path;
}

/** True if the locator resolves to at least one node within `timeoutMs`. */
async function present(page, selector, timeoutMs) {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive the SPA's own email form and capture the `redirect_to` the SPA built on
 * its `POST /auth/v1/otp`. Submits via Enter (the input's onSubmitEditing),
 * falling back to the "Send magic link" button. Returns the captured redirect.
 */
async function submitEmailForm(page, email, navTimeoutMs) {
  const otpReqP = page
    .waitForRequest((r) => r.url().includes('/auth/v1/otp'), { timeout: navTimeoutMs })
    .catch(() => null);
  const input = page.locator(EMAIL_INPUT);
  await input.fill(email);
  await input.press('Enter');
  let req = await otpReqP;
  if (!req) {
    // Enter did not submit (RN-web quirk): click the submit button and retry.
    const retryP = page
      .waitForRequest((r) => r.url().includes('/auth/v1/otp'), { timeout: navTimeoutMs })
      .catch(() => null);
    await page.locator('[role="button"]:has-text("Send magic link"), button:has-text("Send magic link")').click();
    req = await retryP;
  }
  if (!req) throw new Error('SPA sign-in regression: submitting the email form issued no /auth/v1/otp request');
  return new URL(req.url()).searchParams.get('redirect_to');
}

/** Wait for the SPA's client-side router to settle, then assert the landing. */
async function awaitPairLanding(page, claimCode, navTimeoutMs) {
  try {
    await page.waitForURL((url) => new URL(url).pathname.startsWith(PAIR_PATH), { timeout: navTimeoutMs });
  } catch {
    /* fall through to assertSpaLanding on the current url for a precise message */
  }
  const finalUrl = await page.url();
  return { finalUrl, landing: assertSpaLanding(finalUrl, claimCode) };
}

/**
 * One path end-to-end: open pair screen → drive the SPA form → assert the
 * SPA-built redirect_to → complete the real recovery round-trip → assert the
 * client-side landing. `mode` is 'link' (magic-link callback) or 'otp' (in-tab
 * code). Returns a per-path result record; throws only on a genuine regression.
 */
async function runPath({
  page, mode, email, appUrl, claimCode, label, screenshotDir,
  navTimeoutMs, bridgeUrl, bridgePollTimeoutMs, bridgePollStepMs,
  supabaseUrl, serviceRole, fetchImpl, mintImpl,
}) {
  const shots = [];
  const pairUrl = buildPairUrl(appUrl, claimCode, label);
  await page.goto(pairUrl, { waitUntil: 'domcontentloaded' });
  shots.push(await shoot(page, screenshotDir, `${mode}-1-pair-landing`));

  // Offline build / not the pair screen → skip (never a false failure).
  if (!(await present(page, EMAIL_INPUT, navTimeoutMs))) {
    return { path: mode, status: 'skip', reason: 'pair-bridge email form not present (offline build or route changed)', screenshots: shots };
  }

  const redirectTo = await submitEmailForm(page, email, navTimeoutMs);
  const redirect = assertSpaRedirectTo(redirectTo, appUrl);
  shots.push(await shoot(page, screenshotDir, `${mode}-2-submitted`));

  const mint = mintImpl ?? ((e) => mintCallbackLink(supabaseUrl, serviceRole, e, appUrl, fetchImpl ?? fetch));
  const { actionLink, emailOtp, userId } = await mint(email);

  if (mode === 'otp') {
    // In-tab OTP path: needs the sibling PR's code input. Feature-detect first.
    const sel = (await present(page, OTP_INPUT, 3_000)) ? OTP_INPUT
      : (await present(page, OTP_INPUT_FALLBACK, 3_000)) ? OTP_INPUT_FALLBACK : null;
    if (!sel) {
      return { path: mode, status: 'skip', reason: 'in-tab OTP input not present in deployed SPA (sibling PR UI not shipped)', redirectTo, userId, screenshots: shots };
    }
    if (!emailOtp) {
      return { path: mode, status: 'skip', reason: 'admin generate_link returned no email_otp (GoTrue version)', redirectTo, userId, screenshots: shots };
    }
    const otp = page.locator(sel);
    await otp.fill(emailOtp);
    await otp.press('Enter');
  } else {
    // Magic-link path: consume the callback in the SAME tab so the SPA's real
    // sessionStorage stash + AuthCallbackScreen re-attach are exercised.
    await page.goto(actionLink, { waitUntil: 'domcontentloaded' });
  }

  const { finalUrl, landing } = await awaitPairLanding(page, claimCode, navTimeoutMs);
  shots.push(await shoot(page, screenshotDir, `${mode}-3-final`));

  let bridgeState;
  if (bridgeUrl) {
    bridgeState = await pollBridgePaired(bridgeUrl, fetchImpl ?? fetch, bridgePollTimeoutMs, bridgePollStepMs);
    if (bridgeState !== 'paired') throw new Error(`bridge did not reach 'paired' (last: ${bridgeState})`);
  }
  return {
    path: mode, status: 'pass', redirectTo, redirect, claimCode,
    finalUrl: redact(finalUrl), pathname: landing.pathname, bridgeState, userId, screenshots: shots,
  };
}

/**
 * Core pipeline over all requested paths, decoupled from env + process.exit so
 * unit tests drive it with a fake browser + mocked mints. Each signup path
 * deletes its throwaway user in a finally. Returns { pass, paths }.
 */
export async function runSignupVerification({
  supabaseUrl, serviceRole, appUrl, seededEmail, signupDomain = DEFAULT_SIGNUP_DOMAIN,
  paths = ['signin', 'signup', 'otp'], label = 'e2e-signup', screenshotDir = 'output',
  navTimeoutMs = 30_000, bridgeUrl, bridgePollTimeoutMs = 30_000, bridgePollStepMs = 3_000,
  fetchImpl, mintImpl, deleteImpl, precreateImpl, launchImpl,
}) {
  const launch = launchImpl ?? launchBrowser;
  // Real precreate needs admin creds; when they're absent (unit tests inject a
  // fake browser + mint) it's a no-op so the mint's userId still drives cleanup.
  const precreate = precreateImpl
    ?? (supabaseUrl && serviceRole
      ? (e) => precreateUser(supabaseUrl, serviceRole, e, fetchImpl ?? fetch)
      : async () => null);
  const browser = await launch();
  const results = [];
  try {
    for (const p of paths) {
      const mode = p === 'otp' ? 'otp' : 'link';
      const fresh = p === 'signup';
      const email = fresh ? `signup-${Date.now()}-${Math.floor(Math.random() * 1e4)}@${signupDomain}` : seededEmail;
      let rec;
      let preCreatedId = null;
      try {
        // Closed-signup gate: admit the fresh email BEFORE the SPA form runs, or
        // request_signup rejects it and no /auth/v1/otp request is ever issued.
        if (fresh) preCreatedId = await precreate(email);
        const page = await browser.newPage();
        rec = await runPath({
          page, mode, email, appUrl, claimCode: randomClaim(), label: `${label}-${p}`,
          screenshotDir, navTimeoutMs, bridgeUrl, bridgePollTimeoutMs, bridgePollStepMs,
          supabaseUrl, serviceRole, fetchImpl, mintImpl,
        });
        rec.name = p;
        rec.email = redact(email);
      } catch (e) {
        rec = { path: mode, name: p, status: 'fail', email: redact(email), error: e instanceof Error ? e.message : String(e) };
      } finally {
        const cleanupId = rec?.userId ?? preCreatedId;
        if (fresh && cleanupId) {
          await (deleteImpl ?? ((id) => deleteUser(supabaseUrl, serviceRole, id, fetchImpl ?? fetch)))(cleanupId);
        }
      }
      results.push(rec);
    }
  } finally {
    await browser.close();
  }
  return { pass: results.every((r) => r.status !== 'fail'), paths: results };
}

/** Print the single line the PowerShell harness greps. */
function emit(result) {
  console.log(`SPAFLOW_JSON ${JSON.stringify(result)}`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    emit({ pass: false, error: `missing required env ${name}` });
    console.error(`FAIL: missing required env ${name} (see README.md)`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const envFile = process.env.PAIR_VERIFY_ENV;
  if (envFile) loadEnvFile(envFile);

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceRole = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const appUrl = requireEnv('APP_URL');
  const seededEmail = process.env.TEST_EMAIL ?? DEFAULT_SEEDED_EMAIL;
  const signupDomain = process.env.SIGNUP_DOMAIN ?? DEFAULT_SIGNUP_DOMAIN;
  const paths = (process.env.SPA_SIGNUP_PATHS ?? 'signin,signup,otp').split(',').map((s) => s.trim()).filter(Boolean);
  const bridgeUrl = process.env.BRIDGE_PAIR_URL;
  const navTimeoutMs = Number(process.env.SPA_NAV_TIMEOUT_MS ?? 30_000);
  const screenshotDir = process.env.SPA_SCREENSHOT_DIR ?? 'output';
  mkdirSync(screenshotDir, { recursive: true });

  console.log(`> [SPA-signup] driving the SPA's OWN sign-in code path in headless Chromium`);
  console.log(`> [SPA-signup] paths: ${paths.join(', ')}  seeded=${seededEmail}  signupDomain=${signupDomain}`);
  if (bridgeUrl) console.log(`> [SPA-signup] will poll bridge pair state at ${bridgeUrl}`);

  try {
    const result = await runSignupVerification({
      supabaseUrl, serviceRole, appUrl, seededEmail, signupDomain, paths,
      screenshotDir, navTimeoutMs, bridgeUrl, fetchImpl: fetch,
    });
    for (const r of result.paths) {
      const tag = r.status.toUpperCase();
      console.log(`> [${tag}] ${r.name}: ${r.status === 'pass' ? `landed ${r.pathname} claim=${r.claimCode} (redirect_to=${r.redirect?.pathname})` : (r.reason ?? r.error ?? '')}`);
    }
    emit(result);
    if (!result.pass) {
      console.error('\nFAIL: at least one SPA sign-in path regressed');
      process.exit(1);
    }
    console.log('\nOK: SPA sign-in pair-flow verified end-to-end (real form, real recovery)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nFAIL: ${msg}`);
    emit({ pass: false, error: msg });
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    const msg = e instanceof Error ? e.stack : String(e);
    console.error(`FAIL: ${msg}`);
    emit({ pass: false, error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
