import { useMyTeams } from '../../bridge/useTeams';

interface Props {
  onBack: () => void;
}

/**
 * Read-only list of the teams the signed-in user belongs to. Team
 * creation + member management live in the app and operator-portal; the
 * tray only needs to show membership so the user can reason about which
 * bridges are shared with which teams.
 */
export function MyTeamsView({ onBack }: Props) {
  const { teams, loading, error } = useMyTeams();

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
          <h1>My teams</h1>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </header>

      <section className="card">
        <h2>Teams you belong to</h2>
        {loading && <p className="muted">Loading…</p>}
        {error !== null && <div className="error">{error}</div>}
        {!loading && error === null && teams.length === 0 && (
          <p className="muted">
            You're not a member of any team yet. A team admin can add you from
            the app.
          </p>
        )}
        {teams.length > 0 && (
          <ul className="task-list">
            {teams.map((t) => (
              <li className="task-row" key={t.id}>
                <div className="task-row-head">
                  <span>{t.name}</span>
                </div>
                <dl className="kv">
                  <dt>Slug</dt>
                  <dd>
                    <code className="endpoint">{t.slug}</code>
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
