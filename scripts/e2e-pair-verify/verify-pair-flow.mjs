#!/usr/bin/env node
/**
 * verify-pair-flow.mjs — end-to-end guard for the installer magic-link →
 * pair-bridge return path. Designed to run INSIDE the Windows-Sandbox WSL
 * flow (scripts/sandbox-test/sandbox-runner-wsl.ps1) right after the bridge
 * installs, as well as standalone from any host.
 *
 * Regression it catches (dogfood 2026-07-11): after magic-link sign-in the
 * browser landed on the app's default authed route (`/Main/inbox/inbox`)
 * instead of returning to `/pair-bridge/?claim_code=...`, so the bridge was
 * never claimed. That happens when GoTrue's redirect allow-list omits the
 * pair-bridge callback: GoTrue silently rewrites `redirect_to` to SITE_URL
 * (the app root), and the SPA then routes the authed user to its inbox. This
 * script mints a magic-link via the GoTrue admin REST API, follows the
 * redirect chain like a browser, and asserts the landing is the pair-bridge
 * callback — not the SITE_URL fallback.
 *
 * ZERO npm dependencies — Node built-ins + global fetch only (Node >= 20), so
 * it runs in a fresh sandbox with just the Node the bridge install provides.
 *
 * Env (or a KEY=VALUE file pointed to by PAIR_VERIFY_ENV):
 *   SUPABASE_URL              e.g. https://api.agent-control.io
 *   SUPABASE_SERVICE_ROLE_KEY service_role JWT (NEVER commit)
 *   APP_URL                   e.g. https://app.agent-control.io
 *   TEST_EMAIL                seeded e2e user (default e2e-installer-test@agentcontrol.dev)
 *   CLAIM_CODE                claim code to round-trip (default TEST-0000)
 *   LABEL                     machine label (default e2e-verify)
 *   BRIDGE_PAIR_URL           optional; e.g. http://127.0.0.1:3001/pair — enables bridge state poll
 *
 * On completion it prints a single machine-readable line the PowerShell
 * harness greps:  `PAIRFLOW_JSON {"pass":true,"finalUrl":"...",...}`
 * Exit 0 = pass, 1 = assertion/flow failure, 2 = missing config.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_EMAIL = 'e2e-installer-test@agentcontrol.dev';
const DEFAULT_CLAIM = 'TEST-0000';
const PAIR_PATH = '/pair-bridge';

/** Strip tokens from a URL before it lands in logs / output/pair-flow.json. */
export function redact(url) {
  return String(url).replace(/(access_token|refresh_token|token)=[^&#]+/g, '$1=REDACTED');
}

/** Populate process.env from a KEY=VALUE file (only for keys not already set). */
export function loadEnvFile(path, env = process.env) {
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = val;
  }
}

/** Build the redirect the tray opens: app-side pair-bridge callback + claim. */
export function buildRedirectTo(appUrl, claimCode, label) {
  const base = appUrl.replace(/\/+$/, '');
  const q = `claim_code=${encodeURIComponent(claimCode)}&label=${encodeURIComponent(label)}`;
  return `${base}${PAIR_PATH}/?${q}`;
}

/**
 * Mint a magic-link via GoTrue's admin REST API (no npm client). Returns the
 * `action_link`. `fetchImpl` is injectable for tests.
 */
export async function generateMagicLink(supabaseUrl, serviceRole, { email, redirectTo }, fetchImpl) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/admin/generate_link`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email, redirect_to: redirectTo }),
  });
  const body = await res.json();
  if ((res.status ?? 0) >= 400) {
    throw new Error(`generate_link HTTP ${res.status} — ${body?.msg ?? body?.error ?? JSON.stringify(body)}`);
  }
  const link = body?.action_link ?? body?.properties?.action_link;
  if (!link) throw new Error(`generate_link returned no action_link: ${JSON.stringify(body)}`);
  return link;
}

/**
 * Follow a redirect chain manually (like a browser, `redirect: 'manual'`),
 * preserving hash fragments GoTrue appends. Returns the final resolved URL
 * plus the intermediate chain.
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
  throw new Error(`redirect chain exceeded ${maxHops} hops: ${chain.map(redact).join(' -> ')}`);
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
 * code intact. Throws a descriptive Error otherwise (the test's core
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
 * a mocked link generator and fetch. Throws on any assertion failure; returns
 * the parsed landing (+ bridge state when checked) on success.
 */
export async function runVerification({
  supabaseUrl,
  serviceRole,
  appUrl,
  email,
  claimCode,
  label = 'e2e-verify',
  bridgeUrl,
  fetchImpl,
  generateLinkImpl,
}) {
  const redirectTo = buildRedirectTo(appUrl, claimCode, label);
  const gen = generateLinkImpl ?? ((to) => generateMagicLink(supabaseUrl, serviceRole, { email, redirectTo: to }, fetchImpl));
  const actionLink = await gen(redirectTo);

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

/** Print the single line the PowerShell harness greps. */
function emit(result) {
  console.log(`PAIRFLOW_JSON ${JSON.stringify(result)}`);
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

  console.log(`> generating magic-link for ${email}`);
  console.log(`> redirectTo: ${buildRedirectTo(appUrl, claimCode, label)}`);
  if (bridgeUrl) console.log(`> will poll bridge pair state at ${bridgeUrl} (<=30s)`);

  try {
    const { landing, chain, bridgeState } = await runVerification({
      supabaseUrl,
      serviceRole,
      appUrl,
      email,
      claimCode,
      label,
      bridgeUrl,
      fetchImpl: fetch,
    });
    console.log(`> redirect chain (${chain.length} hops):`);
    for (const u of chain) console.log(`    ${redact(u)}`);
    console.log(`PASS: landed on ${landing.pathname} with claim_code=${landing.claimCode}`);
    if (bridgeState) console.log('PASS: bridge transitioned to paired');
    emit({ pass: true, finalUrl: redact(landing.url), pathname: landing.pathname, claimCode: landing.claimCode, bridgeState });
    console.log('\nOK: pair-flow verified end-to-end');
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
