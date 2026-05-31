import { useEffect, useState } from 'react';
import { useBridge } from './BridgeClientContext';
import type { BridgePairingState } from './bridgeClient';

interface PairingHook {
  status: BridgePairingState | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 4000;

export function usePairingStatus(): PairingHook {
  const bridge = useBridge();
  const [status, setStatus] = useState<BridgePairingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    try {
      const s = await bridge.pairStatus();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return { status, error, loading, refresh };
}
