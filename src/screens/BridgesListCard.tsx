import { useAuth } from '../auth/AuthContext';
import {
  useBridgeSharesMap,
  useBridgeSharing,
} from '../bridge/useBridgeShares';
import { useBridgesList } from '../bridge/useBridgesList';
import { BridgeListItem } from './BridgeListItem';

interface Props {
  currentBridgeId: string | null;
}

export function BridgesListCard({ currentBridgeId }: Props) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const { bridges, loading, error } = useBridgesList();
  const { sharesByBridge, refetch } = useBridgeSharesMap();
  const { share, unshare } = useBridgeSharing(refetch);

  return (
    <section className="card">
      <h2>All your bridges</h2>
      {loading && <p className="muted">Loading…</p>}
      {error !== null && <div className="error">{error}</div>}
      {!loading && bridges.length === 0 && (
        <p className="muted">
          No bridges visible. RLS only surfaces bridges you own or that a team
          shared with you.
        </p>
      )}
      {bridges.length > 0 && (
        <ul className="task-list">
          {bridges.map((b) => (
            <BridgeListItem
              key={b.id}
              bridge={b}
              owned={userId !== null && b.owner_user_id === userId}
              shares={sharesByBridge[b.id] ?? []}
              isCurrent={b.id === currentBridgeId}
              onShare={share}
              onUnshare={unshare}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
