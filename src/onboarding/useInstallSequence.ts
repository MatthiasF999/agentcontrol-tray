import { type Dispatch, useCallback, useEffect, useRef } from 'react';
import { listenWslOutput } from './api';
import { executeStep, STREAMING_STEPS } from './installRunner';
import { type Action, AUTO_STEPS, type AutoStep, type FormData } from './state';

const asLine = (ev: { stream: string; line: string }) =>
  ev.stream === 'stderr' ? `!${ev.line}` : ev.line;

// Drives the 11 auto-steps sequentially from `startIdx`, streaming WSL
// output for streaming steps and threading the resolved distro name
// (ubuntu_install may resolve to an existing distro) through the run.
export function useInstallSequence(
  distro: string,
  formData: FormData,
  dispatch: Dispatch<Action>,
) {
  const runningRef = useRef(false);

  const runFrom = useCallback(
    async (startIdx: number) => {
      if (runningRef.current) return;
      runningRef.current = true;
      let currentDistro = distro;
      try {
        for (let i = startIdx; i < AUTO_STEPS.length; i++) {
          const ok = await runStep(
            AUTO_STEPS[i],
            currentDistro,
            formData,
            dispatch,
          );
          if (ok === false) return;
          if (typeof ok === 'string') currentDistro = ok;
        }
        dispatch({ type: 'SCREEN', screen: 'signin' });
      } finally {
        runningRef.current = false;
      }
    },
    [dispatch, distro, formData],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: kick off once on mount
  useEffect(() => {
    void runFrom(0);
  }, []);

  return runFrom;
}

// Returns false on error, the resolved distro string when a step renames
// the target distro, or undefined on a plain success.
async function runStep(
  step: AutoStep,
  distro: string,
  formData: FormData,
  dispatch: Dispatch<Action>,
): Promise<string | boolean | undefined> {
  dispatch({ type: 'STEP_START', step });
  const unlisten = STREAMING_STEPS.has(step)
    ? await listenWslOutput(step, (ev) =>
        dispatch({ type: 'APPEND_LOG', step, line: asLine(ev) }),
      )
    : null;
  try {
    const result = await executeStep(step, distro, formData, dispatch);
    dispatch({ type: 'STEP_DONE', step });
    return result;
  } catch (e) {
    dispatch({
      type: 'STEP_ERROR',
      step,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  } finally {
    unlisten?.();
  }
}
