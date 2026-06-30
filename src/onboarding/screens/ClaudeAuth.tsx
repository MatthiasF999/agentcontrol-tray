import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { openClaudeOauth, pollClaudeCreds } from '../api';
import type { Action, ScreenProps } from '../state';

const POLL_MS = 5000;

function useClaudeOauth(distro: string, dispatch: Dispatch<Action>) {
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => stop, [stop]);

  const signIn = async () => {
    setError(null);
    try {
      await openClaudeOauth();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPolling(true);
    timer.current = setInterval(async () => {
      const found = await pollClaudeCreds(distro).catch(() => false);
      if (found) {
        stop();
        dispatch({ type: 'SCREEN', screen: 'done' });
      }
    }, POLL_MS);
  };

  return { polling, error, signIn };
}

export function ClaudeAuth({ state, dispatch }: ScreenProps) {
  const { distro } = state.install;
  const { polling, error, signIn } = useClaudeOauth(distro, dispatch);

  return (
    <section className="step">
      <span className="step-eyebrow">Claude Code</span>
      <h1 className="step-title">Sign in to Claude Code</h1>
      <p className="step-intro">
        The bridge runs Claude Code to drive autonomous agents. Authorize it
        once in your browser — the credentials are detected automatically and
        onboarding continues.
      </p>
      <footer className="step-actions">
        <button
          type="button"
          className="pill pill-primary"
          onClick={signIn}
          disabled={polling}
        >
          {polling ? 'Waiting for Claude Code login…' : 'Open browser'}
        </button>
      </footer>
      {error ? <div className="step-error-banner">{error}</div> : null}
    </section>
  );
}
