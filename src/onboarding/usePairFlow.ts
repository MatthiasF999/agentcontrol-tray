import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import {
  bridgePairState,
  getMachineLabel,
  listenForPairTokens,
  openPairInstallerSignIn,
  type PairTokens,
  pushPairToBridge,
  restartBridgeService,
  waitForClaimCode,
  writePairEnv,
} from './api';
import type { Action } from './state';

// Phase 65 — the operator-portal deep link is the primary completion signal.
// If the browser never opens the custom scheme, fall back to polling the
// bridge's own pair-state for 5 minutes before giving up to manual instructions.
const DEEP_LINK_TIMEOUT_MS = 60_000;
const FALLBACK_POLL_MS = 5_000;
const FALLBACK_DEADLINE_MS = 5 * 60_000;

// v0.7.12 — how long `bootstrap` waits for the bridge to answer /pair at all
// before committing to the fresh-install branch. Covers the tray-wins-the-race
// window after a reboot / a fresh install (measured: bridge unit became active
// ~24s after tray start).
const READY_POLL_MS = 1_000;
const READY_DEADLINE_MS = 60_000;

export type PairPhase =
  | 'preparing'
  | 'waiting'
  | 'finishing'
  | 'fallback'
  | 'manual';

const asMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Setters {
  setPhase: (p: PairPhase) => void;
  setError: (e: string | null) => void;
  setClaimCode: (c: string) => void;
  setLabel: (l: string) => void;
}

interface PairCtx {
  distro: string;
  dispatch: Dispatch<Action>;
  ui: Setters;
  label: string;
  settled: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  listener: Promise<() => void> | null;
}

function clearTimers(ctx: PairCtx): void {
  for (const t of ctx.timers) clearTimeout(t);
  ctx.timers.clear();
}

function later(ctx: PairCtx, fn: () => void, ms: number): void {
  const t = setTimeout(() => {
    ctx.timers.delete(t);
    fn();
  }, ms);
  ctx.timers.add(t);
}

/**
 * Hand the minted identity to the bridge. Primary path is the in-process
 * `/admin/pair` push (no restart); if the bridge HTTP surface is unreachable
 * we fall back to the legacy `.env`-write + service restart so pairing still
 * completes.
 */
async function applyPairing(
  distro: string,
  tokens: PairTokens,
  label: string,
): Promise<void> {
  try {
    await pushPairToBridge(distro, tokens, label);
  } catch {
    await writePairEnv(
      distro,
      tokens.refresh_token,
      tokens.bridge_id,
      tokens.org_id,
      tokens.lan_api_key,
    );
    await restartBridgeService(distro);
  }
}

function advance(ctx: PairCtx): void {
  ctx.settled = true;
  clearTimers(ctx);
  ctx.dispatch({ type: 'SET_PAIRED', paired: true });
  ctx.dispatch({ type: 'SCREEN', screen: 'claudeauth' });
}

function onTokens(ctx: PairCtx, tokens: PairTokens): void {
  if (ctx.settled) return;
  ctx.settled = true;
  clearTimers(ctx);
  ctx.ui.setPhase('finishing');
  ctx.ui.setError(null);
  applyPairing(ctx.distro, tokens, ctx.label)
    .then(() => advance(ctx))
    .catch((e) => {
      ctx.settled = false;
      ctx.ui.setError(asMsg(e));
      ctx.ui.setPhase('waiting');
    });
}

function scheduleFallbackTick(ctx: PairCtx, deadline: number): void {
  if (ctx.settled) return;
  if (Date.now() >= deadline) {
    ctx.ui.setPhase('manual');
    return;
  }
  const again = () =>
    later(ctx, () => scheduleFallbackTick(ctx, deadline), FALLBACK_POLL_MS);
  bridgePairState()
    .then((state) => {
      if (ctx.settled) return;
      if (state === 'paired') advance(ctx);
      else again();
    })
    .catch(again);
}

function startFallbackPoll(ctx: PairCtx): void {
  if (ctx.settled) return;
  ctx.ui.setPhase('fallback');
  scheduleFallbackTick(ctx, Date.now() + FALLBACK_DEADLINE_MS);
}

/** Sleep on a ctx-tracked timer, so unmount/retry cancels the pending wait. */
function delay(ctx: PairCtx, ms: number): Promise<void> {
  return new Promise((resolve) => later(ctx, resolve, ms));
}

/**
 * Poll `/pair` until the bridge answers *at all*, then report which branch
 * bootstrap should take.
 *
 * The tray can autostart after a reboot — or launch straight after install —
 * before the bridge's `systemd --user` unit is listening. A one-shot probe then
 * reads 'unreachable', which is indistinguishable from 'unpaired' at the branch
 * point, so the flow fell through to `waitForClaimCode`. But the bridge comes up
 * ALREADY PAIRED, and a paired `/pair` body has no `code` field — so that wait
 * could only ever run out its 30s and dead-end with the browser never opening.
 *
 * Waiting for reachability first makes the branch decision on the bridge's real
 * state. Past the deadline we fall through to the claim-code path anyway, which
 * preserves the previous behaviour for a bridge that is genuinely down.
 */
async function resolveInitialState(
  ctx: PairCtx,
): Promise<'paired' | 'unpaired'> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (!ctx.settled) {
    const state = await bridgePairState().catch(() => 'unreachable');
    if (state === 'paired') return 'paired';
    if (state !== 'unreachable') return 'unpaired';
    if (Date.now() >= deadline) return 'unpaired';
    await delay(ctx, READY_POLL_MS);
  }
  return 'unpaired';
}

async function bootstrap(ctx: PairCtx): Promise<void> {
  ctx.ui.setError(null);
  ctx.ui.setPhase('preparing');
  try {
    // Bridge already paired (re-running the wizard against a bridge set up on
    // a previous launch, or one that finished booting mid-wait) — auto-pass
    // this step instead of re-minting a claim code and re-prompting sign-in.
    if ((await resolveInitialState(ctx)) === 'paired') {
      advance(ctx);
      return;
    }
    // Tokens can land via the deep-link listener while we were waiting.
    if (ctx.settled) return;
    const code = await waitForClaimCode(ctx.distro);
    ctx.label = await getMachineLabel();
    ctx.ui.setLabel(ctx.label);
    ctx.ui.setClaimCode(code);
    ctx.ui.setPhase('waiting');
    await openPairInstallerSignIn(code, ctx.label);
    later(ctx, () => startFallbackPoll(ctx), DEEP_LINK_TIMEOUT_MS);
  } catch (e) {
    ctx.ui.setError(asMsg(e));
  }
}

export interface PairFlow {
  phase: PairPhase;
  error: string | null;
  claimCode: string;
  label: string;
  retry: () => void;
}

export function usePairFlow(
  distro: string,
  dispatch: Dispatch<Action>,
): PairFlow {
  const [phase, setPhase] = useState<PairPhase>('preparing');
  const [error, setError] = useState<string | null>(null);
  const [claimCode, setClaimCode] = useState('');
  const [label, setLabel] = useState('');
  const ctxRef = useRef<PairCtx | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    const ctx: PairCtx = {
      distro,
      dispatch,
      ui: { setPhase, setError, setClaimCode, setLabel },
      label: '',
      settled: false,
      timers: new Set(),
      listener: null,
    };
    ctxRef.current = ctx;
    ctx.listener = listenForPairTokens((t) => onTokens(ctx, t));
    void bootstrap(ctx);
    return () => {
      clearTimers(ctx);
      void ctx.listener?.then((fn) => fn());
    };
  }, []);

  const retry = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.settled = false;
    clearTimers(ctx);
    void bootstrap(ctx);
  }, []);

  return { phase, error, claimCode, label, retry };
}
