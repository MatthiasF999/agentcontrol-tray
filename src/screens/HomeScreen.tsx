import { useAuth } from "../auth/AuthContext";

export function HomeScreen() {
  const { session, supabaseUrl, signOut } = useAuth();
  return (
    <main className="container">
      <header className="brand">
        <h1>AgentControl</h1>
        <div className="status-row">
          <span className="status-dot" style={{ backgroundColor: "#22c55e" }} />
          <span className="status-text">Signed in</span>
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
          <dt>User ID</dt>
          <dd>
            <code className="endpoint">{session?.user.id ?? "—"}</code>
          </dd>
        </dl>
      </section>

      <section className="card">
        <h2>Phase 27.1 done</h2>
        <p>
          Login flow lands. Bridge-pairing (27.2), tray-status (27.3),
          settings (27.4), notifications (27.5), container-control (27.6),
          auto-update (27.7) follow.
        </p>
      </section>

      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}
