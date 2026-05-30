import { useEffect, useRef } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ConfigScreen } from "./auth/ConfigScreen";
import { LoginScreen } from "./auth/LoginScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { registerDeepLinkAuth } from "./auth/deepLinkHandler";
import { getSupabase } from "./lib/supabase";
import "./App.css";

function Router() {
  const { status } = useAuth();
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void (async () => {
      unsubRef.current = await registerDeepLinkAuth(() => getSupabase());
    })();
    return () => {
      unsubRef.current?.();
    };
  }, []);

  if (status === "loading") {
    return (
      <main className="container narrow center">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (status === "needs-config") return <ConfigScreen />;
  if (status === "signed-out") return <LoginScreen />;
  return <HomeScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
