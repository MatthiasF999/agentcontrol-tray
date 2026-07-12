import { openPairInstallerSignIn } from '../api';
import type { ScreenProps } from '../state';
import { type PairFlow, type PairPhase, usePairFlow } from '../usePairFlow';

const STATUS: Record<PairPhase, string> = {
  preparing: 'Preparing…',
  waiting: 'Waiting for sign-in…',
  finishing: 'Finishing pairing…',
  fallback: 'Still waiting — checking the bridge directly…',
  manual: 'Sign-in is taking longer than expected.',
};

function ManualHint({ flow }: { flow: PairFlow }) {
  return (
    <div className="step-hint">
      <p>
        We didn't hear back from the browser. Finish signing in in your browser
        — pairing completes automatically once it does.
      </p>
      <button
        type="button"
        className="text-link"
        onClick={() => void openPairInstallerSignIn(flow.claimCode, flow.label)}
      >
        Reopen sign-in page
      </button>
    </div>
  );
}

function PairActions({ flow, onSkip }: { flow: PairFlow; onSkip: () => void }) {
  const busy = flow.phase === 'finishing';
  return (
    <footer className="step-actions">
      {flow.error ? (
        <button
          type="button"
          className="pill pill-primary"
          onClick={flow.retry}
        >
          Retry
        </button>
      ) : null}
      <button
        type="button"
        className="text-link"
        onClick={onSkip}
        disabled={busy}
      >
        Skip for now
      </button>
    </footer>
  );
}

export function Pair({ state, dispatch }: ScreenProps) {
  const { distro } = state.install;
  const flow = usePairFlow(distro, dispatch);
  const skip = () => dispatch({ type: 'SCREEN', screen: 'claudeauth' });

  return (
    <section className="step">
      <span className="step-eyebrow">Pair bridge</span>
      <h1 className="step-title">Pair with your organization</h1>
      <p className="step-intro">
        We opened the AgentControl portal in your browser. Sign in and approve
        this bridge there — pairing finishes automatically.
      </p>

      {flow.claimCode ? (
        <div className="key-box">
          <span className="step-hint">Claim code</span>
          <code className="key-value">{flow.claimCode}</code>
        </div>
      ) : null}

      {flow.error ? (
        <div className="step-error-banner">{flow.error}</div>
      ) : flow.phase === 'manual' ? (
        <ManualHint flow={flow} />
      ) : (
        <p className="step-hint">{STATUS[flow.phase]}</p>
      )}

      <PairActions flow={flow} onSkip={skip} />
    </section>
  );
}
