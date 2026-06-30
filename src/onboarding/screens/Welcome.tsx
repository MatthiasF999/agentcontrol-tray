import type { ScreenProps } from '../state';

const FEATURES = [
  'Run autonomous Claude Code agents on your own machine',
  'Drive multi-step engineering work from your phone or browser',
  'Self-hosted — your code and tokens never leave your infrastructure',
];

export function Welcome({ dispatch }: ScreenProps) {
  return (
    <section className="step">
      <span className="step-eyebrow">Welcome</span>
      <h1 className="step-title">Set up AgentControl Bridge</h1>
      <p className="step-intro">
        The Bridge turns this machine into an autonomous agent host. In a few
        minutes we'll install everything it needs and pair it with your
        AgentControl organization.
      </p>
      <ul className="feature-list">
        {FEATURES.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <footer className="step-actions">
        <button
          type="button"
          className="pill pill-primary"
          onClick={() => dispatch({ type: 'SCREEN', screen: 'license' })}
        >
          Get started
        </button>
      </footer>
    </section>
  );
}
