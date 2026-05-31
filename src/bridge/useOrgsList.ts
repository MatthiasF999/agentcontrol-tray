import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface Hook {
  orgs: Org[];
  loading: boolean;
  error: string | null;
}

/**
 * Lists orgs the user is a member of, joined with their role for each.
 * Used by PairScreen quick-pair to scope the bridge-mint to a chosen
 * org (only owner/admin roles can call pair_bridge).
 */
export function useOrgsList(): Hook {
  const { client, session } = useAuth();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null || session === null) {
      setOrgs([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await client
        .from('org_members')
        .select('role, org_id, organizations(id, name, slug)')
        .eq('user_id', session.user.id);
      if (cancelled) return;
      if (e !== null) {
        setError(e.message);
      } else if (data !== null) {
        // supabase-js types joined relations as arrays even for FK-1-to-1;
        // we treat each row's first organizations entry as the source.
        const rows = data as unknown as Array<{
          role: string;
          org_id: string;
          organizations:
            | { id: string; name: string; slug: string }
            | Array<{ id: string; name: string; slug: string }>
            | null;
        }>;
        const mapped: Org[] = rows.flatMap((r) => {
          const orgs = Array.isArray(r.organizations)
            ? r.organizations
            : r.organizations !== null
              ? [r.organizations]
              : [];
          return orgs.map((o) => ({
            id: o.id,
            name: o.name,
            slug: o.slug,
            role: r.role,
          }));
        });
        setOrgs(mapped);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  return { orgs, loading, error };
}
