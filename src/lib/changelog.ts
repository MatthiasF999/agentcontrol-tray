/**
 * changelog — Phase 43 Add-30 — Tray "About" CHANGELOG UI.
 *
 * Pure parser for keep-a-changelog markdown + a bundled snapshot of
 * /CHANGELOG.md. The AboutCard component (src/screens/AboutCard.tsx)
 * imports `CHANGELOG_BUNDLED_MARKDOWN`, runs it through
 * `parseChangelog`, and renders the latest N versions inline within
 * SettingsScreen. "Show all" link routes to operator-portal Releases
 * tab (Add-31; out-of-scope for tray).
 *
 * Why a hand-written parser:
 *   - Tray bundle stays slim — no remark/unified deps.
 *   - We only care about `## [version]` + `### Section` + bullets, not
 *     embedded HTML / code blocks / images.
 *   - Testable as a pure function with a fixture string (when a tray
 *     vitest gate lands per Phase 37 follow-up).
 *
 * Port of agentcontrol-app/src/services/changelogService.ts, trimmed
 * to the surface tray needs.
 */

export type ChangelogSectionKey =
  | 'added'
  | 'changed'
  | 'fixed'
  | 'removed'
  | 'security';

export interface ChangelogSections {
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
  security: string[];
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  sections: ChangelogSections;
}

const VERSION_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/;
const SECTION_RE = /^###\s+(Added|Changed|Fixed|Removed|Security)\s*$/i;
const BULLET_RE = /^[-*]\s+(.*\S)\s*$/;

function emptySections(): ChangelogSections {
  return { added: [], changed: [], fixed: [], removed: [], security: [] };
}

function sectionKey(label: string): ChangelogSectionKey {
  return label.toLowerCase() as ChangelogSectionKey;
}

interface ParseState {
  entries: ChangelogEntry[];
  current: ChangelogEntry | null;
  section: ChangelogSectionKey | null;
  lastBullet: string[] | null;
}

function startEntry(state: ParseState, version: string, date?: string): void {
  if (state.current) state.entries.push(state.current);
  state.current = { version, sections: emptySections() };
  if (date) state.current.date = date;
  state.section = null;
  state.lastBullet = null;
}

function startSection(state: ParseState, label: string): void {
  if (!state.current) return;
  state.section = sectionKey(label);
  state.lastBullet = null;
}

function appendBullet(state: ParseState, text: string): void {
  if (!state.current || !state.section) return;
  const list = state.current.sections[state.section];
  list.push(text);
  state.lastBullet = list;
}

function extendBullet(state: ParseState, line: string): void {
  if (!state.lastBullet || state.lastBullet.length === 0) return;
  const last = state.lastBullet.length - 1;
  const prev = state.lastBullet[last];
  if (prev !== undefined) state.lastBullet[last] = `${prev} ${line.trim()}`;
}

function isContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line) && !BULLET_RE.test(line.trimStart());
}

function handleLine(state: ParseState, raw: string): void {
  const line = raw.replace(/\r$/, '');
  const vm = VERSION_RE.exec(line);
  if (vm?.[1]) {
    startEntry(state, vm[1], vm[2]);
    return;
  }
  if (/^##\s+\S/.test(line) && !line.startsWith('### ')) {
    if (state.current) state.entries.push(state.current);
    state.current = null;
    state.section = null;
    state.lastBullet = null;
    return;
  }
  const sm = SECTION_RE.exec(line);
  if (sm?.[1]) {
    startSection(state, sm[1]);
    return;
  }
  const bm = BULLET_RE.exec(line.trimStart());
  if (bm?.[1] && line.startsWith('-')) {
    appendBullet(state, bm[1]);
    return;
  }
  if (isContinuation(line)) extendBullet(state, line);
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  if (!markdown?.trim()) return [];
  const state: ParseState = {
    entries: [],
    current: null,
    section: null,
    lastBullet: null,
  };
  for (const raw of markdown.split('\n')) handleLine(state, raw);
  if (state.current) state.entries.push(state.current);
  return state.entries;
}

/**
 * Take the latest N entries, with `Unreleased` always first if present.
 * `count` includes the Unreleased card.
 */
export function latestEntries(
  entries: ChangelogEntry[],
  count: number,
): ChangelogEntry[] {
  return entries.slice(0, count);
}
