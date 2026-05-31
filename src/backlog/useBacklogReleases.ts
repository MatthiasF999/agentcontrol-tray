import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { BACKLOG_RELEASE_FIELDS, type BacklogRelease } from './types';

interface Hook {
  releases: BacklogRelease[];
  loading: boolean;
  error: string | null;
}

// Releases are slow-moving compared to items (a sprint cadence at most), so
// we skip the realtime channel here — `useBacklogItems` already drives the
// dominant refresh signal. Operators landing in the consumption screen pick
// up a fresh release list each open.
export function useBacklogReleases(orgId: string | null): Hook {
  const { client } = useAuth();
  const [releases, setReleases] = useState<BacklogRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null || orgId === null) {
      setReleases([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await client
        .from('backlog_releases')
        .select(BACKLOG_RELEASE_FIELDS)
        .eq('org_id', orgId)
        .order('state', { ascending: true })
        .order('target_date', { ascending: true, nullsFirst: false });
      if (cancelled) return;
      if (e !== null) setError(e.message);
      else if (data !== null) setReleases(data as BacklogRelease[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  return { releases, loading, error };
}
