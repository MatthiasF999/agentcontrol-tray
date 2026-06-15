import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ConfigScreen } from './auth/ConfigScreen';
import { registerDeepLinkAuth } from './auth/deepLinkHandler';
import { LoginScreen } from './auth/LoginScreen';
import { BridgeClientProvider, useBridge } from './bridge/BridgeClientContext';
import { usePairingStatus } from './bridge/usePairingStatus';
import { useTraySync } from './bridge/useTraySync';
import {
  installNotificationRouting,
  type NavRoute,
  onNavigate,
} from './lib/navigation';
import { settings } from './lib/storage';
import { getSupabase } from './lib/supabase';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { BacklogConsumptionScreen } from './screens/BacklogConsumptionScreen';
import { HomeScreen } from './screens/HomeScreen';
import { PairScreen } from './screens/PairScreen';
import { ProcessInstancesScreen } from './screens/ProcessInstancesScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import './App.css';

type View = NavRoute;

function SignedInRouter() {
  useBridge();
  const { status, loading, error } = usePairingStatus();
  const [view, setView] = useState<View>('home');
  const [backlogShowDigest, setBacklogShowDigest] = useState(false);
  useTraySync(status, error);

  // Add-24 — route to the view named by a clicked OS notification.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await onNavigate((route) => setView(route));
    })();
    return () => unlisten?.();
  }, []);

  function openBacklog(showDigest: boolean): void {
    setBacklogShowDigest(showDigest);
    setView('backlog');
  }

  if (loading) {
    return (
      <main className="container narrow center">
        <p className="muted">Checking bridge…</p>
      </main>
    );
  }

  // Settings is always accessible to signed-in users — even pre-pair.
  if (view === 'settings') {
    return <SettingsScreen onBack={() => setView('home')} />;
  }
  if (view === 'processes') {
    return <ProcessInstancesScreen onBack={() => setView('home')} />;
  }
  if (view === 'backlog') {
    return (
      <BacklogConsumptionScreen
        onBack={() => setView('home')}
        showDigestOnOpen={backlogShowDigest}
      />
    );
  }

  if (error !== null && status === null) return <PairScreen />;
  if (status === null || status.state !== 'paired') return <PairScreen />;
  return (
    <HomeScreen
      onOpenSettings={() => setView('settings')}
      onOpenProcesses={() => setView('processes')}
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
    const routingPromise = installNotificationRouting();
    return () => {
      unsubRef.current?.();
      void routingPromise.then((unregister) => unregister());
    };
  }, []);

  if (status === 'loading') {
    return (
      <main className="container narrow center">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (status === 'needs-config') return <ConfigScreen />;
  if (status === 'signed-out') return <LoginScreen />;
  return <SignedInRouter />;
}

// Phase 55.3.0 — first-run gate. Before the bridge is set up (WSL +
// Ubuntu + Node + Claude CLI + bridge service), route to the onboarding
// flow folded in from the standalone installer. Once Done, persist the
// flag and fall through to the normal auth + main UI.
const SETUP_DONE_KEY = 'bridge.setup.done.v1';

function useOnboardingGate() {
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => {
    void settings.get<boolean>(SETUP_DONE_KEY).then((v) => setDone(v === true));
  }, []);
  const complete = useCallback(() => {
    void settings.set(SETUP_DONE_KEY, true);
    setDone(true);
  }, []);
  return { done, complete };
}

export default function App() {
  const { done, complete } = useOnboardingGate();

  if (done === null) {
    return (
      <main className="container narrow center">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!done) return <OnboardingFlow onComplete={complete} />;

  return (
    <AuthProvider>
      <BridgeClientProvider>
        <Router />
      </BridgeClientProvider>
    </AuthProvider>
  );
}
