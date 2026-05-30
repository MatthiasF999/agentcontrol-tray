import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  clearSupabaseConfig,
  getStoredSupabaseConfig,
  getSupabase,
  saveSupabaseConfig,
} from "../lib/supabase";

type Status = "loading" | "needs-config" | "signed-out" | "signed-in";

interface AuthState {
  status: Status;
  session: Session | null;
  supabaseUrl: string | null;
  client: SupabaseClient | null;
  configure: (url: string, anonKey: string) => Promise<void>;
  signInWithMagicLink: (email: string, redirectTo: string) => Promise<void>;
  setSession: (session: Session) => void;
  signOut: () => Promise<void>;
  resetConfig: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [session, setSessionState] = useState<Session | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [supabaseUrl, setUrl] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const cfg = await getStoredSupabaseConfig();
      if (cfg === null) {
        setStatus("needs-config");
        return;
      }
      setUrl(cfg.url);
      const c = await getSupabase();
      if (c === null) {
        setStatus("needs-config");
        return;
      }
      setClient(c);
      const { data } = await c.auth.getSession();
      if (data.session !== null) {
        setSessionState(data.session);
        setStatus("signed-in");
      } else {
        setStatus("signed-out");
      }
      c.auth.onAuthStateChange((_event, newSession) => {
        setSessionState(newSession);
        setStatus(newSession !== null ? "signed-in" : "signed-out");
      });
    })();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      supabaseUrl,
      client,
      async configure(url, anonKey) {
        await saveSupabaseConfig(url, anonKey);
        setUrl(url);
        const c = await getSupabase();
        setClient(c);
        setStatus("signed-out");
      },
      async signInWithMagicLink(email, redirectTo) {
        if (client === null) throw new Error("Supabase client not configured");
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (error !== null) throw error;
      },
      setSession(newSession) {
        setSessionState(newSession);
        setStatus("signed-in");
      },
      async signOut() {
        if (client === null) return;
        await client.auth.signOut();
        setSessionState(null);
        setStatus("signed-out");
      },
      async resetConfig() {
        if (client !== null) await client.auth.signOut();
        await clearSupabaseConfig();
        setClient(null);
        setUrl(null);
        setSessionState(null);
        setStatus("needs-config");
      },
    }),
    [status, session, supabaseUrl, client],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (ctx === null) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
