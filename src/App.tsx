import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ConfigScreen } from "./auth/ConfigScreen";
import { LoginScreen } from "./auth/LoginScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { PairScreen } from "./screens/PairScreen";
import { ProcessInstancesScreen } from "./screens/ProcessInstancesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { BacklogConsumptionScreen } from "./screens/BacklogConsumptionScreen";
import { registerDeepLinkAuth } from "./auth/deepLinkHandler";
import { getSupabase } from "./lib/supabase";
import {
  BridgeClientProvider,
  useBridge,
} from "./bridge/BridgeClientContext";
import { usePairingStatus } from "./bridge/usePairingStatus";
import { useTraySync } from "./bridge/useTraySync";
import "./App.css";

type View = "home" | "settings" | "processes" | "backlog";

function SignedInRouter() {
  useBridge();
  const { status, loading, error } = usePairingStatus();
  const [view, setView] = useState<View>("home");
  const [backlogShowDigest, setBacklogShowDigest] = useState(false);
  useTraySync(status, error);

  function openBacklog(showDigest: boolean): void {
    setBacklogShowDigest(showDigest);
    setView("backlog");
  }

  if (loading) {
    return (
      <main className="container narrow center">
        <p className="muted">Checking bridge…</p>
      </main>
    );
  }

  // Settings is always accessible to signed-in users — even pre-pair.
  if (view === "settings") {
    return <SettingsScreen onBack={() => setView("home")} />;
  }
  if (view === "processes") {
    return <ProcessInstancesScreen onBack={() => setView("home")} />;
  }
  if (view === "backlog") {
    return (
      <BacklogConsumptionScreen
        onBack={() => setView("home")}
        showDigestOnOpen={backlogShowDigest}
      />
    );
  }

  if (error !== null && status === null) return <PairScreen />;
  if (status === null || status.state !== "paired") return <PairScreen />;
  return (
    <HomeScreen
      onOpenSettings={() => setView("settings")}
      onOpenProcesses={() => setView("processes")}
      onOpenBacklog={(showDigest) => openBacklog(showDigest)}
    />
  );
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
