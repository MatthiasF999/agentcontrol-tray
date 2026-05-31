import { type FormEvent, useState } from 'react';
import { useAuth } from './AuthContext';

const AUTH_CALLBACK = 'agentcontrol-tray://auth-callback';

export function LoginScreen() {
  const { signInWithMagicLink, supabaseUrl, resetConfig } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signInWithMagicLink(email.trim(), AUTH_CALLBACK);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="container narrow">
        <header className="brand">
          <h1>Check your email</h1>
          <p className="muted">
            A magic link was sent to <strong>{email}</strong>. Open it on this
            machine — the link returns you to AgentControl automatically.
          </p>
        </header>
        <button onClick={() => setSent(false)} type="button">
          Send to a different address
        </button>
      </main>
    );
  }

  return (
    <main className="container narrow">
      <header className="brand">
        <h1>Sign in</h1>
        <p className="muted">
          Connected to <code className="endpoint">{supabaseUrl ?? '—'}</code>
        </p>
      </header>
      <form className="form" onSubmit={onSubmit}>
        <label>
          <span>Email</span>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </label>
        {error !== null && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send magic link'}
        </button>
      </form>
      <button type="button" className="link" onClick={() => void resetConfig()}>
        Use a different Supabase instance
      </button>
    </main>
  );
}
