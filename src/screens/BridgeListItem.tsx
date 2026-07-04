import type { BridgeShare } from '../bridge/useBridgeShares';
import type { BridgeRow } from '../bridge/useBridgesList';
import { Colors } from '../theme/tokens';
import { BridgeShareControls } from './teams/BridgeShareControls';

interface Props {
  bridge: BridgeRow;
  owned: boolean;
  shares: BridgeShare[];
  isCurrent: boolean;
  onShare: (bridgeId: string, teamId: string) => Promise<void>;
  onUnshare: (bridgeId: string, teamId: string) => Promise<void>;
}

function relativeSeen(iso: string | null): string {
  if (iso === null) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function ownershipLabel(owned: boolean, shares: BridgeShare[]): string {
  if (owned) return 'Owned';
  if (shares.length > 0) return `Shared via ${shares[0].teamName}`;
  return 'Shared with you';
}

function BridgeBadges({
  owned,
  shares,
  isCurrent,
}: {
  owned: boolean;
  shares: BridgeShare[];
  isCurrent: boolean;
}) {
  const ownStyle = owned
    ? { backgroundColor: Colors.statusInfoTint, color: Colors.statusInfoInk }
    : { backgroundColor: Colors.statusWaitTint, color: Colors.statusWaitInk };
  const hereStyle = {
    backgroundColor: Colors.statusDoneTint,
    color: Colors.statusDoneInk,
  };
  return (
    <>
      <span className="badge" style={ownStyle}>
        {ownershipLabel(owned, shares)}
      </span>
      {isCurrent && (
        <span className="badge" style={hereStyle}>
          this machine
        </span>
      )}
    </>
  );
}

export function BridgeListItem({
  bridge,
  owned,
  shares,
  isCurrent,
  onShare,
  onUnshare,
}: Props) {
  return (
    <li className="task-row">
      <div className="task-row-head">
        <span>{bridge.name ?? '(unnamed)'}</span>
        <BridgeBadges owned={owned} shares={shares} isCurrent={isCurrent} />
      </div>
      <dl className="kv">
        <dt>Bridge ID</dt>
        <dd>
          <code className="endpoint">{bridge.id}</code>
        </dd>
        <dt>Last seen</dt>
        <dd>{relativeSeen(bridge.last_seen_at)}</dd>
      </dl>
      {owned && (
        <BridgeShareControls
          bridgeId={bridge.id}
          orgId={bridge.org_id}
          sharedTeamIds={shares.map((s) => s.teamId)}
          onShare={onShare}
          onUnshare={onUnshare}
        />
      )}
    </li>
  );
}
