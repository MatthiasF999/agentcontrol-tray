import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { listen } from '@tauri-apps/api/event';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { SUPABASE_URL } from '../config/hetzner';
import { getSupabase } from '../lib/supabase';

type Status = 'loading' | 'signed-out' | 'signed-in';

interface AuthState {
  status: Status;
  session: Session | null;
  supabaseUrl: string;
  client: SupabaseClient;
  signInWithMagicLink: (email: string, redirectTo: string) => Promise<void>;
  setSession: (session: Session) => void;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

// Magic-link verify redirects to `agentcontrol-tray://auth-callback#…`; the
// Rust deep-link handler forwards the tokens on the `auth-tokens-received`
// event. Its own hook so the listener is live before the browser hands back.
function useMagicLinkTokens(
  client: SupabaseClient,
  setSession: (session: Session) => void,
  setStatus: (status: Status) => void,
) {
  useEffect(() => {
    const unlisten = listen<{ access_token: string; refresh_token: string }>(
      'auth-tokens-received',
      async (event) => {
        const { data, error } = await client.auth.setSession({
          access_token: event.payload.access_token,
          refresh_token: event.payload.refresh_token,
        });
        if (error === null && data.session !== null) {
          setSession(data.session);
          setStatus('signed-in');
        }
      },
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, [client, setSession, setStatus]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSessionState] = useState<Session | null>(null);
  const client = useMemo(() => getSupabase(), []);

  useEffect(() => {
    void (async () => {
      const { data } = await client.auth.getSession();
      if (data.session !== null) {
        setSessionState(data.session);
        setStatus('signed-in');
      } else {
        setStatus('signed-out');
      }
      client.auth.onAuthStateChange((_event, newSession) => {
        setSessionState(newSession);
        setStatus(newSession !== null ? 'signed-in' : 'signed-out');
      });
    })();
  }, [client]);

  useMagicLinkTokens(client, setSessionState, setStatus);

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      supabaseUrl: SUPABASE_URL,
      client,
      async signInWithMagicLink(email, redirectTo) {
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (error !== null) throw error;
      },
      setSession(newSession) {
        setSessionState(newSession);
        setStatus('signed-in');
      },
      async signOut() {
        await client.auth.signOut();
        setSessionState(null);
        setStatus('signed-out');
      },
    }),
    [status, session, client],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (ctx === null) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
