import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { notify } from '../lib/notifier';

export interface AutonomousTask {
  id: string;
  prompt: string | null;
  status: string;
  created_at: string;
  claimed_by_bridge_id: string | null;
}

interface Hook {
  tasks: AutonomousTask[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 5;
const NOTIFY_SET = new Set<string>();

export function useRecentTasks(orgId: string | null): Hook {
  const { client } = useAuth();
  const [tasks, setTasks] = useState<AutonomousTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (client === null || orgId === null) {
      setTasks([]);
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function fetchInitial(): Promise<void> {
      if (client === null) return;
      const { data, error: e } = await client
        .from('autonomous_tasks')
        .select('id, prompt, status, created_at, claimed_by_bridge_id')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (cancelled) return;
      if (e !== null) {
        setError(e.message);
      } else if (data !== null) {
        setTasks(data as AutonomousTask[]);
        for (const t of data as AutonomousTask[]) {
          if (t.status === 'awaiting_approval') NOTIFY_SET.add(t.id);
        }
      }
      setLoading(false);
    }

    void fetchInitial();

    const channel = client
      .channel(`autonomous-tasks-${orgId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'autonomous_tasks',
          filter: `org_id=eq.${orgId}`,
        },
        (payload) => {
          const next = payload.new as AutonomousTask | null;
          if (next === null) return;
          setTasks((prev) => {
            const without = prev.filter((t) => t.id !== next.id);
            return [next, ...without].slice(0, PAGE_SIZE);
          });
          if (next.status === 'awaiting_approval' && !NOTIFY_SET.has(next.id)) {
            NOTIFY_SET.add(next.id);
            const preview =
              next.prompt !== null ? next.prompt.slice(0, 80) : 'Task';
            void notify('AgentControl — approval required', preview);
          }
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

  return { tasks, loading, error };
}
