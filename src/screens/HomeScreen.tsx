import { useAuth } from "../auth/AuthContext";
import { usePairingStatus } from "../bridge/usePairingStatus";

function statusColor(state: string): string {
  if (state === "paired") return "#22c55e";
  if (state === "claimed") return "#eab308";
  return "#ef4444";
}

export function HomeScreen() {
  const { session, supabaseUrl, signOut } = useAuth();
  const { status, error } = usePairingStatus();

  const color =
    error !== null ? "#ef4444" : statusColor(status?.state ?? "unpaired");
  const label =
    error !== null
      ? "Bridge unreachable"
      : status?.state === "paired"
      ? "Bridge paired and running"
      : status?.state === "claimed"
      ? "Bridge claim pending"
      : "Bridge unpaired";

  return (
    <main className="container">
      <header className="brand">
        <h1>AgentControl</h1>
        <div className="status-row">
          <span className="status-dot" style={{ backgroundColor: color }} />
          <span className="status-text">{label}</span>
        </div>
      </header>

      <section className="card">
        <h2>Account</h2>
        <dl className="kv">
          <dt>Email</dt>
          <dd>{session?.user.email ?? "—"}</dd>
          <dt>Supabase</dt>
          <dd>
            <code className="endpoint">{supabaseUrl}</code>
          </dd>
          {status?.state === "paired" && (
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

      <section className="card">
        <h2>Coming next</h2>
        <p>
          Settings (27.4), recent tasks + approval notifications (27.5),
          container control (27.6), auto-update + multi-bridge (27.7).
        </p>
      </section>

      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}
