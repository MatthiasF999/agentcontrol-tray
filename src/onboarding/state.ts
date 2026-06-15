import type { Dispatch } from 'react';

export type Screen = 'setup' | 'installing' | 'signin' | 'claudeauth' | 'done';

export type AutoStep =
  | 'wsl_install'
  | 'ubuntu_install'
  | 'deps'
  | 'gitcfg'
  | 'node'
  | 'claude_cli'
  | 'source'
  | 'npm_install'
  | 'build'
  | 'env'
  | 'systemd';

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export type FormData = {
  gitName: string;
  gitEmail: string;
};

export type InstallState = {
  stepStatus: Record<AutoStep, StepStatus>;
  logs: Record<AutoStep, string[]>;
  errorMsg: string | null;
  distro: string;
  paired: boolean;
};

export type WizardState = {
  screen: Screen;
  formData: FormData;
  install: InstallState;
  apiKey: string;
  signinClaimCode: string;
  signinLabel: string;
};

export type Action =
  | { type: 'SCREEN'; screen: Screen }
  | { type: 'UPDATE_FORM'; data: Partial<FormData> }
  | { type: 'SET_DISTRO'; distro: string }
  | { type: 'STEP_START'; step: AutoStep }
  | { type: 'STEP_DONE'; step: AutoStep }
  | { type: 'STEP_ERROR'; step: AutoStep; error: string }
  | { type: 'APPEND_LOG'; step: AutoStep; line: string }
  | { type: 'SET_API_KEY'; key: string }
  | { type: 'SET_PAIRED'; paired: boolean }
  | { type: 'SET_SIGNIN'; claimCode: string; label: string };

export const AUTO_STEPS: readonly AutoStep[] = [
  'wsl_install',
  'ubuntu_install',
  'deps',
  'gitcfg',
  'node',
  'claude_cli',
  'source',
  'npm_install',
  'build',
  'env',
  'systemd',
];

export const STEP_LABELS: Record<AutoStep, string> = {
  wsl_install: 'WSL2',
  ubuntu_install: 'Ubuntu 22.04',
  deps: 'System dependencies',
  gitcfg: 'Git config',
  node: 'Node.js 22',
  claude_cli: 'Claude Code CLI',
  source: 'Bridge source',
  npm_install: 'npm install',
  build: 'Build bridge',
  env: 'Generate .env',
  systemd: 'systemd service',
};

const fill = <T>(value: () => T): Record<AutoStep, T> =>
  AUTO_STEPS.reduce(
    (acc, key) => {
      acc[key] = value();
      return acc;
    },
    {} as Record<AutoStep, T>,
  );

export const initialState: WizardState = {
  screen: 'setup',
  formData: {
    gitName: '',
    gitEmail: '',
  },
  install: {
    stepStatus: fill<StepStatus>(() => 'pending'),
    logs: fill<string[]>(() => []),
    errorMsg: null,
    distro: 'Ubuntu-22.04',
    paired: false,
  },
  apiKey: '',
  signinClaimCode: '',
  signinLabel: '',
};

function patchInstall(
  state: WizardState,
  patch: Partial<InstallState>,
): WizardState {
  return { ...state, install: { ...state.install, ...patch } };
}

export function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case 'SCREEN':
      return { ...state, screen: action.screen };
    case 'UPDATE_FORM':
      return { ...state, formData: { ...state.formData, ...action.data } };
    case 'SET_DISTRO':
      return patchInstall(state, { distro: action.distro });
    case 'STEP_START':
      return patchInstall(state, {
        stepStatus: { ...state.install.stepStatus, [action.step]: 'running' },
        errorMsg: null,
      });
    case 'STEP_DONE':
      return patchInstall(state, {
        stepStatus: { ...state.install.stepStatus, [action.step]: 'done' },
      });
    case 'STEP_ERROR':
      return patchInstall(state, {
        stepStatus: { ...state.install.stepStatus, [action.step]: 'error' },
        errorMsg: action.error,
      });
    case 'APPEND_LOG':
      return patchInstall(state, {
        logs: {
          ...state.install.logs,
          [action.step]: [...state.install.logs[action.step], action.line],
        },
      });
    case 'SET_API_KEY':
      return { ...state, apiKey: action.key };
    case 'SET_PAIRED':
      return patchInstall(state, { paired: action.paired });
    case 'SET_SIGNIN':
      return {
        ...state,
        signinClaimCode: action.claimCode,
        signinLabel: action.label,
      };
    default:
      return state;
  }
}

export type ScreenProps = {
  state: WizardState;
  dispatch: Dispatch<Action>;
  // Phase 55.3.0 — called by the Done screen to mark onboarding complete
  // and hand control back to the tray's main auth/UI flow.
  onComplete: () => void;
};
