# Phase 27.2 — Cross-repo deltas needed for end-to-end pairing

The tray-side of 27.2 ships complete: PairScreen, BridgeClient HTTP wrapper,
pair-status polling hook, post-login routing that gates HomeScreen on the
bridge's `paired` state. Two backend deltas land it end-to-end.

## Delta A — `agentcontrol-bridge`: add `POST /pair/accept`

**File**: new `src/routes/pairAccept.ts` (TDD per bridge CLAUDE.md — sibling
`pairAccept.test.ts` required).

**Mount**: `src/index.ts`, BEFORE the API_KEY auth middleware (analog
existing `/pair` GET route). Justification: pairing handshake establishes
the shared secret — pre-pairing the tray has no API_KEY yet.

**Contract**:

```http
POST /pair/accept
Content-Type: application/json

{
  "bridge_id": "<uuid>",
  "refresh_token": "<supabase-refresh-token>",
  "supabase_url": "https://supabase.example.com"
}
```

Response shapes:

| Status | Body |
|---|---|
| 200 | `{paired: true, bridge_id, org_id}` |
| 409 | `{error: "already_paired", bridge_id, org_id}` (when bridge-token.json present) |
| 400 | `{error: "invalid_payload", detail}` |
| 502 | `{error: "supabase_unreachable"}` (network or RPC failure during the bridge-refresh exchange) |

**Logic**:
1. If `data/bridge-token.json` exists → 409
2. Validate body shape → 400 on fail
3. Call existing `bridge-refresh` Supabase RPC with `refresh_token` to
   verify the token is real and minted for the claimed `bridge_id`
4. Persist `{bridgeId, orgId, refreshToken, supabaseUrl}` to
   `data/bridge-token.json` via the existing `token-store.ts` `writeToken()`
5. Trigger bridge bootstrap (analog the env-injection bootstrap in
   `scripts/smoke-pairing.ts` after writeToken)
6. Return 200 with `{paired: true, bridge_id, org_id}`

**Test coverage** (sibling `pairAccept.test.ts`):
- 200 path with mocked supabase + mocked writeToken
- 409 when token already exists
- 400 on missing field
- 502 on supabase RPC failure
- Verify bootstrap-trigger called exactly once on success

## Delta B — `supabase`: SECURITY DEFINER RPC `bridge_mint_token`

(Only needed for the upcoming "quick-pair" UI in a 27.2 follow-up. The
operator-paste form in 27.2's PairScreen works against Delta A alone using
a token minted via the existing `scripts/smoke-pairing.ts`.)

**Migration**: new `supabase/migrations/00XX_bridge_mint_token.sql`

**Function signature**:

```sql
CREATE OR REPLACE FUNCTION public.bridge_mint_token(
  p_org_id uuid,
  p_bridge_name text
) RETURNS TABLE(bridge_id uuid, refresh_token text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_new_bridge_id uuid;
BEGIN
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING errcode = '28000';
  END IF;
  -- Caller must be a member of the org with role >= 'admin'
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller_uid AND org_id = p_org_id AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  -- Insert bridge row (analog existing bridge-creation flow)
  INSERT INTO bridges (org_id, name, created_by)
  VALUES (p_org_id, p_bridge_name, v_caller_uid)
  RETURNING id INTO v_new_bridge_id;
  -- Issue a long-lived refresh-token (the same mechanism existing pairing
  -- uses — likely a `bridge_principal` JWT crafted server-side)
  -- For implementation, reuse the existing `bridges.refresh_token` column
  -- logic — see Phase 15.2 bridge-refresh RPC for the canonical pattern
  RETURN QUERY
  SELECT v_new_bridge_id, mint_bridge_refresh_token(v_new_bridge_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.bridge_mint_token TO authenticated;
```

**Tests** (in `tests/` per existing migration test pattern):
- success path: admin user creates bridge, gets back bridge_id + refresh_token
- forbidden path: non-admin member rejected with 42501
- unauthenticated path: anonymous rejected with 28000
- cross-org: admin in org A cannot mint in org B (test the membership check)

## Tray-side follow-up (after Delta B lands)

Add a "Quick pair" button to `PairScreen` that:

1. Calls `supabase.rpc('bridge_mint_token', {p_org_id, p_bridge_name})` →
   `{bridge_id, refresh_token}`
2. Pre-fills the form with those values
3. Auto-submits → bridge.acceptPairing(...) → done

This is ~30 lines of React. Lands in a 27.2.1 micro-iter once Delta B is
deployed.

## Hard-commit-scope honored

The tray ships **without** waiting for Deltas A+B because:
- Operator-paste form is functional today against the existing operator
  pairing flow (after Delta A lands)
- Pair-status polling is already wired against the existing `GET /pair`
- The error-path in PairScreen.tsx detects the 404 from a missing
  `/pair/accept` route and surfaces a precise pointer back to this doc
