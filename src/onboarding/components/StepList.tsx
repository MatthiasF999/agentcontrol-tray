import { AUTO_STEPS, STEP_LABELS, type StepStatus } from '../state';

const STATUS_ICON: Record<StepStatus, string> = {
  pending: '○',
  running: '◌',
  done: '●',
  error: '✕',
};

export function StepList({
  stepStatus,
}: {
  stepStatus: Record<string, StepStatus>;
}) {
  return (
    <ol className="install-steps">
      {AUTO_STEPS.map((step) => (
        <li key={step} className={`status-${stepStatus[step]}`}>
          <span className={`status-icon status-${stepStatus[step]}`}>
            {STATUS_ICON[stepStatus[step]]}
          </span>
          <span>{STEP_LABELS[step]}</span>
        </li>
      ))}
    </ol>
  );
}
