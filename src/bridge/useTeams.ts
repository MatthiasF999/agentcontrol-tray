import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

/** Mirrors the Phase 61 `teams` table (operator-managed Supabase). */
export interface Team {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
}

interface MyTeamsHook {
  teams: Team[];
  loading: boolean;
  error: string | null;
}

/**
 * Teams the signed-in user is a member of. Read-only — the tray surfaces
 * team membership; team creation/admin lives in the app + operator-portal.
 * Backed by the `list_my_teams()` RPC (no args, returns the team rows).
 */
export function useMyTeams(): MyTeamsHook {
  const { client, session } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session === null) {
      setTeams([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await client.rpc('list_my_teams');
      if (cancelled) return;
      if (e !== null) setError(e.message);
      else setTeams((data ?? []) as Team[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  return { teams, loading, error };
}

/**
 * Teams in a given org — used to populate the share-with-team picker, since
 * a bridge may only be shared with teams in its own org. Backed by
 * `list_org_teams(p_org_id)`.
 */
export function useOrgTeams(orgId: string | null): Team[] {
  const { client } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);

  useEffect(() => {
    if (orgId === null) {
      setTeams([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await client.rpc('list_org_teams', { p_org_id: orgId });
      if (!cancelled) setTeams((data ?? []) as Team[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  return teams;
}
