import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePairFlow } from './usePairFlow';

// `vi.mock` is hoisted above the imports, so the stubs it closes over have to
// be created inside `vi.hoisted` rather than as plain module-level consts.
const api = vi.hoisted(() => ({
  bridgePairState: vi.fn(),
  getMachineLabel: vi.fn(),
  listenForPairTokens: vi.fn(),
  openPairInstallerSignIn: vi.fn(),
  pushPairToBridge: vi.fn(),
  restartBridgeService: vi.fn(),
  waitForClaimCode: vi.fn(),
  writePairEnv: vi.fn(),
}));
vi.mock('./api', () => api);

const CLAIM_CODE_TIMEOUT =
  'bridge did not expose a claim code on /pair within 30s';

const SET_PAIRED = { type: 'SET_PAIRED', paired: true };
const GO_CLAUDEAUTH = { type: 'SCREEN', screen: 'claudeauth' };

/** Let the mount effect's async bootstrap run through `ms` of poll ticks. */
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.listenForPairTokens.mockResolvedValue(() => {});
  api.getMachineLabel.mockResolvedValue('DESKTOP-TEST');
  api.openPairInstallerSignIn.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePairFlow bootstrap — bridge-readiness race', () => {
  it('advances once a late-starting bridge answers /pair as already paired', async () => {
    // Reboot / post-install autostart: the tray wins the race against the
    // bridge's `systemd --user` unit, so the first probes see nothing. The
    // bridge then comes up ALREADY PAIRED — and a paired /pair body carries
    // no `code`, so falling through to waitForClaimCode can only ever time
    // out (the pre-fix behaviour this test pins down).
    api.bridgePairState
      .mockResolvedValueOnce('unreachable')
      .mockResolvedValueOnce('unreachable')
      .mockResolvedValue('paired');
    api.waitForClaimCode.mockRejectedValue(new Error(CLAIM_CODE_TIMEOUT));
    const dispatch = vi.fn();

    const { result } = renderHook(() => usePairFlow('Ubuntu-24.04', dispatch));
    await tick(5_000);

    expect(api.waitForClaimCode).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(SET_PAIRED);
    expect(dispatch).toHaveBeenCalledWith(GO_CLAUDEAUTH);
    expect(result.current.error).toBeNull();
  });
});

describe('usePairFlow bootstrap — unpaired paths', () => {
  it('still mints a claim code when a reachable bridge reports unpaired', async () => {
    // Fresh install: the bridge is up and genuinely unpaired — the readiness
    // wait must not swallow the claim-code path.
    api.bridgePairState.mockResolvedValue('unpaired');
    api.waitForClaimCode.mockResolvedValue('AB12-CD34');
    const dispatch = vi.fn();

    const { result } = renderHook(() => usePairFlow('Ubuntu-24.04', dispatch));
    await tick(1_000);

    expect(api.bridgePairState).toHaveBeenCalledTimes(1);
    expect(api.waitForClaimCode).toHaveBeenCalledWith('Ubuntu-24.04');
    expect(api.openPairInstallerSignIn).toHaveBeenCalledWith(
      'AB12-CD34',
      'DESKTOP-TEST',
    );
    expect(dispatch).not.toHaveBeenCalledWith(SET_PAIRED);
    expect(result.current.claimCode).toBe('AB12-CD34');
    expect(result.current.phase).toBe('waiting');
  });

  it('gives up the readiness wait at the deadline and tries the claim code', async () => {
    // Bridge never comes up: best-effort fall-through preserves the old
    // behaviour (surface the claim-code error) rather than hanging forever.
    api.bridgePairState.mockResolvedValue('unreachable');
    api.waitForClaimCode.mockRejectedValue(new Error(CLAIM_CODE_TIMEOUT));
    const dispatch = vi.fn();

    const { result } = renderHook(() => usePairFlow('Ubuntu-24.04', dispatch));
    await tick(70_000);

    expect(api.waitForClaimCode).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalledWith(SET_PAIRED);
    expect(result.current.error).toBe(CLAIM_CODE_TIMEOUT);
  });
});
