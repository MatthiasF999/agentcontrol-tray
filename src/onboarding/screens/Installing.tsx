import { LogStream } from '../components/LogStream';
import { StepList } from '../components/StepList';
import { AUTO_STEPS, type ScreenProps } from '../state';
import { useInstallSequence } from '../useInstallSequence';

export function Installing({ state, dispatch }: ScreenProps) {
  const { install, formData } = state;
  const { stepStatus, distro } = install;
  const runFrom = useInstallSequence(distro, formData, dispatch);

  const completed = AUTO_STEPS.filter((s) => stepStatus[s] === 'done').length;
  const pct = Math.round((completed / AUTO_STEPS.length) * 100);
  const active = AUTO_STEPS.find(
    (s) => stepStatus[s] === 'running' || stepStatus[s] === 'error',
  );
  const erroredIdx = AUTO_STEPS.findIndex((s) => stepStatus[s] === 'error');

  return (
    <section className="screen">
      <h1>Installing…</h1>
      <div className="progress">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <StepList stepStatus={stepStatus} />

      {active ? <LogStream lines={install.logs[active]} /> : null}

      {install.errorMsg ? (
        <>
          <div className="step-error-banner">{install.errorMsg}</div>
          <footer className="actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void runFrom(erroredIdx < 0 ? 0 : erroredIdx)}
            >
              Retry
            </button>
          </footer>
        </>
      ) : null}
    </section>
  );
}
