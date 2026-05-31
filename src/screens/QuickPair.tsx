import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useBridge } from '../bridge/BridgeClientContext';
import { BridgeError } from '../bridge/bridgeClient';
import { useOrgsList } from '../bridge/useOrgsList';
import { usePairingStatus } from '../bridge/usePairingStatus';

interface PairBridgeResult {
  bridge_id: string;
  refresh_token: string;
  lan_api_key: string;
}

export function QuickPair() {
  const { client } = useAuth();
  const { orgs, loading: orgsLoading, error: orgsError } = useOrgsList();
  const { status, refresh } = usePairingStatus();
  const bridge = useBridge();
  const [orgId, setOrgId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adminOrgs = orgs.filter(
    (o) => o.role === 'owner' || o.role === 'admin',
  );
  const haveCode = status !== null && status.state === 'unpaired';

  async function onQuickPair(): Promise<void> {
    if (client === null) return;
    if (!haveCode) return;
    if (status.state !== 'unpaired') return;
    if (orgId === '') return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: e } = await client.rpc('pair_bridge', {
        p_code: status.code,
        p_org_id: orgId,
        p_label: label.trim() === '' ? null : label.trim(),
        p_tailscale_host: null,
      });
      if (e !== null) {
        setError(e.message);
        return;
      }
      const result = data as PairBridgeResult;
      await bridge.acceptPairing({
        bridgeId: result.bridge_id,
        orgId,
        refreshToken: result.refresh_token,
      });
      await refresh();
    } catch (e) {
      if (e instanceof BridgeError) {
        setError(`Bridge ${e.status}: ${e.body}`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Quick pair</h2>
      {!haveCode && (
        <p className="muted">
          Bridge has no active claim code (state:{' '}
          <code className="endpoint">{status?.state ?? 'unknown'}</code>). Quick
          pair available when bridge first starts unpaired.
        </p>
      )}
      {haveCode && status.state === 'unpaired' && (
        <>
          <p className="muted">
            Bridge claim: <code className="endpoint">{status.code}</code>
            <br />
            Expires: {new Date(status.expiresAt).toLocaleString()}
          </p>
          {orgsError !== null && <div className="error">{orgsError}</div>}
          {orgsLoading && <p className="muted">Loading orgs…</p>}
          {!orgsLoading && adminOrgs.length === 0 && (
            <p className="muted">
              You're not an owner or admin of any org. Quick pair requires owner
              or admin role.
            </p>
          )}
          {adminOrgs.length > 0 && (
            <div className="form">
              <label>
                <span>Pair into org</span>
                <select
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                >
                  <option value="">Select org…</option>
                  {adminOrgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.role})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Label (optional)</span>
                <input
                  type="text"
                  placeholder="my-laptop"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {error !== null && <div className="error">{error}</div>}
              <button
                type="button"
                onClick={() => void onQuickPair()}
                disabled={busy || orgId === ''}
              >
                {busy ? 'Pairing…' : 'Pair this bridge'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
