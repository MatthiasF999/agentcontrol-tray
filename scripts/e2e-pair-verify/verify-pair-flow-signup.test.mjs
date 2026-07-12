#!/usr/bin/env node
/**
 * Unit coverage for verify-pair-flow-signup.mjs. No network, no Supabase, and —
 * the point of the fake browser — NO Playwright install required. The centerpiece
 * proves the pipeline drives the SPA's OWN email form (captures the redirect_to
 * the SPA built) and completes the real recovery round-trip, and that a
 * cross-origin / missing redirect_to (the silent-drop the admin-forced verifiers
 * cannot see) FAILS loudly. Also pins signup-user teardown + OTP-path skip.
 *
 *   node --test 'scripts/e2e-pair-verify/*.test.mjs'
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSpaRedirectTo,
  authCallbackUrl,
  buildPairUrl,
  runSignupVerification,
} from './verify-pair-flow-signup.mjs';

const APP = 'https://app.agent-control.io';
const CALLBACK = `${APP}/auth/callback`;

/**
 * A Playwright-shaped fake. `settleUrl` is the client-side URL the SPA settles
 * on after the round-trip (what the assertion reads). `otpRedirect` is the
 * redirect_to the fake reports on the intercepted /auth/v1/otp request. Set
 * `hasOtpInput` to expose the in-tab OTP input for the otp path.
 */
function fakeBrowser({ settleUrl, otpRedirect = CALLBACK, hasOtpInput = false, formPresent = true } = {}) {
  const calls = { goto: [], newPage: 0, closed: false, filled: [], pressed: [] };
  function makePage() {
    let settled = false;
    let claim = 'UNSET';
    const page = {
      goto: async (url) => {
        calls.goto.push(url);
        const c = new URL(url).searchParams.get('claim_code');
        if (c) claim = c; // the pair-bridge open call carries the run's claim
        if (url.includes('/auth/verify') || url.includes('/auth/v1/verify') || url.includes('email_otp')) settled = true;
      },
      url: async () => (settled ? settleUrl(claim) : buildPairUrl(APP, claim, 'x')),
      waitForURL: async () => { settled = true; },
      waitForRequest: async (pred) => {
        const u = `${APP.replace('app.', 'api.')}/auth/v1/otp?redirect_to=${encodeURIComponent(otpRedirect)}`;
        return pred({ url: () => u }) ? { url: () => u } : null;
      },
      screenshot: async () => {},
      locator: (sel) => ({
        waitFor: async () => {
          const ok = sel.includes('pair-email-input') ? formPresent
            : sel.includes('otp') || sel.includes('one-time-code') || sel.includes('numeric') ? hasOtpInput : true;
          if (!ok) throw new Error('not found');
        },
        fill: async (v) => { calls.filled.push([sel, v]); },
        press: async (k) => { calls.pressed.push([sel, k]); if (sel.includes('otp')) settled = true; },
        click: async () => {},
      }),
    };
    return page;
  }
  return {
    launchImpl: async () => ({
      newPage: async () => { calls.newPage += 1; return makePage(); },
      close: async () => { calls.closed = true; },
    }),
    calls,
  };
}

// Settle helpers keyed off the claim the page opened with (read from goto[0]).
const settlePair = () => (claim) => `${APP}/pair-bridge/?claim_code=${claim}&label=x`;
const settleInbox = () => () => `${APP}/Main/inbox/inbox`;
const mintOk = async () => ({ actionLink: `${APP.replace('app.', 'api.')}/auth/v1/verify?token=t`, emailOtp: '123456', userId: 'user-123' });

// ---- pure assertion helpers -------------------------------------------------

test('assertSpaRedirectTo PASSES for a same-origin /auth/callback', () => {
  const r = assertSpaRedirectTo(CALLBACK, APP);
  assert.equal(r.pathname, '/auth/callback');
});

test('assertSpaRedirectTo PASSES for a same-origin /pair-bridge redirect (post-fix shape)', () => {
  assert.doesNotThrow(() => assertSpaRedirectTo(`${APP}/pair-bridge/?claim_code=AB12`, APP));
});

test('assertSpaRedirectTo CATCHES a missing redirect_to (silent SITE_URL fallback)', () => {
  assert.throws(() => assertSpaRedirectTo(null, APP), /NO redirect_to/);
});

test('assertSpaRedirectTo CATCHES a cross-origin redirect_to (GoTrue would reject → drop claim)', () => {
  assert.throws(() => assertSpaRedirectTo('https://evil.example/auth/callback', APP), /origin/);
});

test('authCallbackUrl + buildPairUrl build the expected URLs', () => {
  assert.equal(authCallbackUrl(APP), CALLBACK);
  assert.match(buildPairUrl(APP, 'AB12-CD34', 'my box'), /\/pair-bridge\/\?claim_code=AB12-CD34&label=my%20box/);
});

// ---- runSignupVerification (full pipeline over the fake browser) ------------

test('signin path drives the SPA form + completes the recovery round-trip', async () => {
  const { launchImpl, calls } = fakeBrowser({ settleUrl: settlePair() });
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signin'],
    launchImpl, mintImpl: mintOk,
  });
  assert.equal(pass, true);
  assert.equal(paths[0].status, 'pass');
  assert.equal(paths[0].pathname, '/pair-bridge/');
  // Drove the real form: filled the email input + submitted, then consumed the callback.
  assert.ok(calls.filled.some(([s]) => s.includes('pair-email-input')));
  assert.ok(calls.goto.some((u) => u.includes('/auth/v1/verify')), 'must consume the magic-link callback');
  assert.ok(calls.closed);
});

test('signin path FAILS when the SPA client-side-routes to the inbox (the gap the admin-forced tests miss)', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settleInbox() });
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signin'], launchImpl, mintImpl: mintOk,
  });
  assert.equal(pass, false);
  assert.equal(paths[0].status, 'fail');
  assert.match(paths[0].error, /SPA pair-flow regression/);
});

test('signin path FAILS loudly when the SPA sends a cross-origin redirect_to', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settlePair(), otpRedirect: 'https://evil.example/auth/callback' });
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signin'], launchImpl, mintImpl: mintOk,
  });
  assert.equal(pass, false);
  assert.match(paths[0].error, /origin/);
});

test('signup path deletes its throwaway user in the finally block', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settlePair() });
  const deleted = [];
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signup'],
    launchImpl, mintImpl: mintOk, precreateImpl: async () => 'pre-123',
    deleteImpl: async (id) => deleted.push(id),
  });
  assert.equal(pass, true);
  assert.equal(paths[0].status, 'pass');
  assert.deepEqual(deleted, ['user-123'], 'the created signup user must be torn down');
  assert.match(paths[0].email, /signup-\d+/, 'signup path uses a fresh throwaway email');
});

test('signup path pre-creates the throwaway user BEFORE the form (closed-signup gate)', async () => {
  const { launchImpl, calls } = fakeBrowser({ settleUrl: settlePair() });
  const precreated = [];
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signup'],
    launchImpl, mintImpl: mintOk,
    precreateImpl: async (email) => { precreated.push(email); return 'pre-123'; },
    deleteImpl: async () => {},
  });
  assert.equal(pass, true);
  assert.equal(paths[0].status, 'pass');
  assert.equal(precreated.length, 1, 'signup admits the email via one admin pre-create');
  assert.match(precreated[0], /signup-\d+.*@/, 'pre-creates the fresh signup email');
  // Only after admitting the email does the SPA form run.
  assert.ok(calls.filled.some(([s]) => s.includes('pair-email-input')));
});

test('signin path does NOT pre-create a user (only signup needs the gate primed)', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settlePair() });
  const precreated = [];
  await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signin'],
    launchImpl, mintImpl: mintOk, precreateImpl: async (e) => { precreated.push(e); return 'x'; },
  });
  assert.deepEqual(precreated, [], 'seeded existing user must not be pre-created');
});

test('signup path tears down the pre-created user even when the form is absent (skip)', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settlePair(), formPresent: false });
  const deleted = [];
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signup'],
    launchImpl, mintImpl: mintOk, precreateImpl: async () => 'pre-123',
    deleteImpl: async (id) => deleted.push(id),
  });
  assert.equal(pass, true);
  assert.equal(paths[0].status, 'skip');
  assert.deepEqual(deleted, ['pre-123'], 'the pre-created user is cleaned up via the fallback id');
});

test('otp path SKIPS (not fails) when the in-tab OTP input is absent from the deployed SPA', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settlePair(), hasOtpInput: false });
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['otp'], launchImpl, mintImpl: mintOk,
  });
  assert.equal(pass, true, 'a missing sibling-PR UI must not fail the suite');
  assert.equal(paths[0].status, 'skip');
  assert.match(paths[0].reason, /OTP input not present/);
});

test('otp path PASSES when the in-tab OTP input is present + code verifies to /pair-bridge', async () => {
  const { launchImpl, calls } = fakeBrowser({ settleUrl: settlePair(), hasOtpInput: true });
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['otp'], launchImpl, mintImpl: mintOk,
  });
  assert.equal(pass, true);
  assert.equal(paths[0].status, 'pass');
  assert.ok(calls.filled.some(([s, v]) => s.includes('otp') && v === '123456'), 'must type the 6-digit OTP');
});

test('the whole suite SKIPS gracefully on an offline build (pair form absent)', async () => {
  const { launchImpl } = fakeBrowser({ settleUrl: settlePair(), formPresent: false });
  const { pass, paths } = await runSignupVerification({
    appUrl: APP, seededEmail: 'seed@agentcontrol.dev', paths: ['signin', 'signup'], launchImpl, mintImpl: mintOk,
  });
  assert.equal(pass, true);
  assert.ok(paths.every((r) => r.status === 'skip'));
});
