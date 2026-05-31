import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useAuth } from "../auth/AuthContext";
import type {
  ProcessInstanceRow,
  ProjectRow,
  ProjectWithInstances,
} from "./types";

interface Hook {
  groups: ProjectWithInstances[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const INSTANCE_FIELDS =
  "id, template_id, template_version, template_version_snapshot, org_id, project_id, title, current_phase_index, current_phase_status, worktree_path, created_at, updated_at, completed_at";

const PROJECT_FIELDS =
  "id, org_id, name, slug, description, default_template_id, archived_at, created_at";

/**
 * Lists every active project in the org with its process_instances inline.
 * Includes a realtime channel so newly created instances pop in without a
 * refresh. Closed instances stay visible as history; archived projects are
 * filtered out.
 */
export function useProjectsWithInstances(orgId: string | null): Hook {
  const { client } = useAuth();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [instances, setInstances] = useState<ProcessInstanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  async function loadInitial(): Promise<void> {
    if (client === null || orgId === null) {
      setProjects([]);
      setInstances([]);
      setLoading(false);
      return;
    }
    const [pj, inst] = await Promise.all([
      client
        .from("projects")
        .select(PROJECT_FIELDS)
        .eq("org_id", orgId)
        .is("archived_at", null)
        .order("created_at", { ascending: false }),
      client
        .from("process_instances")
        .select(INSTANCE_FIELDS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false }),
    ]);
    if (pj.error !== null) {
      setError(pj.error.message);
    } else if (inst.error !== null) {
      setError(inst.error.message);
    } else {
      setProjects((pj.data ?? []) as ProjectRow[]);
      setInstances((inst.data ?? []) as ProcessInstanceRow[]);
      setError(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (client === null || orgId === null) {
      setProjects([]);
      setInstances([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void loadInitial();

    const channel = client
      .channel(`process-instances-${orgId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "process_instances",
          filter: `org_id=eq.${orgId}`,
        },
        (payload) => {
          if (cancelled) return;
          const next = payload.new as ProcessInstanceRow | null;
          const old = payload.old as { id?: string } | null;
          if (payload.eventType === "DELETE" && old?.id !== undefined) {
            setInstances((prev) => prev.filter((i) => i.id !== old.id));
            return;
          }
          if (next === null) return;
          setInstances((prev) => {
            const without = prev.filter((i) => i.id !== next.id);
            return [next, ...without];
          });
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

  const groups: ProjectWithInstances[] = projects.map((p) => ({
    project: p,
    instances: instances.filter((i) => i.project_id === p.id),
  }));

  return { groups, loading, error, refresh: loadInitial };
}
