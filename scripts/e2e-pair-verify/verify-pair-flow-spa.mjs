#!/usr/bin/env node
/**
 * verify-pair-flow-spa.mjs — SPA-level sibling of verify-pair-flow.mjs.
 *
 * The HTTP verifier (verify-pair-flow.mjs) proves GoTrue honors the pair-bridge
 * redirect allow-list: it follows the redirect chain with `fetch` and asserts
 * the FINAL HTTP location is `/pair-bridge/`. That catches the "SITE_URL
 * fallback landed at `/`" shape of the dogfood bug — but it never executes the
 * SPA. The React app's real navigation happens client-side: after the magic
 * link lands on the callback, `AuthCallbackScreen.tsx` does a PKCE exchange and
 * then `window.location.href = /pair-bridge/...` (fixed in PR #41). If that
 * client-side routing regressed, HTTP-level verification would still PASS while
 * a real browser ends up on `/Main/inbox/`.
 *
 * This variant closes that gap: it drives the DEPLOYED SPA in a headless
 * Chromium via Playwright, consumes a real admin-minted magic link with
 * `page.goto`, waits for the SPA's client-side navigation to settle, and
 * asserts `page.url()` (the real client-side URL) is `/pair-bridge/`, NOT the
 * authed inbox.
 *
 * Playwright is a RUN-environment prerequisite (guest-side), NOT a build-time
 * dep — see README. It is imported lazily inside the default launcher so the
 * unit tests (which inject a fake browser) need nothing installed.
 *
 * Env (or a KEY=VALUE file pointed to by PAIR_VERIFY_ENV) — same as the HTTP
 * verifier, plus optional Playwright browser-location overrides:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL, TEST_EMAIL, CLAIM_CODE,
 *   LABEL, BRIDGE_PAIR_URL                        (see verify-pair-flow.mjs)
 *   PLAYWRIGHT_CHANNEL          e.g. chromium | chrome | msedge (playwright-core)
 *   PLAYWRIGHT_EXECUTABLE_PATH  explicit Chromium binary (playwright-core)
 *   SPA_NAV_TIMEOUT_MS          client-side-nav wait budget (default 30000)
 *   SPA_SCREENSHOT_DIR          where spa-*.png land (default ./output)
 *
 * Emits one machine-readable line the PowerShell harness greps:
 *   `SPAFLOW_JSON {"pass":true,"finalUrl":"...",...}`
 * Exit 0 = pass, 1 = assertion/flow failure, 2 = missing config.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  buildRedirectTo,
  generateMagicLink,
  loadEnvFile,
  parseLanding,
  pollBridgePaired,
  redact,
} from './verify-pair-flow.mjs';

const DEFAULT_EMAIL = 'e2e-installer-test@agentcontrol.dev';
const DEFAULT_CLAIM = 'TEST-0000';
const PAIR_PATH = '/pair-bridge';
// The authed default route the SPA falls back to when the pair claim is lost.
const INBOX_MARKER = '/Main/inbox';

/**
 * Assert the SPA's REAL client-side URL landed back on the pair-bridge callback
 * with the claim code intact — the thing HTTP-level verification cannot see.
 * Throws a descriptive Error otherwise. Returns the parsed landing on success.
 */
export function assertSpaLanding(finalUrl, expectedClaimCode) {
  const landing = parseLanding(finalUrl);
  if (landing.pathname.includes(INBOX_MARKER) || !landing.pathname.startsWith(PAIR_PATH)) {
    throw new Error(
      `SPA pair-flow regression: after auth the client-side router landed on ` +
        `"${landing.pathname}" (origin ${landing.origin}) instead of ${PAIR_PATH}/. ` +
        `The magic link was consumed but AuthCallbackScreen did not navigate back ` +
        `to the pair-bridge callback (see PR #41 window.location.href fix) — the ` +
        `authed user was routed to the default inbox (${INBOX_MARKER}) and the ` +
        `bridge is never claimed. Unlike the HTTP verifier, this executed the real ` +
        `SPA router, so a green HTTP check with a red result here means the ` +
        `regression is client-side, not in GoTrue's redirect allow-list.`,
    );
  }
  if (expectedClaimCode && landing.claimCode !== expectedClaimCode) {
    throw new Error(
      `SPA pair-flow regression: claim_code lost across client-side navigation — ` +
        `expected "${expectedClaimCode}", got "${landing.claimCode ?? '(none)'}".`,
    );
  }
  return landing;
}

/**
 * Default browser launcher: lazily import Playwright (full `playwright` if the
 * run env has bundled browsers, else `playwright-core` driven by a channel /
 * explicit executable). Returns a minimal `{ newPage, close }` session the core
 * pipeline drives — the same shape the unit tests fake.
 */
export async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    ({ chromium } = await import('playwright-core'));
  }
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHANNEL) launchOpts.channel = process.env.PLAYWRIGHT_CHANNEL;
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium.launch(launchOpts);
  return {
    newPage: async () => {
      const context = await browser.newContext();
      return context.newPage();
    },
    close: () => browser.close(),
  };
}

/** Best-effort screenshot; never let a screenshot failure mask the real result. */
async function shoot(page, dir, name) {
  const path = join(dir, `spa-${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    /* headless without a display, or fake page in tests — ignore */
  }
  return path;
}

/**
 * Core SPA pipeline, decoupled from env + process.exit so tests can drive it
 * with a fake browser and a mocked link generator. Throws on any assertion
 * failure; returns the parsed landing (+ bridge state when checked) on success.
 */
export async function runSpaVerification({
  supabaseUrl,
  serviceRole,
  appUrl,
  email,
  claimCode,
  label = 'e2e-verify',
  bridgeUrl,
  navTimeoutMs = 30_000,
  screenshotDir = 'output',
  bridgePollTimeoutMs = 30_000,
  bridgePollStepMs = 3_000,
  fetchImpl,
  generateLinkImpl,
  launchImpl,
}) {
  const redirectTo = buildRedirectTo(appUrl, claimCode, label);
  const gen = generateLinkImpl ?? ((to) => generateMagicLink(supabaseUrl, serviceRole, { email, redirectTo: to }, fetchImpl));
  const actionLink = await gen(redirectTo);

  const launch = launchImpl ?? launchBrowser;
  const browser = await launch();
  const shots = [];
  try {
    const page = await browser.newPage();

    // 1. Land on the pair-bridge screen the tray opens (signed-out sees email prompt).
    await page.goto(redirectTo, { waitUntil: 'domcontentloaded' });
    shots.push(await shoot(page, screenshotDir, '1-pair-landing'));

    // 2. Consume the admin-minted magic link exactly as clicking it from email
    //    would: GoTrue verifies, redirects to redirect_to, the SPA boots and
    //    AuthCallbackScreen runs the PKCE exchange + client-side navigation.
    await page.goto(actionLink, { waitUntil: 'domcontentloaded' });
    shots.push(await shoot(page, screenshotDir, '2-post-auth'));

    // 3. Wait for the SPA's client-side router to settle on the pair-bridge route.
    //    On the regression it settles on the inbox instead → waitForURL times out;
    //    we still read page.url() below and assert, turning the timeout into a
    //    descriptive assertion rather than an opaque Playwright error.
    try {
      await page.waitForURL((url) => new URL(url).pathname.startsWith(PAIR_PATH), { timeout: navTimeoutMs });
    } catch {
      /* fall through to assertSpaLanding on the current url for a precise message */
    }
    const finalUrl = await page.url();
    shots.push(await shoot(page, screenshotDir, '3-final'));

    const landing = assertSpaLanding(finalUrl, claimCode);

    let bridgeState;
    if (bridgeUrl) {
      bridgeState = await pollBridgePaired(bridgeUrl, fetchImpl ?? fetch, bridgePollTimeoutMs, bridgePollStepMs);
      if (bridgeState !== 'paired') {
        throw new Error(`bridge did not reach 'paired' within 30s (last: ${bridgeState})`);
      }
    }
    return { landing, finalUrl, bridgeState, redirectTo, screenshots: shots };
  } finally {
    await browser.close();
  }
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
  const email = process.env.TEST_EMAIL ?? DEFAULT_EMAIL;
  const claimCode = process.env.CLAIM_CODE ?? DEFAULT_CLAIM;
  const label = process.env.LABEL ?? 'e2e-verify';
  const bridgeUrl = process.env.BRIDGE_PAIR_URL;
  const navTimeoutMs = Number(process.env.SPA_NAV_TIMEOUT_MS ?? 30_000);
  const screenshotDir = process.env.SPA_SCREENSHOT_DIR ?? 'output';
  mkdirSync(screenshotDir, { recursive: true });

  console.log(`> [SPA] generating magic-link for ${email}`);
  console.log(`> [SPA] redirectTo: ${buildRedirectTo(appUrl, claimCode, label)}`);
  console.log('> [SPA] driving deployed app in headless Chromium (Playwright)');
  if (bridgeUrl) console.log(`> [SPA] will poll bridge pair state at ${bridgeUrl} (<=30s)`);

  try {
    const { landing, finalUrl, bridgeState, screenshots } = await runSpaVerification({
      supabaseUrl,
      serviceRole,
      appUrl,
      email,
      claimCode,
      label,
      bridgeUrl,
      navTimeoutMs,
      screenshotDir,
      fetchImpl: fetch,
    });
    console.log(`> [SPA] screenshots: ${screenshots.join(', ')}`);
    console.log(`PASS: SPA client-side URL settled on ${landing.pathname} with claim_code=${landing.claimCode}`);
    if (bridgeState) console.log('PASS: bridge transitioned to paired');
    emit({ pass: true, finalUrl: redact(finalUrl), pathname: landing.pathname, claimCode: landing.claimCode, bridgeState });
    console.log('\nOK: SPA pair-flow verified end-to-end (real browser)');
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
