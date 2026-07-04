import { useOrgTeams } from '../../bridge/useTeams';
import { Colors } from '../../theme/tokens';

interface Props {
  bridgeId: string;
  orgId: string;
  /** Team ids this bridge is currently shared with. */
  sharedTeamIds: string[];
  onShare: (bridgeId: string, teamId: string) => Promise<void>;
  onUnshare: (bridgeId: string, teamId: string) => Promise<void>;
}

/**
 * Owner-only controls: one toggle per team in the bridge's org. A bridge
 * can only be shared with teams in its own org, so the picker is scoped by
 * `list_org_teams(orgId)`. Rendered only when the caller owns the bridge.
 */
export function BridgeShareControls({
  bridgeId,
  orgId,
  sharedTeamIds,
  onShare,
  onUnshare,
}: Props) {
  const teams = useOrgTeams(orgId);
  if (teams.length === 0) {
    return <p className="muted">No teams in this org to share with yet.</p>;
  }
  return (
    <div className="share-controls">
      <span className="muted">Share with teams:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {teams.map((t) => {
          const shared = sharedTeamIds.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              className="badge"
              style={{
                cursor: 'pointer',
                backgroundColor: shared ? Colors.statusDoneTint : Colors.subtle,
                color: shared ? Colors.statusDoneInk : Colors.textBody,
              }}
              onClick={() =>
                void (shared
                  ? onUnshare(bridgeId, t.id)
                  : onShare(bridgeId, t.id))
              }
            >
              {t.name}: {shared ? 'Shared ✓' : 'Share'}
            </button>
          );
        })}
      </div>
    </div>
  );
}
