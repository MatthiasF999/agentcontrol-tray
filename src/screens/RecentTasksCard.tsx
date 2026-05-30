import { useState } from "react";
import { useBridge } from "../bridge/BridgeClientContext";
import { useRecentTasks, type AutonomousTask } from "../bridge/useRecentTasks";
import { BridgeError } from "../bridge/bridgeClient";

interface Props {
  orgId: string;
}

function statusBadge(status: string): { bg: string; fg: string } {
  if (status === "executing") return { bg: "#dbeafe", fg: "#1e3a8a" };
  if (status === "completed") return { bg: "#dcfce7", fg: "#14532d" };
  if (status === "failed") return { bg: "#fee2e2", fg: "#991b1b" };
  if (status === "awaiting_approval") return { bg: "#fef3c7", fg: "#78350f" };
  return { bg: "#e4e4e7", fg: "#27272a" };
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString();
}

function TaskRow({ task }: { task: AutonomousTask }) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const badge = statusBadge(task.status);

  async function approve(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await bridge.approveTask(task.id);
    } catch (e) {
      if (e instanceof BridgeError && e.status === 404) {
        setErr("Bridge POST /autonomous/approve/{taskId} route not implemented");
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
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
          : task.prompt ?? "(no prompt)"}
      </p>
      {task.status === "awaiting_approval" && (
        <>
          <button type="button" onClick={() => void approve()} disabled={busy}>
            {busy ? "Approving…" : "Approve"}
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
