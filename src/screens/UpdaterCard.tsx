import { useState } from 'react';
import {
  checkForUpdate,
  installAndRestart,
  type UpdateState,
} from '../lib/updater';

export function UpdaterCard() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(): Promise<void> {
    setBusy('check');
    setError(null);
    try {
      const next = await checkForUpdate();
      setState(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function install(): Promise<void> {
    if (state?.raw === undefined) return;
    setBusy('install');
    setError(null);
    try {
      await installAndRestart(state.raw);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2>App updates</h2>
      <p className="muted">
        Pull-based check against the configured release endpoint. Signing key in{' '}
        <code>tauri.conf.json</code> needs operator-action — see{' '}
        <code>docs/PHASE-27-7-AUTOUPDATE.md</code>.
      </p>
      <button
        type="button"
        onClick={() => void check()}
        disabled={busy !== null}
      >
        {busy === 'check' ? 'Checking…' : 'Check for updates'}
      </button>
      {error !== null && <div className="error">{error}</div>}
      {state !== null && !state.available && (
        <p className="muted">No updates available.</p>
      )}
      {state !== null && state.available && (
        <div>
          <p>
            Update available: <code>{state.current}</code> →{' '}
            <code>{state.latest}</code>
          </p>
          {state.publishedAt !== undefined && (
            <p className="muted">Published: {state.publishedAt}</p>
          )}
          {state.notes !== undefined && state.notes.trim().length > 0 && (
            <details>
              <summary className="muted">Release notes</summary>
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {state.notes}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={() => void install()}
            disabled={busy !== null}
          >
            {busy === 'install' ? 'Installing…' : 'Install + relaunch'}
          </button>
        </div>
      )}
    </section>
  );
}
