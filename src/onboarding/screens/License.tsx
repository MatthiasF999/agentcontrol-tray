import { openUrl } from '@tauri-apps/plugin-opener';
import { OPERATOR_URL } from '../../config/hetzner';
import type { ScreenProps } from '../state';

const TERMS_URL = `${OPERATOR_URL}/legal/terms`;

export function License({ state, dispatch }: ScreenProps) {
  const accepted = state.licenseAccepted;
  return (
    <section className="step">
      <span className="step-eyebrow">License</span>
      <h1 className="step-title">Terms of use</h1>
      <p className="step-intro">
        AgentControl is provided under its software license. The Bridge runs
        agents that can read and modify code on this machine — review the terms
        before continuing.
      </p>
      <button
        type="button"
        className="text-link"
        onClick={() => void openUrl(TERMS_URL)}
      >
        Read the full terms
      </button>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) =>
            dispatch({ type: 'SET_LICENSE', accepted: e.target.checked })
          }
        />
        <span>I have read and accept the terms of use</span>
      </label>
      <footer className="step-actions">
        <button
          type="button"
          className="pill pill-ghost"
          onClick={() => dispatch({ type: 'SCREEN', screen: 'welcome' })}
        >
          Back
        </button>
        <button
          type="button"
          className="pill pill-primary"
          disabled={!accepted}
          onClick={() => dispatch({ type: 'SCREEN', screen: 'syscheck' })}
        >
          Continue
        </button>
      </footer>
    </section>
  );
}
