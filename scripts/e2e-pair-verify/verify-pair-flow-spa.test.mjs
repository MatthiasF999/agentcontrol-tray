#!/usr/bin/env node
/**
 * Unit coverage for verify-pair-flow-spa.mjs. No network, no Supabase, and — the
 * point of the fake browser — NO Playwright install required. The link
 * generator and a Playwright-shaped browser/page are mocked. The centerpiece
 * proves the assertion FAILS when the SPA's client-side router lands on the
 * authed inbox (the PR #41 regression shape) and PASSES when it settles on the
 * pair-bridge callback.
 *
 *   node --test 'scripts/e2e-pair-verify/*.test.mjs'
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSpaLanding,
  runSpaVerification,
} from './verify-pair-flow-spa.mjs';

const APP = 'https://app.agent-control.io';
const API = 'https://api.agent-control.io';
const CLAIM = 'AB12-CD34';
const ACTION_LINK = `${API}/auth/v1/verify?token=tok123&type=magiclink`;

/**
 * A Playwright-shaped fake. `urlSequence` is the list of URLs page.url() reports
 * across the flow; the LAST entry is the client-side URL the SPA settled on
 * (what the real assertion reads). Records goto/screenshot/close calls so tests
 * can assert the pipeline actually drove the browser.
 */
function fakeBrowser({ urlSequence, waitForUrlThrows = false } = {}) {
  const calls = { goto: [], screenshots: [], newPage: 0, closed: false, waitForUrl: 0 };
  let idx = 0;
  const seq = urlSequence ?? [`${APP}/pair-bridge/?claim_code=${CLAIM}&label=e2e`];
  const page = {
    goto: async (url) => { calls.goto.push(url); },
    // url() advances through the sequence, clamping on the final settled URL.
    url: async () => seq[Math.min(idx++, seq.length - 1)],
    waitForURL: async () => {
      calls.waitForUrl += 1;
      if (waitForUrlThrows) throw new Error('Timeout 30000ms exceeded waiting for URL');
    },
    screenshot: async ({ path }) => { calls.screenshots.push(path); },
  };
  const browser = {
    newPage: async () => { calls.newPage += 1; return page; },
    close: async () => { calls.closed = true; },
  };
  return { launchImpl: async () => browser, calls };
}

const genOk = async () => ACTION_LINK;

// ---- assertSpaLanding (the client-side-URL assertion) -----------------------

test('assertSpaLanding PASSES when the SPA settles on the pair-bridge callback', () => {
  const l = assertSpaLanding(`${APP}/pair-bridge/?claim_code=${CLAIM}`, CLAIM);
  assert.equal(l.pathname, '/pair-bridge/');
  assert.equal(l.claimCode, CLAIM);
});

test('assertSpaLanding CATCHES the SPA routing to the authed inbox (PR #41 regression)', () => {
  assert.throws(
    () => assertSpaLanding(`${APP}/Main/inbox/inbox`, CLAIM),
    (e) =>
      /SPA pair-flow regression/.test(e.message) &&
      /AuthCallbackScreen/.test(e.message) &&
      /Main\/inbox/.test(e.message),
  );
});

test('assertSpaLanding CATCHES a bare SITE_URL fallback (path /)', () => {
  assert.throws(() => assertSpaLanding(`${APP}/`, CLAIM), /SPA pair-flow regression/);
});

test('assertSpaLanding CATCHES a dropped claim_code even on the right path', () => {
  assert.throws(() => assertSpaLanding(`${APP}/pair-bridge/`, CLAIM), /claim_code lost/);
});

// ---- runSpaVerification (full pipeline over the fake browser) ---------------

test('runSpaVerification resolves for the honored client-side flow', async () => {
  const { launchImpl, calls } = fakeBrowser({
    urlSequence: [`${APP}/pair-bridge/?claim_code=${CLAIM}&label=e2e`],
  });
  const { landing, finalUrl } = await runSpaVerification({
    generateLinkImpl: genOk, launchImpl, appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM,
  });
  assert.equal(landing.pathname, '/pair-bridge/');
  assert.equal(landing.claimCode, CLAIM);
  assert.ok(finalUrl.startsWith(`${APP}/pair-bridge/`));
  // Drove the browser: opened pair screen + consumed magic link, took screenshots, closed.
  assert.equal(calls.newPage, 1);
  assert.deepEqual(calls.goto, [
    `${APP}/pair-bridge/?claim_code=${CLAIM}&label=e2e-verify`,
    ACTION_LINK,
  ]);
  assert.ok(calls.screenshots.length >= 3);
  assert.ok(calls.closed, 'browser must be closed');
});

test('runSpaVerification REJECTS when the SPA client-side-routes to the inbox (the gap HTTP verify misses)', async () => {
  const { launchImpl, calls } = fakeBrowser({
    // HTTP-level would have been green; the SPA router lands on the inbox.
    urlSequence: [`${APP}/Main/inbox/inbox`],
    waitForUrlThrows: true,
  });
  await assert.rejects(
    runSpaVerification({ generateLinkImpl: genOk, launchImpl, appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM }),
    /SPA pair-flow regression/,
  );
  assert.ok(calls.closed, 'browser must be closed even on failure');
});

test('runSpaVerification surfaces a waitForURL timeout as a descriptive assertion, not an opaque error', async () => {
  const { launchImpl } = fakeBrowser({
    urlSequence: [`${APP}/Main/inbox/inbox`],
    waitForUrlThrows: true,
  });
  await assert.rejects(
    runSpaVerification({ generateLinkImpl: genOk, launchImpl, appUrl: APP, email: 'e2e@x.dev', claimCode: CLAIM }),
    (e) => /SPA pair-flow regression/.test(e.message) && !/Timeout 30000ms/.test(e.message),
  );
});

test('runSpaVerification closes the browser when magic-link generation throws', async () => {
  const { launchImpl, calls } = fakeBrowser();
  const genBoom = async () => { throw new Error('generate_link HTTP 403'); };
  await assert.rejects(
    runSpaVerification({ generateLinkImpl: genBoom, launchImpl, appUrl: APP, claimCode: CLAIM }),
    /HTTP 403/,
  );
  // Link generation fails before launch, so the browser was never opened.
  assert.equal(calls.newPage, 0);
});

test('runSpaVerification polls the bridge and REJECTS when it never reaches paired', async () => {
  const { launchImpl } = fakeBrowser({ urlSequence: [`${APP}/pair-bridge/?claim_code=${CLAIM}`] });
  const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ state: 'unpaired' }) });
  await assert.rejects(
    runSpaVerification({
      generateLinkImpl: genOk, launchImpl, fetchImpl, appUrl: APP, claimCode: CLAIM,
      bridgeUrl: 'http://127.0.0.1:3001/pair', bridgePollTimeoutMs: 20, bridgePollStepMs: 5,
    }),
    /bridge did not reach 'paired'/,
  );
});

test('runSpaVerification resolves with bridgeState=paired when the bridge flips', async () => {
  const { launchImpl } = fakeBrowser({ urlSequence: [`${APP}/pair-bridge/?claim_code=${CLAIM}`] });
  let n = 0;
  const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ state: (n += 1) >= 2 ? 'paired' : 'unpaired' }) });
  const { bridgeState } = await runSpaVerification({
    generateLinkImpl: genOk, launchImpl, fetchImpl, appUrl: APP, claimCode: CLAIM,
    bridgeUrl: 'http://127.0.0.1:3001/pair', bridgePollTimeoutMs: 1000, bridgePollStepMs: 5,
  });
  assert.equal(bridgeState, 'paired');
});
