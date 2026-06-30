import { useAuth } from '../auth/AuthContext';
import { useStandupDigest } from '../backlog/useStandupDigest';
import { usePairingStatus } from '../bridge/usePairingStatus';
import { BacklogQuickAddButton } from './BacklogQuickAddButton';
import { ContainerControlCard } from './ContainerControlCard';
import { RecentTasksCard } from './RecentTasksCard';

interface Props {
  onOpenSettings: () => void;
  onOpenProcesses: () => void;
  onOpenBacklog: (showDigest: boolean) => void;
  onOpenTeams: () => void;
}

function statusColor(state: string): string {
  if (state === 'paired') return '#22c55e';
  if (state === 'unpaired') return '#eab308';
  return '#ef4444';
}

export function HomeScreen({
  onOpenSettings,
  onOpenProcesses,
  onOpenBacklog,
  onOpenTeams,
}: Props) {
  const { session, supabaseUrl, signOut } = useAuth();
  const { status, error } = usePairingStatus();
  const orgIdForDigest = status?.state === 'paired' ? status.orgId : null;
  const { latest: digest } = useStandupDigest(orgIdForDigest);

  const color =
    error !== null ? '#ef4444' : statusColor(status?.state ?? 'expired');
  const label =
    error !== null
      ? 'Bridge unreachable'
      : status?.state === 'paired'
        ? 'Bridge paired and running'
        : status?.state === 'unpaired'
          ? 'Bridge claim active — pair to continue'
          : 'Bridge claim expired';
  const orgId = status?.state === 'paired' ? status.orgId : null;

  return (
    <main className="container">
      <header className="brand">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h1>AgentControl</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => onOpenBacklog(false)}>
              Backlog
            </button>
            <button type="button" onClick={onOpenTeams}>
              Teams
            </button>
            <button type="button" onClick={onOpenProcesses}>
              Processes
            </button>
            <button type="button" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>
        <div className="status-row">
          <span className="status-dot" style={{ backgroundColor: color }} />
          <span className="status-text">{label}</span>
        </div>
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
          {status?.state === 'paired' && (
            <>
              <dt>Bridge ID</dt>
              <dd>
                <code className="endpoint">{status.bridgeId}</code>
              </dd>
              <dt>Org ID</dt>
              <dd>
                <code className="endpoint">{status.orgId}</code>
              </dd>
            </>
          )}
        </dl>
      </section>

      {digest !== null && (
        <section className="card digest-banner">
          <strong>📋 Standup digest available</strong>
          <button
            type="button"
            className="link"
            onClick={() => onOpenBacklog(true)}
          >
            View →
          </button>
        </section>
      )}

      {orgId !== null && <RecentTasksCard orgId={orgId} />}

      <ContainerControlCard />

      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>

      {orgId !== null && <BacklogQuickAddButton orgId={orgId} />}
    </main>
  );
}
