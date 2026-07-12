#!/usr/bin/env node
/**
 * Unit coverage for verify-pair-flow.mjs. No network, no Supabase — the
 * link generator and fetch are mocked. The centerpiece proves the assertion
 * FAILS on the dogfood regression (magic-link lands on the SITE_URL fallback
 * → SPA inbox) and PASSES when the pair-bridge callback is honored.
 *
 *   node --test 'scripts/e2e-pair-verify/*.test.mjs'
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertPairLanding,
  buildRedirectTo,
  followRedirects,
  generateMagicLink,
  loadEnvFile,
  parseLanding,
  pollBridgePaired,
  redact,
  runVerification,
} from './verify-pair-flow.mjs';

const APP = 'https://app.agent-control.io';
const API = 'https://api.agent-control.io';
const CLAIM = 'AB12-CD34';
const ACTION_LINK = `${API}/auth/v1/verify?token=tok123&type=magiclink`;

// A fetch double keyed on URL prefix. Each entry returns a Response-ish object.
function makeFetch(routes) {
  return async (url) => {
    for (const [prefix, res] of routes) {
      if (url.startsWith(prefix)) return typeof res === 'function' ? res(url) : res;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}
const redirectRes = (location) => ({ status: 303, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) } });
const okRes = () => ({ status: 200, headers: { get: () => null } });
const jsonRes = (obj, status = 200) => ({ status, headers: { get: () => null }, json: async () => obj });

// GoTrue honors redirect_to: verify → 303 pair-bridge callback → 200.
const GOOD_FLOW = () =>
  makeFetch([
    [`${API}/auth/v1/verify`, redirectRes(`${APP}/pair-bridge/?claim_code=${CLAIM}&label=e2e#access_token=xyz&refresh_token=rt`)],
    [`${APP}/pair-bridge/`, okRes()],
  ]);

// The dogfood bug: redirect_to not allow-listed → GoTrue falls back to
// SITE_URL (app root); the SPA then routes the authed user to /Main/inbox.
const BROKEN_FLOW = () =>
  makeFetch([
    [`${API}/auth/v1/verify`, redirectRes(`${APP}/#access_token=xyz&refresh_token=rt`)],
    [`${APP}/`, okRes()],
  ]);

const genOk = async () => ACTION_LINK;

test('buildRedirectTo targets the pair-bridge callback with claim + label', () => {
  assert.equal(buildRedirectTo(APP, CLAIM, 'my box'), `${APP}/pair-bridge/?claim_code=AB12-CD34&label=my%20box`);
  assert.equal(buildRedirectTo(`${APP}/`, CLAIM, 'x'), `${APP}/pair-bridge/?claim_code=AB12-CD34&label=x`);
});

test('redact strips tokens from URLs', () => {
  assert.equal(redact(`${API}/verify?token=abc&type=magiclink`), `${API}/verify?token=REDACTED&type=magiclink`);
  assert.equal(redact(`${APP}/pair-bridge/#access_token=aaa&refresh_token=bbb`), `${APP}/pair-bridge/#access_token=REDACTED&refresh_token=REDACTED`);
});

test('parseLanding extracts pathname, claim_code, and implicit tokens', () => {
  const l = parseLanding(`${APP}/pair-bridge/?claim_code=${CLAIM}#access_token=aaa&refresh_token=bbb`);
  assert.equal(l.pathname, '/pair-bridge/');
  assert.equal(l.claimCode, CLAIM);
  assert.equal(l.accessToken, 'aaa');
});

test('generateMagicLink POSTs to admin/generate_link and returns action_link', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return jsonRes({ action_link: ACTION_LINK });
  };
  const link = await generateMagicLink(API, 'svcrole', { email: 'e2e@x.dev', redirectTo: `${APP}/pair-bridge/` }, fetchImpl);
  assert.equal(link, ACTION_LINK);
  assert.equal(seen.url, `${API}/auth/v1/admin/generate_link`);
  assert.equal(seen.opts.headers.apikey, 'svcrole');
  assert.equal(JSON.parse(seen.opts.body).type, 'magiclink');
  assert.equal(JSON.parse(seen.opts.body).redirect_to, `${APP}/pair-bridge/`);
});

test('generateMagicLink throws on GoTrue error status', async () => {
  const fetchImpl = async () => jsonRes({ msg: 'not allowed' }, 403);
  await assert.rejects(generateMagicLink(API, 'svc', { email: 'x', redirectTo: 'y' }, fetchImpl), /HTTP 403.*not allowed/);
});

test('followRedirects walks the chain and preserves the hash fragment', async () => {
  const { finalUrl, chain, status } = await followRedirects(ACTION_LINK, GOOD_FLOW());
  assert.equal(status, 200);
  assert.equal(chain.length, 2);
  assert.ok(finalUrl.startsWith(`${APP}/pair-bridge/`));
  assert.ok(finalUrl.includes('access_token=xyz'));
});

test('assertPairLanding PASSES on the honored pair-bridge callback', () => {
  assert.equal(assertPairLanding(`${APP}/pair-bridge/?claim_code=${CLAIM}`, CLAIM).claimCode, CLAIM);
});

test('assertPairLanding CATCHES the SITE_URL fallback (the dogfood regression)', () => {
  assert.throws(
    () => assertPairLanding(`${APP}/#access_token=xyz`, CLAIM),
    (e) => /pair-flow regression/.test(e.message) && /pair-bridge/.test(e.message) && /inbox/.test(e.message),
  );
});

test('assertPairLanding CATCHES a dropped claim_code', () => {
  assert.throws(() => assertPairLanding(`${APP}/pair-bridge/`, CLAIM), /claim_code lost/);
});

test('runVerification resolves for the honored flow', async () => {
  const { landing } = await runVerification({ generateLinkImpl: genOk, fetchImpl: GOOD_FLOW(), appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM });
  assert.equal(landing.pathname, '/pair-bridge/');
  assert.equal(landing.claimCode, CLAIM);
});

test('runVerification REJECTS for the broken flow — the test would have caught today bug', async () => {
  await assert.rejects(
    runVerification({ generateLinkImpl: genOk, fetchImpl: BROKEN_FLOW(), appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM }),
    /pair-flow regression/,
  );
});

test('pollBridgePaired returns paired once state flips', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonRes({ state: calls >= 2 ? 'paired' : 'unpaired' });
  };
  assert.equal(await pollBridgePaired('http://127.0.0.1:3001/pair', fetchImpl, 1000, 5), 'paired');
});

test('pollBridgePaired reports last state on timeout', async () => {
  assert.equal(await pollBridgePaired('http://127.0.0.1:3001/pair', async () => jsonRes({ state: 'unpaired' }), 20, 5), 'unpaired');
});

test('loadEnvFile fills only missing keys, strips quotes + comments', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pairenv-'));
  const p = join(dir, 'pair-verify.env');
  writeFileSync(p, '# comment\nSUPABASE_URL="https://api.x"\nAPP_URL=https://app.x\nKEEP=existing\n');
  const env = { KEEP: 'existing' };
  loadEnvFile(p, env);
  assert.equal(env.SUPABASE_URL, 'https://api.x');
  assert.equal(env.APP_URL, 'https://app.x');
  assert.equal(env.KEEP, 'existing');
});
