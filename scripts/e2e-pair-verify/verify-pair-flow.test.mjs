#!/usr/bin/env node
/**
 * Unit coverage for verify-pair-flow.mjs. No network, no Supabase — the admin
 * client and fetch are mocked. The centerpiece test proves the assertion
 * FAILS on the dogfood regression (magic-link lands on the SITE_URL fallback
 * → SPA inbox) and PASSES when the pair-bridge callback is honored.
 *
 *   node --test scripts/e2e-pair-verify/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertPairLanding,
  buildRedirectTo,
  followRedirects,
  parseLanding,
  pollBridgePaired,
  runVerification,
} from './verify-pair-flow.mjs';

const APP = 'https://app.agent-control.io';
const API = 'https://api.agent-control.io';
const CLAIM = 'AB12-CD34';
const ACTION_LINK = `${API}/auth/v1/verify?token=tok123&type=magiclink&redirect_to=${encodeURIComponent(`${APP}/pair-bridge/?claim_code=${CLAIM}&label=e2e`)}`;

// A fetch double keyed on URL prefix. Each entry returns a Response-ish object.
function makeFetch(routes) {
  return async (url) => {
    for (const [prefix, res] of routes) {
      if (url.startsWith(prefix)) return typeof res === 'function' ? res(url) : res;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}
const redirect = (location) => ({ status: 303, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) } });
const ok = () => ({ status: 200, headers: { get: () => null } });
const json = (obj) => ({ status: 200, headers: { get: () => null }, json: async () => obj });

// GoTrue honors redirect_to: verify → 303 pair-bridge callback → 200.
const GOOD_FLOW = () =>
  makeFetch([
    [`${API}/auth/v1/verify`, redirect(`${APP}/pair-bridge/?claim_code=${CLAIM}&label=e2e#access_token=xyz&refresh_token=rt`)],
    [`${APP}/pair-bridge/`, ok()],
  ]);

// The dogfood bug: redirect_to not allow-listed → GoTrue falls back to
// SITE_URL (app root); the SPA then routes the authed user to /Main/inbox.
const BROKEN_FLOW = () =>
  makeFetch([
    [`${API}/auth/v1/verify`, redirect(`${APP}/#access_token=xyz&refresh_token=rt`)],
    [`${APP}/`, ok()],
  ]);

const mockAdmin = { auth: { admin: { generateLink: async () => ({ data: { properties: { action_link: ACTION_LINK } }, error: null }) } } };

test('buildRedirectTo targets the pair-bridge callback with claim + label', () => {
  const u = buildRedirectTo(APP, CLAIM, 'my box');
  assert.equal(u, `${APP}/pair-bridge/?claim_code=AB12-CD34&label=my%20box`);
  assert.equal(buildRedirectTo(`${APP}/`, CLAIM, 'x'), `${APP}/pair-bridge/?claim_code=AB12-CD34&label=x`);
});

test('parseLanding extracts pathname, claim_code, and implicit tokens', () => {
  const l = parseLanding(`${APP}/pair-bridge/?claim_code=${CLAIM}#access_token=aaa&refresh_token=bbb`);
  assert.equal(l.pathname, '/pair-bridge/');
  assert.equal(l.claimCode, CLAIM);
  assert.equal(l.accessToken, 'aaa');
  assert.equal(l.refreshToken, 'bbb');
});

test('followRedirects walks the chain and preserves the hash fragment', async () => {
  const { finalUrl, chain, status } = await followRedirects(ACTION_LINK, GOOD_FLOW());
  assert.equal(status, 200);
  assert.equal(chain.length, 2);
  assert.ok(finalUrl.startsWith(`${APP}/pair-bridge/`));
  assert.ok(finalUrl.includes('access_token=xyz'));
});

test('assertPairLanding PASSES on the honored pair-bridge callback', () => {
  const landing = assertPairLanding(`${APP}/pair-bridge/?claim_code=${CLAIM}`, CLAIM);
  assert.equal(landing.claimCode, CLAIM);
});

test('assertPairLanding CATCHES the SITE_URL fallback (the dogfood regression)', () => {
  assert.throws(
    () => assertPairLanding(`${APP}/#access_token=xyz`, CLAIM),
    (e) => /pair-flow regression/.test(e.message) && /pair-bridge/.test(e.message) && /inbox/.test(e.message),
  );
});

test('assertPairLanding CATCHES a dropped claim_code', () => {
  assert.throws(
    () => assertPairLanding(`${APP}/pair-bridge/`, CLAIM),
    /claim_code lost/,
  );
});

test('runVerification resolves for the honored flow', async () => {
  const { landing } = await runVerification({ admin: mockAdmin, fetchImpl: GOOD_FLOW(), appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM });
  assert.equal(landing.pathname, '/pair-bridge/');
  assert.equal(landing.claimCode, CLAIM);
});

test('runVerification REJECTS for the broken flow — the test would have caught today bug', async () => {
  await assert.rejects(
    runVerification({ admin: mockAdmin, fetchImpl: BROKEN_FLOW(), appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM }),
    /pair-flow regression/,
  );
});

test('pollBridgePaired returns paired once state flips', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ state: calls >= 2 ? 'paired' : 'unpaired' });
  };
  const state = await pollBridgePaired('http://127.0.0.1:3001/pair', fetchImpl, 1000, 5);
  assert.equal(state, 'paired');
});

test('pollBridgePaired reports last state on timeout', async () => {
  const fetchImpl = async () => json({ state: 'unpaired' });
  const state = await pollBridgePaired('http://127.0.0.1:3001/pair', fetchImpl, 20, 5);
  assert.equal(state, 'unpaired');
});
