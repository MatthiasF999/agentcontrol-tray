import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';
import type { ScreenProps } from '../state';

const OPERATOR_URL = 'https://178.105.244.59/operator';
const APP_URL = 'https://178.105.244.59/operator/download';

function DoneLinks() {
  return (
    <ul className="link-list">
      <li>
        <button
          type="button"
          className="link"
          onClick={() => void openUrl(OPERATOR_URL)}
        >
          Open the operator portal
        </button>
      </li>
      <li>
        <button
          type="button"
          className="link"
          onClick={() => void openUrl(APP_URL)}
        >
          Download the AgentControl app
        </button>
      </li>
    </ul>
  );
}

export function Done({ state, onComplete }: ScreenProps) {
  const { apiKey } = state;
  const { paired } = state.install;
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="screen">
      <h1>Bridge installed</h1>
      <p className="step-ok">
        The bridge is installed and running as a systemd-user service. Keep your
        API key somewhere safe — you need it for the first AgentControl sign-in:
      </p>
      <div className="key-box">
        <code className="key-value">{apiKey || '(no key generated)'}</code>
        <button type="button" onClick={copyKey} disabled={!apiKey}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {paired ? (
        <p className="step-ok">Bridge paired with your AgentControl org.</p>
      ) : (
        <p className="step-hint">
          Not paired yet — you can pair this bridge later from the operator
          portal.
        </p>
      )}

      <DoneLinks />

      <footer className="actions">
        <button type="button" className="btn-primary" onClick={onComplete}>
          Open AgentControl
        </button>
      </footer>
    </section>
  );
}
