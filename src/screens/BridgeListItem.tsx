import type { BridgeShare } from '../bridge/useBridgeShares';
import type { BridgeRow } from '../bridge/useBridgesList';
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
        <span
          className="badge"
          style={{
            backgroundColor: owned ? '#dbeafe' : '#fef9c3',
            color: owned ? '#1e3a8a' : '#713f12',
          }}
        >
          {ownershipLabel(owned, shares)}
        </span>
        {isCurrent && (
          <span
            className="badge"
            style={{ backgroundColor: '#dcfce7', color: '#14532d' }}
          >
            this machine
          </span>
        )}
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
