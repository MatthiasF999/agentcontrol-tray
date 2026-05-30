import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { useBridge } from "../bridge/BridgeClientContext";
import { usePairingStatus } from "../bridge/usePairingStatus";
import { BridgeError } from "../bridge/bridgeClient";

export function PairScreen() {
  const { supabaseUrl, signOut } = useAuth();
  const bridge = useBridge();
  const { status, error: pollError, refresh } = usePairingStatus();
  const [bridgeId, setBridgeId] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (supabaseUrl === null) return;
    setSubmitError(null);
    setBusy(true);
    try {
      await bridge.acceptPairing({
        bridge_id: bridgeId.trim(),
        refresh_token: refreshToken.trim(),
        supabase_url: supabaseUrl,
      });
      await refresh();
    } catch (e) {
      if (e instanceof BridgeError && e.status === 404) {
        setSubmitError(
          "Bridge does not implement POST /pair/accept yet. " +
            "See docs/PHASE-27-2-CROSS-REPO.md for the additive route spec.",
        );
      } else {
        setSubmitError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow">
      <header className="brand">
        <h1>Pair this bridge</h1>
        {status !== null && (
          <p className="muted">
            Bridge state: <code className="endpoint">{status.state}</code>
          </p>
        )}
        {pollError !== null && (
          <p className="muted">
            Bridge unreachable: <code className="endpoint">{pollError}</code>
          </p>
        )}
      </header>

      <section className="card">
        <h2>Manual pairing</h2>
        <p className="muted">
          Mint a bridge token in Supabase (operator flow), then paste here.
          Quick-pair UI ships in 27.2 cross-repo follow-up.
        </p>
        <form className="form" onSubmit={onSubmit}>
          <label>
            <span>Bridge ID</span>
            <input
              type="text"
              placeholder="01HXYZ…"
              value={bridgeId}
              onChange={(e) => setBridgeId(e.target.value)}
              required
            />
          </label>
          <label>
            <span>Refresh token</span>
            <textarea
              placeholder="eyJhbGciOi…"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              rows={3}
              required
            />
          </label>
          {submitError !== null && <div className="error">{submitError}</div>}
          <button type="submit" disabled={busy || status?.state === "paired"}>
            {busy
              ? "Pairing…"
              : status?.state === "paired"
              ? "Already paired"
              : "Pair this bridge"}
          </button>
        </form>
      </section>

      <button type="button" className="link" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}
