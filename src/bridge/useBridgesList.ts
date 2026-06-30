import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

export interface BridgeRow {
  id: string;
  name: string | null;
  org_id: string;
  /** Phase 61: bridges are private-by-default, owned by their pairer. */
  owner_user_id: string | null;
  last_seen_at: string | null;
  created_at: string;
}

interface Hook {
  bridges: BridgeRow[];
  loading: boolean;
  error: string | null;
}

export function useBridgesList(): Hook {
  const { client } = useAuth();
  const [bridges, setBridges] = useState<BridgeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) {
      setBridges([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await client
        .from('bridges')
        .select('id, name, org_id, owner_user_id, last_seen_at, created_at')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (e !== null) {
        setError(e.message);
      } else if (data !== null) {
        setBridges(data as BridgeRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { bridges, loading, error };
}
