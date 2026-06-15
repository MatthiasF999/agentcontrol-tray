import { type ReactElement, useReducer } from 'react';
import { ClaudeAuth } from './screens/ClaudeAuth';
import { Done } from './screens/Done';
import { Installing } from './screens/Installing';
import { Setup } from './screens/Setup';
import { SignIn } from './screens/SignIn';
import { initialState, reducer, type Screen, type ScreenProps } from './state';
import './onboarding.css';

const SCREENS: Record<Screen, (props: ScreenProps) => ReactElement> = {
  setup: Setup,
  installing: Installing,
  signin: SignIn,
  claudeauth: ClaudeAuth,
  done: Done,
};

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ScreenComponent = SCREENS[state.screen];

  return (
    <div className="app-shell">
      <ScreenComponent
        state={state}
        dispatch={dispatch}
        onComplete={onComplete}
      />
    </div>
  );
}
