import { openUrl } from '@tauri-apps/plugin-opener';
import type { ReactNode } from 'react';
import { OPERATOR_URL } from '../../config/hetzner';
import { WizardRail } from './WizardRail';

const HELP_URL = `${OPERATOR_URL}/docs/install`;

// 35/65 two-pane wizard chrome: branded left rail (logo + macro step list +
// help link) and a right pane that renders the current step. Matches the
// boot splash dark theme so the hand-off is seamless.
export function WizardShell({
  active,
  children,
}: {
  active: number;
  children: ReactNode;
}) {
  return (
    <div className="wizard">
      <aside className="wizard-rail">
        <div className="wizard-brand">
          <span className="wizard-logo" />
          <span className="wizard-brand-name">AgentControl</span>
        </div>
        <WizardRail active={active} />
        <button
          type="button"
          className="wizard-help"
          onClick={() => void openUrl(HELP_URL)}
        >
          Need help?
        </button>
      </aside>
      <main className="wizard-pane">{children}</main>
    </div>
  );
}
