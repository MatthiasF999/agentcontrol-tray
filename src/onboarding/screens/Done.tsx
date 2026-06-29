import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';
import { OPERATOR_DOWNLOAD_URL, OPERATOR_URL } from '../../config/hetzner';
import type { ScreenProps } from '../state';

const APP_URL = OPERATOR_DOWNLOAD_URL;

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
    <section className="step">
      <span className="step-eyebrow">Done</span>
      <h1 className="step-title">Bridge installed</h1>
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

      <footer className="step-actions">
        <button
          type="button"
          className="pill pill-primary"
          onClick={onComplete}
        >
          Launch AgentControl
        </button>
      </footer>
    </section>
  );
}
