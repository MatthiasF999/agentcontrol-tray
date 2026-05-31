import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { type AutonomousTask, useRecentTasks } from '../bridge/useRecentTasks';

interface Props {
  orgId: string;
}

function statusBadge(status: string): { bg: string; fg: string } {
  if (status === 'executing') return { bg: '#dbeafe', fg: '#1e3a8a' };
  if (status === 'completed') return { bg: '#dcfce7', fg: '#14532d' };
  if (status === 'failed') return { bg: '#fee2e2', fg: '#991b1b' };
  if (status === 'awaiting_approval') return { bg: '#fef3c7', fg: '#78350f' };
  return { bg: '#e4e4e7', fg: '#27272a' };
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString();
}

function TaskRow({ task }: { task: AutonomousTask }) {
  const { client, session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const badge = statusBadge(task.status);

  async function approve(): Promise<void> {
    if (client === null || session === null) {
      setErr('Not signed in.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Direct PostgREST update — RLS policy `autonomous_tasks_owner_update`
      // gates this to org members, and the column-level RLS trigger
      // (migration 0035) blocks bridge JWTs from touching approved_at /
      // approved_by but allows end-user (`bridge_principal` unset) updates.
      // The bridge's waitForApproval poller will see approved_at non-null
      // on its next tick and resume execution.
      const { error: e, count } = await client
        .from('autonomous_tasks')
        .update(
          {
            approved_at: new Date().toISOString(),
            approved_by: session.user.id,
          },
          { count: 'exact' },
        )
        .eq('id', task.id)
        .eq('status', 'awaiting_approval');
      if (e !== null) {
        setErr(e.message);
        return;
      }
      if ((count ?? 0) === 0) {
        setErr('Task no longer awaiting approval.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="task-row">
      <div className="task-row-head">
        <span
          className="badge"
          style={{ backgroundColor: badge.bg, color: badge.fg }}
        >
          {task.status}
        </span>
        <span className="muted">{formatWhen(task.created_at)}</span>
      </div>
      <p className="task-prompt">
        {task.prompt !== null && task.prompt.length > 120
          ? `${task.prompt.slice(0, 117)}…`
          : (task.prompt ?? '(no prompt)')}
      </p>
      {task.status === 'awaiting_approval' && (
        <>
          <button type="button" onClick={() => void approve()} disabled={busy}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
          {err !== null && <div className="error">{err}</div>}
        </>
      )}
    </li>
  );
}

export function RecentTasksCard({ orgId }: Props) {
  const { tasks, loading, error } = useRecentTasks(orgId);
  return (
    <section className="card">
      <h2>Recent autonomous tasks</h2>
      {loading && <p className="muted">Loading…</p>}
      {error !== null && <div className="error">{error}</div>}
      {!loading && error === null && tasks.length === 0 && (
        <p className="muted">No tasks yet.</p>
      )}
      {tasks.length > 0 && (
        <ul className="task-list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
