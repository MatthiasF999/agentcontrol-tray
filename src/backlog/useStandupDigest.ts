import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useAuth } from "../auth/AuthContext";
import { notify } from "../lib/notifier";
import { STANDUP_TASK_FIELDS, type StandupTask } from "./types";

interface Hook {
  latest: StandupTask | null;
  loading: boolean;
  error: string | null;
}

// Module-level dedupe: each delivered row fires exactly one OS notification
// per tray session, even if multiple components mount this hook.
const NOTIFIED = new Set<string>();

function summarize(markdown: string | null): string {
  if (markdown === null) return "New standup digest available.";
  const firstLine = markdown.split("\n").find((l) => l.trim().length > 0);
  const stripped = (firstLine ?? "").replace(/^#+\s*/, "").trim();
  if (stripped.length === 0) return "New standup digest available.";
  return stripped.length > 120 ? `${stripped.slice(0, 117)}…` : stripped;
}

async function maybeNotify(row: StandupTask): Promise<void> {
  if (row.state !== "delivered") return;
  if (NOTIFIED.has(row.id)) return;
  NOTIFIED.add(row.id);
  await notify("AgentControl — standup digest", summarize(row.digest_markdown));
}

export function useStandupDigest(orgId: string | null): Hook {
  const { client } = useAuth();
  const [latest, setLatest] = useState<StandupTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (client === null || orgId === null) {
      setLatest(null);
      setLoading(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      const { data, error: e } = await client
        .from("backlog_standup_tasks")
        .select(STANDUP_TASK_FIELDS)
        .eq("org_id", orgId)
        .eq("state", "delivered")
        .order("delivered_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (cancelled) return;
      if (e !== null) setError(e.message);
      else if (data !== null && data.length > 0) {
        const row = data[0] as StandupTask;
        setLatest(row);
        // First-load: register as already-notified so reopening the tray
        // doesn't spam the operator with yesterday's digest.
        NOTIFIED.add(row.id);
      }
      setLoading(false);
    })();

    const channel = client
      .channel(`standup-${orgId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "backlog_standup_tasks",
          filter: `org_id=eq.${orgId}`,
        },
        (payload) => {
          if (cancelled) return;
          const next = payload.new as StandupTask | null;
          if (next === null || next.state !== "delivered") return;
          setLatest(next);
          void maybeNotify(next);
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

  return { latest, loading, error };
}
