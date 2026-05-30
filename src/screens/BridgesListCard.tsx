import { useBridgesList } from "../bridge/useBridgesList";

interface Props {
  currentBridgeId: string | null;
}

function relativeSeen(iso: string | null): string {
  if (iso === null) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function BridgesListCard({ currentBridgeId }: Props) {
  const { bridges, loading, error } = useBridgesList();
  return (
    <section className="card">
      <h2>All your bridges</h2>
      {loading && <p className="muted">Loading…</p>}
      {error !== null && <div className="error">{error}</div>}
      {!loading && bridges.length === 0 && (
        <p className="muted">
          No bridges visible. RLS only surfaces bridges in your orgs.
        </p>
      )}
      {bridges.length > 0 && (
        <ul className="task-list">
          {bridges.map((b) => (
            <li className="task-row" key={b.id}>
              <div className="task-row-head">
                <span>{b.name ?? "(unnamed)"}</span>
                {b.id === currentBridgeId && (
                  <span
                    className="badge"
                    style={{ backgroundColor: "#dcfce7", color: "#14532d" }}
                  >
                    this machine
                  </span>
                )}
              </div>
              <dl className="kv">
                <dt>Bridge ID</dt>
                <dd>
                  <code className="endpoint">{b.id}</code>
                </dd>
                <dt>Org</dt>
                <dd>
                  <code className="endpoint">{b.org_id}</code>
                </dd>
                <dt>Last seen</dt>
                <dd>{relativeSeen(b.last_seen_at)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
