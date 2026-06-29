// Single source of truth for the AgentControl deployment host on the Rust
// side. Build-time override via `HETZNER_HOST=my.host.example.com cargo build`;
// defaults to the production domain. Each role lives on its own subdomain
// (api / app / operator / install) behind a Let's Encrypt cert. Keep in
// sync with the matching TS module at `src/config/hetzner.ts`.

const DEFAULT_HOST: &str = "agent-control.io";

pub fn hetzner_host() -> &'static str {
    // `option_env!()` returns `Some("")` when the env var is set but empty
    // (e.g. GH Actions `${{ vars.HETZNER_HOST }}` when the repo variable
    // isn't configured). Bare `unwrap_or` would treat that as "set" and
    // fall through to building URLs like `https://api./functions/...`,
    // which curl resolves to a bogus host → "Could not resolve host" at
    // the bridge-source step. Filter empty explicitly.
    match option_env!("HETZNER_HOST") {
        Some(h) if !h.is_empty() => h,
        _ => DEFAULT_HOST,
    }
}

fn subdomain(sub: &str) -> String {
    format!("https://{}.{}", sub, hetzner_host())
}

/// `https://api.<host>` — Supabase REST/auth root + bridge env writer.
pub fn supabase_url() -> String {
    subdomain("api")
}

/// `https://install.<host>/bridge.tar.gz` — bridge source tarball.
pub fn bridge_tarball_url() -> String {
    format!("{}/bridge.tar.gz", subdomain("install"))
}

/// `https://operator.<host>/` — admin portal.
pub fn operator_portal_url() -> String {
    format!("{}/", subdomain("operator"))
}

/// `https://api.<host>/functions/v1` — Supabase edge functions root.
pub fn supabase_functions_url() -> String {
    format!("{}/functions/v1", supabase_url())
}

/// Long-lived public anon JWT — already shipped in every web bundle
/// (role=anon, no privileges beyond what RLS allows). Embedded so the
/// bridge can call `bridge-claim` on boot before any pairing exists.
pub const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgwMjcxNDM2LCJleHAiOjIwOTU2MzE0MzZ9.X6qsRCvwhSg-dAQVQd188B8YoE1fZPi8I07nDnmww2A";
