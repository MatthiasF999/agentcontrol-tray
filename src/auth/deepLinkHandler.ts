import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import type { SupabaseClient } from "@supabase/supabase-js";

function parseHashFragment(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const hashIndex = input.indexOf("#");
  if (hashIndex === -1) return out;
  const frag = input.slice(hashIndex + 1);
  for (const pair of frag.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(
      pair.slice(eq + 1),
    );
  }
  return out;
}

async function handle(
  url: string,
  resolveClient: () => Promise<SupabaseClient | null>,
): Promise<void> {
  const client = await resolveClient();
  if (client === null) return;
  const params = parseHashFragment(url);
  const access = params["access_token"] ?? null;
  const refresh = params["refresh_token"] ?? null;
  if (access === null || refresh === null) return;
  await client.auth.setSession({ access_token: access, refresh_token: refresh });
}

export async function registerDeepLinkAuth(
  resolveClient: () => Promise<SupabaseClient | null>,
): Promise<() => void> {
  const initial = await getCurrent();
  if (initial !== null) {
    for (const u of initial) await handle(u, resolveClient);
  }
  return await onOpenUrl(async (urls) => {
    for (const u of urls) await handle(u, resolveClient);
  });
}
