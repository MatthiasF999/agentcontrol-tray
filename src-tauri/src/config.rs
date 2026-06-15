// Single source of truth for the AgentControl deployment host on the Rust
// side. Build-time override via `HETZNER_HOST=my.host.example.com cargo build`;
// defaults to the user's own Hetzner CX23 box. Keep in sync with the
// matching TS module at `src/config/hetzner.ts`.

const DEFAULT_HOST: &str = "178.105.244.59";

pub fn hetzner_host() -> &'static str {
    // `option_env!()` returns `Some("")` when the env var is set but empty
    // (e.g. GH Actions `${{ vars.HETZNER_HOST }}` when the repo variable
    // isn't configured). Bare `unwrap_or` would treat that as "set" and
    // fall through to building URLs like `https:///install/...`, which
    // curl resolves to host `install` → "Could not resolve host" at the
    // bridge-source step. Filter empty explicitly.
    match option_env!("HETZNER_HOST") {
        Some(h) if !h.is_empty() => h,
        _ => DEFAULT_HOST,
    }
}

/// `https://<host>` — bridge env writer + tarball download root.
pub fn base_url() -> String {
    format!("https://{}", hetzner_host())
}

/// `https://<host>/install/bridge.tar.gz` — bridge source tarball.
pub fn bridge_tarball_url() -> String {
    format!("{}/install/bridge.tar.gz", base_url())
}

/// `https://<host>/operator/` — admin portal (Caddy-served).
pub fn operator_portal_url() -> String {
    format!("{}/operator/", base_url())
}

/// `https://<host>/functions/v1` — Supabase edge functions root.
pub fn supabase_functions_url() -> String {
    format!("{}/functions/v1", base_url())
}

/// Long-lived public anon JWT — already shipped in every web bundle
/// (role=anon, no privileges beyond what RLS allows). Embedded so the
/// bridge can call `bridge-claim` on boot before any pairing exists.
pub const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgwMjcxNDM2LCJleHAiOjIwOTU2MzE0MzZ9.X6qsRCvwhSg-dAQVQd188B8YoE1fZPi8I07nDnmww2A";
