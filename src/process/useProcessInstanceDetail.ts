import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useAuth } from "../auth/AuthContext";
import type {
  ProcessArtifactRow,
  ProcessInstanceRow,
  ProcessPhaseRunRow,
} from "./types";

interface Hook {
  instance: ProcessInstanceRow | null;
  artifacts: ProcessArtifactRow[];
  phaseRuns: ProcessPhaseRunRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const INSTANCE_FIELDS =
  "id, template_id, template_version, template_version_snapshot, org_id, project_id, title, current_phase_index, current_phase_status, worktree_path, created_at, updated_at, completed_at";
const ARTIFACT_FIELDS =
  "id, instance_id, phase_index, artifact_type, data, worktree_path, published_url, published_at, published_expires_at, bridge_id, created_at, updated_at";
const PHASE_RUN_FIELDS =
  "id, instance_id, phase_index, transition, actor, autonomous_task_id, note, at";

/**
 * Loads a single instance + its artifacts + its phase-run history. Subscribes
 * to realtime for each so the detail screen reacts to bridge writes (artifact
 * materialisation, phase transitions) without polling.
 */
export function useProcessInstanceDetail(instanceId: string | null): Hook {
  const { client } = useAuth();
  const [instance, setInstance] = useState<ProcessInstanceRow | null>(null);
  const [artifacts, setArtifacts] = useState<ProcessArtifactRow[]>([]);
  const [phaseRuns, setPhaseRuns] = useState<ProcessPhaseRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  async function loadInitial(): Promise<void> {
    if (client === null || instanceId === null) {
      setInstance(null);
      setArtifacts([]);
      setPhaseRuns([]);
      setLoading(false);
      return;
    }
    const [inst, arts, runs] = await Promise.all([
      client
        .from("process_instances")
        .select(INSTANCE_FIELDS)
        .eq("id", instanceId)
        .maybeSingle(),
      client
        .from("process_artifacts")
        .select(ARTIFACT_FIELDS)
        .eq("instance_id", instanceId)
        .order("created_at", { ascending: false }),
      client
        .from("process_phase_runs")
        .select(PHASE_RUN_FIELDS)
        .eq("instance_id", instanceId)
        .order("at", { ascending: true }),
    ]);
    if (inst.error !== null) {
      setError(inst.error.message);
    } else if (arts.error !== null) {
      setError(arts.error.message);
    } else if (runs.error !== null) {
      setError(runs.error.message);
    } else {
      setInstance((inst.data ?? null) as ProcessInstanceRow | null);
      setArtifacts((arts.data ?? []) as ProcessArtifactRow[]);
      setPhaseRuns((runs.data ?? []) as ProcessPhaseRunRow[]);
      setError(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (client === null || instanceId === null) {
      setInstance(null);
      setArtifacts([]);
      setPhaseRuns([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void loadInitial();

    const channel = client
      .channel(`process-instance-${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "process_instances",
          filter: `id=eq.${instanceId}`,
        },
        (payload) => {
          if (cancelled) return;
          const next = payload.new as ProcessInstanceRow | null;
          if (next !== null) setInstance(next);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "process_artifacts",
          filter: `instance_id=eq.${instanceId}`,
        },
        (payload) => {
          if (cancelled) return;
          const next = payload.new as ProcessArtifactRow | null;
          const old = payload.old as { id?: string } | null;
          if (payload.eventType === "DELETE" && old?.id !== undefined) {
            setArtifacts((prev) => prev.filter((a) => a.id !== old.id));
            return;
          }
          if (next === null) return;
          setArtifacts((prev) => {
            const without = prev.filter((a) => a.id !== next.id);
            return [next, ...without];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "process_phase_runs",
          filter: `instance_id=eq.${instanceId}`,
        },
        (payload) => {
          if (cancelled) return;
          const next = payload.new as ProcessPhaseRunRow | null;
          if (next === null) return;
          setPhaseRuns((prev) => [...prev, next]);
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
  }, [client, instanceId]);

  return { instance, artifacts, phaseRuns, loading, error, refresh: loadInitial };
}
