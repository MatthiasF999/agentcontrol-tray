-- ============================================================================
-- seed-test-user.sql — e2e pair-flow test fixtures
--
--   ⚠️  DO NOT AUTO-APPLY. This is NOT a migration. It is reference SQL for
--   provisioning a throwaway user + org used only by verify-pair-flow.mjs.
--   It must never run in the normal migration path or against a real tenant.
--
-- It is guarded so an accidental `psql -f` is a no-op unless you explicitly
-- opt in:  psql "$DB_URL" -v e2e_seed=1 -f seed-test-user.sql
-- (Without -v e2e_seed=1 the DO block raises a notice and changes nothing.)
--
-- Cleanup:  delete the org + auth user by the ids/emails below when done.
-- ============================================================================

\set ON_ERROR_STOP on
-- Default the guard to 0 when the caller did not pass -v e2e_seed=1.
\if :{?e2e_seed} \else \set e2e_seed 0 \endif

\if :e2e_seed
\echo 'e2e_seed=1 — applying test fixtures'
\else
\echo 'e2e seed skipped — re-run with -v e2e_seed=1 to apply. No changes made.'
\endif

\if :e2e_seed

-- Dedicated RLS-scoped org for the installer e2e user.
INSERT INTO public.orgs (id, name)
VALUES ('00000000-0000-0000-0000-0000000000e2', 'e2e-installer-org')
ON CONFLICT (id) DO NOTHING;

-- Auth user. GoTrue owns auth.users; generateLink() from verify-pair-flow.mjs
-- can also create the user on the fly, so this row is optional. Prefer the
-- GoTrue admin API (admin.auth.admin.createUser) over hand-writing auth.users.
INSERT INTO auth.users (id, email, aud, role, email_confirmed_at, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-0000000000e3',
  'e2e-installer-test@agentcontrol.dev',
  'authenticated', 'authenticated', now(), now(), now()
)
ON CONFLICT (id) DO NOTHING;

-- Owner membership so the user may call pair_bridge for this org.
-- NOTE: verify the actual membership table + role enum in your schema
-- (org_members / memberships, role 'owner') before running.
INSERT INTO public.org_members (org_id, user_id, role)
VALUES (
  '00000000-0000-0000-0000-0000000000e2',
  '00000000-0000-0000-0000-0000000000e3',
  'owner'
)
ON CONFLICT DO NOTHING;

\endif
