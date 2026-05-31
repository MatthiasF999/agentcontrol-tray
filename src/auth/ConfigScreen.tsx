import { type FormEvent, useState } from 'react';
import { useAuth } from './AuthContext';

export function ConfigScreen() {
  const { configure } = useAuth();
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const trimmed = url.trim().replace(/\/$/, '');
      if (!/^https?:\/\//.test(trimmed)) {
        throw new Error('URL must start with http:// or https://');
      }
      if (anonKey.trim().length < 20) {
        throw new Error('Anon key looks too short');
      }
      await configure(trimmed, anonKey.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow">
      <header className="brand">
        <h1>AgentControl</h1>
        <p className="muted">Connect to your self-hosted Supabase.</p>
      </header>
      <form className="form" onSubmit={onSubmit}>
        <label>
          <span>Supabase URL</span>
          <input
            type="url"
            placeholder="https://supabase.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          <span>Anon public key</span>
          <textarea
            placeholder="eyJhbGciOi…"
            value={anonKey}
            onChange={(e) => setAnonKey(e.target.value)}
            rows={3}
            required
          />
        </label>
        {error !== null && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </main>
  );
}
