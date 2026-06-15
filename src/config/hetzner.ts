// Single source of truth for the AgentControl deployment host. Build-time
// override via `VITE_HETZNER_HOST=my.host.example.com pnpm tauri build`;
// defaults to the user's own Hetzner CX23 box. Keep this file in sync with
// `src-tauri/src/config.rs` — the Rust-side commands have the same need
// and the env-var name must match.

const DEFAULT_HOST = '178.105.244.59';

export const HETZNER_HOST: string =
  (import.meta as ImportMeta & { env?: { VITE_HETZNER_HOST?: string } }).env
    ?.VITE_HETZNER_HOST ?? DEFAULT_HOST;

export const BASE_URL = `https://${HETZNER_HOST}`;
export const APP_URL = `${BASE_URL}/app`;
export const PAIR_BRIDGE_URL = `${APP_URL}/pair-bridge`;
export const OPERATOR_URL = `${BASE_URL}/operator`;
export const OPERATOR_DOWNLOAD_URL = `${OPERATOR_URL}/download`;
