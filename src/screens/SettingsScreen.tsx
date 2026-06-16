import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useBridge } from '../bridge/BridgeClientContext';
import { usePairingStatus } from '../bridge/usePairingStatus';
import {
  DEFAULT_SETTINGS,
  type Theme,
  type UpdateChannel,
  useAppSettings,
} from '../lib/appSettings';
import { AboutCard } from './AboutCard';
import { BridgesListCard } from './BridgesListCard';
import { UpdaterCard } from './UpdaterCard';

interface Props {
  onBack: () => void;
}

export function SettingsScreen({ onBack }: Props) {
  const { session, supabaseUrl, signOut } = useAuth();
  const { values, loading, update, reset } = useAppSettings();
  const bridge = useBridge();
  const { status } = usePairingStatus();
  const [bridgeConfigError, setBridgeConfigError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    // Probe GET /config once on mount so we know whether to render the Bridge
    // config form or the cross-repo-pending placeholder.
    void (async () => {
      try {
        const res = await fetch('http://localhost:3001/config', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          setBridgeConfigError(`GET /config → ${res.status}`);
        }
      } catch (e) {
        setBridgeConfigError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [bridge]);

  if (loading) {
    return (
      <main className="container narrow center">
        <p className="muted">Loading settings…</p>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="brand">
        <button type="button" className="link" onClick={onBack}>
          ← Back
        </button>
        <h1>Settings</h1>
      </header>

      <section className="card">
        <h2>Account</h2>
        <dl className="kv">
          <dt>Email</dt>
          <dd>{session?.user.email ?? '—'}</dd>
          <dt>Supabase</dt>
          <dd>
            <code className="endpoint">{supabaseUrl}</code>
          </dd>
        </dl>
        <div className="form" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="card">
        <h2>App</h2>
        <div className="form">
          <label>
            <span>Theme</span>
            <select
              value={values.theme}
              onChange={(e) => void update('theme', e.target.value as Theme)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            <span>Poll interval (seconds)</span>
            <input
              type="number"
              min={2}
              max={30}
              value={values.pollIntervalSeconds}
              onChange={(e) =>
                void update(
                  'pollIntervalSeconds',
                  Math.max(
                    2,
                    Math.min(30, Number.parseInt(e.target.value, 10) || 4),
                  ),
                )
              }
            />
          </label>
          <label>
            <span>Update channel</span>
            <select
              value={values.updateChannel}
              onChange={(e) =>
                void update('updateChannel', e.target.value as UpdateChannel)
              }
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </select>
          </label>
          <label>
            <span>Compose project directory</span>
            <input
              type="text"
              placeholder="/home/you/projects/supabase"
              value={values.composeDir ?? ''}
              onChange={(e) =>
                void update(
                  'composeDir',
                  e.target.value.trim() === '' ? null : e.target.value.trim(),
                )
              }
            />
          </label>
          <label>
            <span>Compose profile</span>
            <input
              type="text"
              placeholder="bridge"
              value={values.composeProfile}
              onChange={(e) =>
                void update('composeProfile', e.target.value.trim() || 'bridge')
              }
            />
          </label>
          <button type="button" className="link" onClick={() => void reset()}>
            Reset app settings to defaults
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Bridge configuration</h2>
        {status?.state === 'paired' ? (
          bridgeConfigError !== null ? (
            <div className="error">
              Bridge does not expose <code>GET /config</code> yet (
              {bridgeConfigError}). The route additions are documented in{' '}
              <code>docs/PHASE-27-2-CROSS-REPO.md</code> (Delta A); the config
              GET/PUT pair is a 27.4 follow-up beyond that.
            </div>
          ) : (
            <p className="muted">
              Bridge config form lands once GET/PUT /config is wired.
            </p>
          )
        ) : (
          <p className="muted">
            Pair this bridge first (Status:{' '}
            <code>{status?.state ?? 'unknown'}</code>).
          </p>
        )}
      </section>

      <BridgesListCard
        currentBridgeId={status?.state === 'paired' ? status.bridgeId : null}
      />

      <UpdaterCard />

      <AboutCard supabaseUrl={supabaseUrl} />

      <details className="card">
        <summary>Defaults reference</summary>
        <pre style={{ fontSize: 12 }}>
          {JSON.stringify(DEFAULT_SETTINGS, null, 2)}
        </pre>
      </details>
    </main>
  );
}
