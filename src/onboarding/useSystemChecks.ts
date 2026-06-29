import { useEffect, useState } from 'react';
import { checkDocker } from '../lib/docker';
import { detectWsl } from './api';

export type CheckState = 'checking' | 'ok' | 'missing';

export type SystemChecks = {
  isWindows: boolean;
  wsl: CheckState;
  docker: CheckState;
};

function detectWindows(): boolean {
  return /Windows/i.test(navigator.userAgent);
}

// Probes the two host prerequisites the System-check step reports on. WSL2
// is required (and auto-installed by the next step if missing); Docker is
// optional. On non-Windows hosts WSL is reported `ok` (not applicable) so
// the step never blocks — the install sequence skips WSL there too.
export function useSystemChecks(): SystemChecks {
  const isWindows = detectWindows();
  const [wsl, setWsl] = useState<CheckState>(isWindows ? 'checking' : 'ok');
  const [docker, setDocker] = useState<CheckState>('checking');

  useEffect(() => {
    if (isWindows) {
      detectWsl()
        .then((s) => setWsl(s.installed ? 'ok' : 'missing'))
        .catch(() => setWsl('missing'));
    }
    checkDocker()
      .then((d) => setDocker(d.installed ? 'ok' : 'missing'))
      .catch(() => setDocker('missing'));
  }, [isWindows]);

  return { isWindows, wsl, docker };
}
