import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { BACKLOG_ITEM_FIELDS, type BacklogItem } from './types';

interface Hook {
  items: BacklogItem[];
  loading: boolean;
  error: string | null;
}

// Org-scoped consumption view — tray is read-only (architect §10.2).
// Cap PAGE_SIZE high enough for the "compact backlog" view but small enough
// that the tray webview stays snappy on slow boxes (200 ≈ ~6 months of org
// activity at Hacker School's pace).
const PAGE_SIZE = 200;

function applyChange(
  prev: BacklogItem[],
  next: BacklogItem | null,
  oldId: string | undefined,
  event: string,
): BacklogItem[] {
  if (event === 'DELETE' && oldId !== undefined) {
    return prev.filter((i) => i.id !== oldId);
  }
  if (next === null) return prev;
  const without = prev.filter((i) => i.id !== next.id);
  return [next, ...without];
}

export function useBacklogItems(orgId: string | null): Hook {
  const { client } = useAuth();
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (client === null || orgId === null) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      const { data, error: e } = await client
        .from('backlog_items')
        .select(BACKLOG_ITEM_FIELDS)
        .eq('org_id', orgId)
        .order('priority', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (cancelled) return;
      if (e !== null) setError(e.message);
      else if (data !== null) setItems(data as BacklogItem[]);
      setLoading(false);
    })();

    const channel = client
      .channel(`backlog-items-${orgId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'backlog_items',
          filter: `org_id=eq.${orgId}`,
        },
        (payload) => {
          if (cancelled) return;
          const next = (payload.new as BacklogItem | null) ?? null;
          const oldId = (payload.old as { id?: string } | null)?.id;
          setItems((prev) =>
            applyChange(prev, next, oldId, payload.eventType).slice(
              0,
              PAGE_SIZE,
            ),
          );
        },
      )
      .subscribe();
    channelRef.current = channel;

    return () => {
      cancelled = true;
      if (channelRef.current !== null) {
        void client.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [client, orgId]);

  return { items, loading, error };
}
