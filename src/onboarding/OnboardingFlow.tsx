import { type ReactElement, useReducer } from 'react';
import './onboarding.css';
import { WizardShell } from './components/WizardShell';
import { ClaudeAuth } from './screens/ClaudeAuth';
import { Done } from './screens/Done';
import { Installing } from './screens/Installing';
import { License } from './screens/License';
import { Pair } from './screens/Pair';
import { SystemCheck } from './screens/SystemCheck';
import { Welcome } from './screens/Welcome';
import {
  activeMacroIndex,
  initialState,
  reducer,
  type Screen,
  type ScreenProps,
} from './state';

const SCREENS: Record<Screen, (props: ScreenProps) => ReactElement> = {
  welcome: Welcome,
  license: License,
  syscheck: SystemCheck,
  install: Installing,
  pair: Pair,
  claudeauth: ClaudeAuth,
  done: Done,
};

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ScreenComponent = SCREENS[state.screen];

  return (
    <WizardShell active={activeMacroIndex(state)}>
      <ScreenComponent
        state={state}
        dispatch={dispatch}
        onComplete={onComplete}
      />
    </WizardShell>
  );
}
