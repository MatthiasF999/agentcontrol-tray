#!/usr/bin/env node
/**
 * verify-pair-flow.mjs — end-to-end guard for the installer magic-link →
 * pair-bridge return path.
 *
 * Regression it catches (dogfood 2026-07-11): after magic-link sign-in the
 * browser landed on the app's default authed route (`/Main/inbox/inbox`)
 * instead of returning to `/pair-bridge/?claim_code=...`, so the bridge was
 * never claimed. That happens when GoTrue's redirect allow-list does not
 * include the pair-bridge callback: GoTrue silently rewrites `redirect_to`
 * to SITE_URL (the app root), and the SPA then routes the authed user to
 * its inbox. This script mints a magic-link via the admin API, follows the
 * redirect chain like a browser would, and asserts the landing URL is the
 * pair-bridge callback — not the SITE_URL fallback.
 *
 * Pure helpers are exported for unit tests; the CLI runner only fires when
 * the file is invoked directly.
 *
 * Env (see README.md):
 *   SUPABASE_URL              e.g. https://api.agent-control.io
 *   SUPABASE_SERVICE_ROLE_KEY service_role JWT (NEVER commit)
 *   TEST_EMAIL                seeded e2e user (default e2e-installer-test@agentcontrol.dev)
 *   APP_URL                   e.g. https://app.agent-control.io
 *   CLAIM_CODE                claim code to round-trip (default TEST-0000)
 *   LABEL                     machine label (default e2e-verify)
 *   BRIDGE_PAIR_URL           optional; e.g. http://127.0.0.1:3001/pair — enables bridge state poll
 */
import { fileURLToPath } from 'node:url';

const DEFAULT_EMAIL = 'e2e-installer-test@agentcontrol.dev';
const DEFAULT_CLAIM = 'TEST-0000';
const PAIR_PATH = '/pair-bridge';

/** Build the redirect the tray opens: app-side pair-bridge callback + claim. */
export function buildRedirectTo(appUrl, claimCode, label) {
  const base = appUrl.replace(/\/+$/, '');
  const q = `claim_code=${encodeURIComponent(claimCode)}&label=${encodeURIComponent(label)}`;
  return `${base}${PAIR_PATH}/?${q}`;
}

/**
 * Follow a redirect chain manually (like a browser, `redirect: 'manual'`),
 * preserving hash fragments GoTrue appends. Returns the final resolved URL
 * plus the intermediate chain. `fetchImpl` is injectable for tests.
 */
export async function followRedirects(startUrl, fetchImpl, maxHops = 10) {
  let current = startUrl;
  const chain = [startUrl];
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await fetchImpl(current, { redirect: 'manual' });
    const status = res.status ?? 0;
    const location = res.headers?.get?.('location') ?? null;
    if (status < 300 || status >= 400 || location === null) {
      return { finalUrl: current, chain, status };
    }
    current = new URL(location, current).toString();
    chain.push(current);
  }
  throw new Error(`redirect chain exceeded ${maxHops} hops: ${chain.join(' -> ')}`);
}

/** Parse the landing URL into pathname + claim_code + any implicit tokens. */
export function parseLanding(finalUrl) {
  const u = new URL(finalUrl);
  const hash = new URLSearchParams(u.hash.startsWith('#') ? u.hash.slice(1) : u.hash);
  return {
    url: finalUrl,
    origin: u.origin,
    pathname: u.pathname,
    claimCode: u.searchParams.get('claim_code'),
    accessToken: hash.get('access_token'),
    refreshToken: hash.get('refresh_token'),
    error: u.searchParams.get('error') ?? hash.get('error'),
  };
}

/**
 * Assert the browser landed back on the pair-bridge callback with the claim
 * code intact. Throws a descriptive Error otherwise (used as the test's core
 * assertion). Returns the parsed landing on success.
 */
export function assertPairLanding(finalUrl, expectedClaimCode) {
  const landing = parseLanding(finalUrl);
  if (!landing.pathname.startsWith(PAIR_PATH)) {
    throw new Error(
      `pair-flow regression: expected landing on ${PAIR_PATH}/ but got ` +
        `"${landing.pathname}" (origin ${landing.origin}). This is the ` +
        `SITE_URL fallback — GoTrue did not honor the pair-bridge redirect, ` +
        `so the SPA routes the authed user to its default inbox ` +
        `(/Main/inbox/inbox) and the bridge is never claimed. ` +
        `Add the pair-bridge callback to Supabase Auth redirect URLs.`,
    );
  }
  if (expectedClaimCode && landing.claimCode !== expectedClaimCode) {
    throw new Error(
      `pair-flow regression: claim_code lost across redirect — expected ` +
        `"${expectedClaimCode}", got "${landing.claimCode ?? '(none)'}".`,
    );
  }
  return landing;
}

/** Poll the bridge's local /pair endpoint until state === 'paired' or timeout. */
export async function pollBridgePaired(pairUrl, fetchImpl, timeoutMs = 30_000, stepMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(pairUrl);
      const body = await res.json();
      last = body?.state ?? 'unreachable';
      if (last === 'paired') return 'paired';
    } catch {
      last = 'unreachable';
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
}

/**
 * Core pipeline, decoupled from env + process.exit so tests can drive it with
 * a mocked admin client and fetch. Throws on any assertion failure; returns
 * the parsed landing (+ bridge state when checked) on success.
 */
export async function runVerification({ admin, fetchImpl, appUrl, email, claimCode, label = 'e2e-verify', bridgeUrl }) {
  const redirectTo = buildRedirectTo(appUrl, claimCode, label);
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });
  if (error) throw new Error(`generateLink error — ${error.message}`);
  const actionLink = data?.properties?.action_link;
  if (!actionLink) throw new Error('generateLink returned no action_link');

  const { finalUrl, chain, status } = await followRedirects(actionLink, fetchImpl);
  const landing = assertPairLanding(finalUrl, claimCode);

  let bridgeState;
  if (bridgeUrl) {
    bridgeState = await pollBridgePaired(bridgeUrl, fetchImpl);
    if (bridgeState !== 'paired') {
      throw new Error(`bridge did not reach 'paired' within 30s (last: ${bridgeState})`);
    }
  }
  return { landing, chain, status, bridgeState, redirectTo };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`FAIL: missing required env ${name} (see README.md)`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceRole = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const appUrl = requireEnv('APP_URL');
  const email = process.env.TEST_EMAIL ?? DEFAULT_EMAIL;
  const claimCode = process.env.CLAIM_CODE ?? DEFAULT_CLAIM;
  const label = process.env.LABEL ?? 'e2e-verify';
  const redirectTo = buildRedirectTo(appUrl, claimCode, label);

  const bridgeUrl = process.env.BRIDGE_PAIR_URL;
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`> generating magic-link for ${email}`);
  console.log(`> redirectTo: ${redirectTo}`);
  if (bridgeUrl) console.log(`> will poll bridge pair state at ${bridgeUrl} (<=30s)`);

  try {
    const { landing, chain, bridgeState } = await runVerification({
      admin,
      fetchImpl: fetch,
      appUrl,
      email,
      claimCode,
      label,
      bridgeUrl,
    });
    console.log(`> redirect chain (${chain.length} hops):`);
    for (const u of chain) console.log(`    ${u.replace(/token=[^&]+/g, 'token=REDACTED')}`);
    console.log(`PASS: landed on ${landing.pathname} with claim_code=${landing.claimCode}`);
    if (bridgeState) console.log('PASS: bridge transitioned to paired');
    console.log('\nOK: pair-flow verified end-to-end');
  } catch (e) {
    console.error(`\nFAIL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`FAIL: ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(1);
  });
}
