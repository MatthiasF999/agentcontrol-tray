import { type Dispatch, useEffect, useRef } from 'react';
import { readGitConfig } from '../api';
import { InputField } from '../components/InputField';
import type { Action, FormData, ScreenProps } from '../state';
import { type CheckState, useSystemChecks } from '../useSystemChecks';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CHECK_GLYPH: Record<CheckState, string> = {
  checking: '◌',
  ok: '✓',
  missing: '!',
};

function DepRow({
  label,
  state,
  note,
}: {
  label: string;
  state: CheckState;
  note: string;
}) {
  return (
    <li className={`dep-row dep-${state}`}>
      <span className={`dep-glyph dep-${state}`}>{CHECK_GLYPH[state]}</span>
      <span className="dep-label">{label}</span>
      <span className="dep-note">{note}</span>
    </li>
  );
}

// Pre-fill git name/email from the WSL distro's existing ~/.gitconfig, only
// patching fields the user hasn't typed into yet (their edits always win).
function useGitConfigPrefill(form: FormData, dispatch: Dispatch<Action>) {
  const done = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefill once on mount
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    readGitConfig()
      .then((cfg) => {
        const patch: Partial<FormData> = {};
        if (cfg.name && !form.gitName) patch.gitName = cfg.name;
        if (cfg.email && !form.gitEmail) patch.gitEmail = cfg.email;
        if (Object.keys(patch).length) {
          dispatch({ type: 'UPDATE_FORM', data: patch });
        }
      })
      .catch(() => {});
  }, [dispatch, form.gitName, form.gitEmail]);
}

function depNote(state: CheckState, okText: string, missingText: string) {
  if (state === 'checking') return 'Checking…';
  return state === 'ok' ? okText : missingText;
}

function DepChecks({
  isWindows,
  wsl,
  docker,
}: {
  isWindows: boolean;
  wsl: CheckState;
  docker: CheckState;
}) {
  return (
    <ul className="dep-list">
      <DepRow
        label="WSL2"
        state={wsl}
        note={
          isWindows
            ? depNote(wsl, 'Ready', 'Will be installed')
            : 'Not required on this platform'
        }
      />
      <DepRow
        label="Docker (optional)"
        state={docker}
        note={depNote(docker, 'Detected', 'Optional — skipped')}
      />
    </ul>
  );
}

function GitForm({ state, dispatch }: ScreenProps) {
  const { gitName, gitEmail } = state.formData;
  const emailValid = EMAIL_RE.test(gitEmail);
  const emailError =
    gitEmail.length > 0 && !emailValid ? 'Enter a valid email address' : null;
  const set = (data: Partial<FormData>) =>
    dispatch({ type: 'UPDATE_FORM', data });
  return (
    <>
      <p className="step-section">Git identity for commits</p>
      <InputField
        label="Git user name"
        value={gitName}
        required
        placeholder="Ada Lovelace"
        onChange={(v) => set({ gitName: v })}
      />
      <InputField
        label="Git email"
        type="email"
        value={gitEmail}
        required
        placeholder="ada@example.com"
        error={emailError}
        onChange={(v) => set({ gitEmail: v })}
      />
    </>
  );
}

export function SystemCheck({ state, dispatch, onComplete }: ScreenProps) {
  const { gitName, gitEmail } = state.formData;
  const { isWindows, wsl, docker } = useSystemChecks();
  useGitConfigPrefill(state.formData, dispatch);
  const canStart = gitName.trim().length > 0 && EMAIL_RE.test(gitEmail);

  return (
    <section className="step">
      <span className="step-eyebrow">System check</span>
      <h1 className="step-title">Check your system</h1>
      <p className="step-intro">
        Anything missing is installed automatically in the next step.
      </p>
      <DepChecks isWindows={isWindows} wsl={wsl} docker={docker} />
      <GitForm state={state} dispatch={dispatch} onComplete={onComplete} />
      <footer className="step-actions">
        <button
          type="button"
          className="pill pill-ghost"
          onClick={() => dispatch({ type: 'SCREEN', screen: 'license' })}
        >
          Back
        </button>
        <button
          type="button"
          className="pill pill-primary"
          disabled={!canStart}
          onClick={() => dispatch({ type: 'SCREEN', screen: 'install' })}
        >
          Start installation
        </button>
      </footer>
    </section>
  );
}
