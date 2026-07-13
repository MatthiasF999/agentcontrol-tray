import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL } from '../config/hetzner';
import { supabaseStorageAdapter } from './storage';

// AgentControl is a hosted product: app + tray + bridge all talk to the
// same operator-managed Supabase on Hetzner. Users don't have a personal
// Supabase to point at — wiring URL + anonKey through a "Connect" screen
// was a leftover from the early "BYO Supabase" prototype. Hard-code the
// values (override at build time via the env vars consumed by
// `config/hetzner.ts`).
//
// The anon JWT is `role=anon` — it ships in every web bundle by design;
// RLS does the load-bearing isolation server-side, the anon key only
// grants the routes the user could already hit unauthenticated.
const SUPABASE_ANON_KEY =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc4Mjc3MTAwMCwiZXhwIjo0OTM4NDQ0NjAwLCJyb2xlIjoiYW5vbiJ9.epxEJlR4mDrT10iYlWFbn6kZxATOPYBuWbgG09sVoeE';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client !== null) return _client;
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: supabaseStorageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return _client;
}

/** Backwards-compat shim for callers that still expect the old async shape. */
export function getStoredSupabaseConfig(): { url: string; anonKey: string } {
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
}
