import { useMemo, useState } from 'react';
import type {
  BacklogItem,
  BacklogItemState,
  BacklogRelease,
} from '../backlog/types';
import { useBacklogItems } from '../backlog/useBacklogItems';
import { useBacklogReleases } from '../backlog/useBacklogReleases';
import { useStandupDigest } from '../backlog/useStandupDigest';
import { usePairingStatus } from '../bridge/usePairingStatus';
import { Colors } from '../theme/tokens';
import { BacklogQuickAddButton } from './BacklogQuickAddButton';
import { DigestModal } from './DigestModal';

interface Props {
  onBack: () => void;
  showDigestOnOpen?: boolean;
}

const ERROR = { bg: Colors.statusErrorTint, fg: Colors.statusErrorInk };
const WAIT = { bg: Colors.statusWaitTint, fg: Colors.statusWaitInk };
const INFO = { bg: Colors.statusInfoTint, fg: Colors.statusInfoInk };
const IDLE = { bg: Colors.statusIdleTint, fg: Colors.statusIdleInk };
const DONE = { bg: Colors.statusDoneTint, fg: Colors.statusDoneInk };

const PRIORITY_COLOR: Record<string, { bg: string; fg: string }> = {
  P0: ERROR,
  P1: WAIT,
  P2: INFO,
  P3: IDLE,
};

const STATE_COLOR: Record<string, { bg: string; fg: string }> = {
  idea: IDLE,
  groomed: INFO,
  scheduled: INFO,
  in_progress: WAIT,
  done: DONE,
  released: DONE,
  blocked: ERROR,
  cancelled: IDLE,
};

function Badge({ kind, value }: { kind: 'priority' | 'state'; value: string }) {
  const map = kind === 'priority' ? PRIORITY_COLOR : STATE_COLOR;
  const c = map[value] ?? IDLE;
  return (
    <span className="badge" style={{ backgroundColor: c.bg, color: c.fg }}>
      {value}
    </span>
  );
}

function ItemRow({ item }: { item: BacklogItem }) {
  return (
    <li className="backlog-row">
      <div className="backlog-row-head">
        <Badge kind="priority" value={item.priority} />
        <Badge kind="state" value={item.state} />
        {item.size !== null && <span className="badge size">{item.size}</span>}
      </div>
      <div className="backlog-title">{item.title}</div>
      {item.blocked_reason !== null && (
        <div className="muted">⛔ {item.blocked_reason}</div>
      )}
    </li>
  );
}

function ReleaseSection({
  release,
  items,
}: {
  release: BacklogRelease | null;
  items: BacklogItem[];
}) {
  const heading =
    release === null
      ? 'Unscheduled (no release)'
      : `${release.name}${release.semver !== null ? ` · ${release.semver}` : ''}`;
  const sub =
    release === null
      ? `${items.length} item${items.length === 1 ? '' : 's'}`
      : `${release.state} · ${items.length} item${items.length === 1 ? '' : 's'}${release.target_date !== null ? ` · target ${release.target_date}` : ''}`;
  return (
    <section className="card">
      <div className="project-card-head">
        <h2>{heading}</h2>
        <span className="muted">{sub}</span>
      </div>
      {release?.goal_markdown !== null &&
        release?.goal_markdown !== undefined && (
          <p className="muted">{release.goal_markdown}</p>
        )}
      {items.length === 0 ? (
        <p className="muted">No items.</p>
      ) : (
        <ul className="backlog-list">
          {items.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Filter = 'all' | 'active' | 'blocked' | 'released';

function passes(filter: Filter, item: BacklogItem): boolean {
  if (filter === 'all') return true;
  if (filter === 'blocked') return item.state === 'blocked';
  if (filter === 'released')
    return item.state === 'released' || item.state === 'done';
  const active: BacklogItemState[] = ['groomed', 'scheduled', 'in_progress'];
  return active.includes(item.state);
}

function groupByRelease(
  items: BacklogItem[],
  releases: BacklogRelease[],
): Array<{ release: BacklogRelease | null; items: BacklogItem[] }> {
  // Active releases first, then planning, then unscheduled bucket.
  const ordered = [...releases].sort((a, b) => {
    const rank = (s: string) => (s === 'active' ? 0 : s === 'planning' ? 1 : 2);
    return rank(a.state) - rank(b.state);
  });
  const groups = ordered.map((r) => ({
    release: r as BacklogRelease | null,
    items: items.filter((i) => i.release_id === r.id),
  }));
  groups.push({
    release: null,
    items: items.filter((i) => i.release_id === null),
  });
  return groups.filter((g) => g.items.length > 0 || g.release !== null);
}

export function BacklogConsumptionScreen({ onBack, showDigestOnOpen }: Props) {
  const { status } = usePairingStatus();
  const orgId = status?.state === 'paired' ? status.orgId : null;
  const { items, loading, error } = useBacklogItems(orgId);
  const { releases } = useBacklogReleases(orgId);
  const { latest: digest } = useStandupDigest(orgId);
  const [filter, setFilter] = useState<Filter>('active');
  const [digestOpen, setDigestOpen] = useState<boolean>(
    showDigestOnOpen === true,
  );

  const filtered = useMemo(
    () => items.filter((i) => passes(filter, i)),
    [items, filter],
  );
  const groups = useMemo(
    () => groupByRelease(filtered, releases),
    [filtered, releases],
  );

  return (
    <main className="container">
      <header className="brand">
        <button type="button" className="link" onClick={onBack}>
          ← Home
        </button>
        <h1>Backlog</h1>
        <p className="muted">
          Read-only view of your org's backlog. Submit ideas via the floating
          button; full editing lives in the AgentControl app.
        </p>
      </header>

      {digest !== null && digest.digest_markdown !== null && (
        <section className="card digest-banner">
          <strong>Latest standup digest</strong>{' '}
          <span className="muted">
            {digest.delivered_at !== null
              ? new Date(digest.delivered_at).toLocaleString()
              : ''}
          </span>
          <button
            type="button"
            className="link"
            onClick={() => setDigestOpen(true)}
          >
            View
          </button>
        </section>
      )}

      <div className="filter-row">
        {(['active', 'blocked', 'released', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={f === filter ? 'filter-on' : ''}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {orgId === null && (
        <section className="card">
          <p className="muted">Pair this tray to a bridge to load backlog.</p>
        </section>
      )}
      {loading && orgId !== null && (
        <section className="card">
          <p className="muted">Loading…</p>
        </section>
      )}
      {error !== null && <div className="error">{error}</div>}
      {!loading && orgId !== null && groups.length === 0 && (
        <section className="card">
          <p className="muted">Nothing matches this filter yet.</p>
        </section>
      )}
      {groups.map((g) => (
        <ReleaseSection
          key={g.release?.id ?? 'unscheduled'}
          release={g.release}
          items={g.items}
        />
      ))}

      {orgId !== null && <BacklogQuickAddButton orgId={orgId} />}
      {digestOpen &&
        digest?.digest_markdown !== undefined &&
        digest?.digest_markdown !== null && (
          <DigestModal
            markdown={digest.digest_markdown}
            onClose={() => setDigestOpen(false)}
          />
        )}
    </main>
  );
}
