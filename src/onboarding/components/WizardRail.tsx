import { MACRO_STEPS } from '../state';

type RailState = 'done' | 'current' | 'pending';

function railState(index: number, active: number): RailState {
  if (index < active) return 'done';
  if (index === active) return 'current';
  return 'pending';
}

// Left-rail step list. Each row is a circle (empty → pulsing gradient →
// gradient-with-check) plus its label. Purely presentational — the active
// index is derived once in `activeMacroIndex` and threaded down.
export function WizardRail({ active }: { active: number }) {
  return (
    <ol className="rail-steps">
      {MACRO_STEPS.map((step, idx) => {
        const state = railState(idx, active);
        return (
          <li key={step.id} className={`rail-step rail-${state}`}>
            <span className={`rail-circle rail-${state}`}>
              {state === 'done' ? '✓' : ''}
            </span>
            <span className="rail-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
