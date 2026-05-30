import { useEffect, useRef } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ConfigScreen } from "./auth/ConfigScreen";
import { LoginScreen } from "./auth/LoginScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { PairScreen } from "./screens/PairScreen";
import { registerDeepLinkAuth } from "./auth/deepLinkHandler";
import { getSupabase } from "./lib/supabase";
import {
  BridgeClientProvider,
  useBridge,
} from "./bridge/BridgeClientContext";
import { usePairingStatus } from "./bridge/usePairingStatus";
import { useTraySync } from "./bridge/useTraySync";
import "./App.css";

function SignedInRouter() {
  // Inside BridgeClientProvider so we can poll bridge pair-status to decide
  // PairScreen vs HomeScreen. Keep loading + error states distinct from the
  // unauthenticated branches above.
  useBridge();
  const { status, loading, error } = usePairingStatus();
  useTraySync(status, error);

  if (loading) {
    return (
      <main className="container narrow center">
        <p className="muted">Checking bridge…</p>
      </main>
    );
  }
  if (error !== null && status === null) return <PairScreen />;
  if (status === null || status.state !== "paired") return <PairScreen />;
  return <HomeScreen />;
}

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
  return <SignedInRouter />;
}

export default function App() {
  return (
    <AuthProvider>
      <BridgeClientProvider>
        <Router />
      </BridgeClientProvider>
    </AuthProvider>
  );
}
