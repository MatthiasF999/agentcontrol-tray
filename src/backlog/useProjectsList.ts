import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";

export interface ProjectLite {
  id: string;
  name: string;
  slug: string;
}

interface Hook {
  projects: ProjectLite[];
  loading: boolean;
  error: string | null;
}

// Lightweight project picker source — fetches non-archived projects in the
// current org. Separate from useProjectsWithInstances (process screen) so the
// quick-add sheet doesn't pay for the instances join.
export function useProjectsList(orgId: string | null): Hook {
  const { client } = useAuth();
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null || orgId === null) {
      setProjects([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await client
        .from("projects")
        .select("id, name, slug")
        .eq("org_id", orgId)
        .is("archived_at", null)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (e !== null) setError(e.message);
      else if (data !== null) setProjects(data as ProjectLite[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  return { projects, loading, error };
}
