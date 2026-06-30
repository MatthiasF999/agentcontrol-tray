import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

export interface BridgeShare {
  teamId: string;
  teamName: string;
}

interface ShareRow {
  bridge_id: string;
  team_id: string;
  teams: { name: string } | { name: string }[] | null;
}

/**
 * Every `bridge_team_shares` row the RLS surfaces to the user, grouped by
 * bridge. Lets the bridges list label each bridge "Shared via Team X"
 * without one fetch per row. Refetch is exposed so share/unshare can
 * refresh the badges after a mutation.
 */
export function useBridgeSharesMap(): {
  sharesByBridge: Record<string, BridgeShare[]>;
  refetch: () => Promise<void>;
} {
  const { client, session } = useAuth();
  const [map, setMap] = useState<Record<string, BridgeShare[]>>({});

  const refetch = useCallback(async () => {
    const { data } = await client
      .from('bridge_team_shares')
      .select('bridge_id, team_id, teams(name)');
    const rows = (data ?? []) as ShareRow[];
    const next: Record<string, BridgeShare[]> = {};
    for (const r of rows) {
      const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
      const list = next[r.bridge_id] ?? [];
      list.push({ teamId: r.team_id, teamName: t?.name ?? 'a team' });
      next[r.bridge_id] = list;
    }
    setMap(next);
  }, [client]);

  useEffect(() => {
    if (session !== null) void refetch();
  }, [refetch, session]);

  return { sharesByBridge: map, refetch };
}

/**
 * Owner-only share/unshare mutations over the Phase 61 RPCs. `onChange`
 * lets the caller refresh derived state (the shares map) after a write.
 */
export function useBridgeSharing(onChange?: () => void | Promise<void>): {
  share: (bridgeId: string, teamId: string) => Promise<void>;
  unshare: (bridgeId: string, teamId: string) => Promise<void>;
} {
  const { client } = useAuth();

  const share = useCallback(
    async (bridgeId: string, teamId: string) => {
      const { error } = await client.rpc('share_bridge_with_team', {
        p_bridge: bridgeId,
        p_team: teamId,
      });
      if (error !== null) throw error;
      await onChange?.();
    },
    [client, onChange],
  );

  const unshare = useCallback(
    async (bridgeId: string, teamId: string) => {
      const { error } = await client.rpc('unshare_bridge', {
        p_bridge: bridgeId,
        p_team: teamId,
      });
      if (error !== null) throw error;
      await onChange?.();
    },
    [client, onChange],
  );

  return { share, unshare };
}
