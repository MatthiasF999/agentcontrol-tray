/**
 * AboutCard — Phase 43 Add-30 — Tray "About" section in SettingsScreen.
 *
 * Renders the latest 2 CHANGELOG entries inline (Unreleased + most
 * recent shipped). Bundled markdown is parsed in-process; a "Show all"
 * link routes to operator-portal Releases tab (Add-31, owned by the
 * operator-portal repo — until that lands, the link points at
 * `${supabaseUrl}/releases` which 404s gracefully).
 *
 * Wire: SettingsScreen mounts <AboutCard supabaseUrl={...} /> below
 * UpdaterCard.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { useMemo } from 'react';
import {
  type ChangelogEntry,
  type ChangelogSectionKey,
  latestEntries,
  parseChangelog,
} from '../lib/changelog';
import { CHANGELOG_BUNDLED_MARKDOWN } from '../lib/changelogBundled';

const SECTION_ORDER: ChangelogSectionKey[] = [
  'added',
  'changed',
  'fixed',
  'removed',
  'security',
];

const SECTION_LABEL: Record<ChangelogSectionKey, string> = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  removed: 'Removed',
  security: 'Security',
};

interface Props {
  supabaseUrl: string | null;
  appVersion?: string;
}

function Section({ k, items }: { k: ChangelogSectionKey; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <strong style={{ fontSize: 12, opacity: 0.75 }}>
        {SECTION_LABEL[k]}
      </strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {items.map((item) => (
          <li key={item} style={{ fontSize: 13, lineHeight: 1.4 }}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntryCard({ entry }: { entry: ChangelogEntry }) {
  const isUnreleased = entry.version === 'Unreleased';
  return (
    <div
      data-testid={`changelog-card-${entry.version}`}
      style={{
        marginTop: 12,
        padding: '10px 12px',
        borderRadius: 6,
        border: isUnreleased ? '1.5px solid #6366f1' : '1px solid #2a2a2a',
        background: 'rgba(0,0,0,0.15)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong>{isUnreleased ? 'Unreleased' : entry.version}</strong>
        {entry.date && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>{entry.date}</span>
        )}
      </div>
      {SECTION_ORDER.map((k) => (
        <Section key={k} k={k} items={entry.sections[k]} />
      ))}
    </div>
  );
}

export function AboutCard({ supabaseUrl, appVersion = '0.1.0' }: Props) {
  const entries = useMemo(
    () => latestEntries(parseChangelog(CHANGELOG_BUNDLED_MARKDOWN), 2),
    [],
  );
  const releasesUrl = supabaseUrl ? `${supabaseUrl}/releases` : null;

  return (
    <section className="card" data-testid="about-card">
      <h2>About</h2>
      <dl className="kv">
        <dt>Version</dt>
        <dd>
          <code className="endpoint">{appVersion}</code>
        </dd>
      </dl>
      <div style={{ marginTop: 8 }}>
        <h3 style={{ fontSize: 14, margin: '8px 0' }}>What's new</h3>
        {entries.length === 0 ? (
          <p className="muted" data-testid="about-empty">
            No release notes yet.
          </p>
        ) : (
          entries.map((e) => <EntryCard key={e.version} entry={e} />)
        )}
        {releasesUrl && (
          <button
            type="button"
            className="link"
            style={{ marginTop: 10 }}
            onClick={() => void openUrl(releasesUrl)}
            data-testid="about-show-all"
          >
            Show all releases →
          </button>
        )}
      </div>
    </section>
  );
}
