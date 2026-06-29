import { type Dispatch, useEffect, useRef, useState } from 'react';
import {
  getMachineLabel,
  listenForPairTokens,
  openPairInstallerSignIn,
  type PairTokens,
  restartBridgeService,
  waitForClaimCode,
  writePairEnv,
} from '../api';
import type { Action, ScreenProps } from '../state';

const asMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function bootstrap(
  distro: string,
  dispatch: Dispatch<Action>,
  setError: (e: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    const claimCode = await waitForClaimCode(distro);
    const label = await getMachineLabel();
    dispatch({ type: 'SET_SIGNIN', claimCode, label });
    await openPairInstallerSignIn(claimCode, label);
  } catch (e) {
    setError(asMsg(e));
  }
}

async function finishPairing(
  distro: string,
  tokens: PairTokens,
  dispatch: Dispatch<Action>,
  setError: (e: string | null) => void,
  setFinishing: (b: boolean) => void,
): Promise<void> {
  setFinishing(true);
  setError(null);
  try {
    await writePairEnv(
      distro,
      tokens.refresh_token,
      tokens.bridge_id,
      tokens.org_id,
      tokens.lan_api_key,
    );
    await restartBridgeService(distro);
    dispatch({ type: 'SET_PAIRED', paired: true });
    dispatch({ type: 'SCREEN', screen: 'claudeauth' });
  } catch (e) {
    setError(asMsg(e));
    setFinishing(false);
  }
}

function usePairFlow(distro: string, dispatch: Dispatch<Action>) {
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    const unlisten = listenForPairTokens((t) => {
      void finishPairing(distro, t, dispatch, setError, setFinishing);
    });
    if (!started.current) {
      started.current = true;
      void bootstrap(distro, dispatch, setError);
    }
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  return { error, finishing, setError };
}

function PairActions({
  error,
  finishing,
  onRetry,
  onSkip,
}: {
  error: string | null;
  finishing: boolean;
  onRetry: () => void;
  onSkip: () => void;
}) {
  return (
    <footer className="step-actions">
      {error ? (
        <button type="button" className="pill pill-primary" onClick={onRetry}>
          Retry
        </button>
      ) : null}
      <button
        type="button"
        className="text-link"
        onClick={onSkip}
        disabled={finishing}
      >
        Skip for now
      </button>
    </footer>
  );
}

export function Pair({ state, dispatch }: ScreenProps) {
  const { distro } = state.install;
  const { signinClaimCode } = state;
  const { error, finishing, setError } = usePairFlow(distro, dispatch);
  const skip = () => dispatch({ type: 'SCREEN', screen: 'claudeauth' });
  const status = finishing
    ? 'Finishing pairing…'
    : signinClaimCode
      ? 'Waiting for sign-in…'
      : 'Preparing…';

  return (
    <section className="step">
      <span className="step-eyebrow">Pair bridge</span>
      <h1 className="step-title">Pair with your organization</h1>
      <p className="step-intro">
        We opened the AgentControl portal in your browser. Sign in and approve
        this bridge there — pairing finishes automatically.
      </p>

      {signinClaimCode ? (
        <div className="key-box">
          <span className="step-hint">Claim code</span>
          <code className="key-value">{signinClaimCode}</code>
        </div>
      ) : null}

      {error ? (
        <div className="step-error-banner">{error}</div>
      ) : (
        <p className="step-hint">{status}</p>
      )}

      <PairActions
        error={error}
        finishing={finishing}
        onRetry={() => void bootstrap(distro, dispatch, setError)}
        onSkip={skip}
      />
    </section>
  );
}
