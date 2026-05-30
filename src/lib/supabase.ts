import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { settings, supabaseStorageAdapter } from "./storage";

const URL_KEY = "supabase.url";
const ANON_KEY_KEY = "supabase.anon_key";

let _client: SupabaseClient | null = null;
let _currentUrl: string | null = null;

export async function getStoredSupabaseConfig(): Promise<
  { url: string; anonKey: string } | null
> {
  const url = await settings.get<string>(URL_KEY);
  const anonKey = await settings.get<string>(ANON_KEY_KEY);
  if (url === null || anonKey === null) return null;
  return { url, anonKey };
}

export async function saveSupabaseConfig(
  url: string,
  anonKey: string,
): Promise<void> {
  await settings.set(URL_KEY, url);
  await settings.set(ANON_KEY_KEY, anonKey);
  _client = null;
  _currentUrl = null;
}

export async function clearSupabaseConfig(): Promise<void> {
  await settings.remove(URL_KEY);
  await settings.remove(ANON_KEY_KEY);
  _client = null;
  _currentUrl = null;
}

export async function getSupabase(): Promise<SupabaseClient | null> {
  const cfg = await getStoredSupabaseConfig();
  if (cfg === null) return null;
  if (_client !== null && _currentUrl === cfg.url) return _client;
  _client = createClient(cfg.url, cfg.anonKey, {
    auth: {
      storage: supabaseStorageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  _currentUrl = cfg.url;
  return _client;
}
