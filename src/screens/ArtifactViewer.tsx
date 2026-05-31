import { convertFileSrc } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useMemo, useState } from 'react';
import type { ProcessArtifactRow, ProcessInstanceRow } from '../process/types';

interface Props {
  artifact: ProcessArtifactRow;
  instance: ProcessInstanceRow;
  onFullscreen?: () => void;
  /** When true, render iframe at full container height. */
  expanded?: boolean;
}

/**
 * Per-architect-§8 iframe viewer for process artifacts.
 *
 * - artifact_type === 'html-prototype':
 *     - published_url set  → iframe the signed URL.
 *     - else (draft)       → iframe the local worktree dir via
 *                             Tauri's `convertFileSrc()` (asset:// protocol).
 *     The iframe sandbox is `allow-scripts allow-same-origin` (architect §8).
 * - Other artifact types render a minimal JSON / markdown preview — the
 *   richer renderers (event-model HTML+CSS-grid, persona markdown) belong to
 *   the app-side (Phase 32.6); tray operators just need a "what is this"
 *   glance and the "open in browser" escape hatch.
 */
export function ArtifactViewer({
  artifact,
  instance,
  onFullscreen,
  expanded = false,
}: Props) {
  const [imgErr, setImgErr] = useState<string | null>(null);

  const isHtmlPrototype = artifact.artifact_type === 'html-prototype';
  const isPublished = artifact.published_url !== null;

  const iframeSrc = useMemo<string | null>(() => {
    if (!isHtmlPrototype) return null;
    if (isPublished) return artifact.published_url;
    // Draft path: bridge writes `process_artifacts.worktree_path` relative to
    // `process_instances.worktree_path` (open-q 13c). We resolve at render
    // time. file:// is wrapped by Tauri's asset:// protocol so the iframe
    // sandbox + allow-same-origin works without WebView fighting file: CORS.
    if (instance.worktree_path === null || artifact.worktree_path === null) {
      return null;
    }
    const base = instance.worktree_path.replace(/\/+$/, '');
    const rel = artifact.worktree_path.replace(/^\/+|\/+$/g, '');
    const indexPath = `${base}/${rel}/index.html`;
    try {
      return convertFileSrc(indexPath);
    } catch (e) {
      setImgErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [artifact, instance, isHtmlPrototype, isPublished]);

  async function onOpenExternal(): Promise<void> {
    if (iframeSrc === null) return;
    try {
      await openUrl(iframeSrc);
    } catch (e) {
      setImgErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (!isHtmlPrototype) {
    return (
      <details className="artifact-fallback">
        <summary>
          {artifact.artifact_type}{' '}
          <span className="muted">
            (phase {artifact.phase_index} — added{' '}
            {new Date(artifact.created_at).toLocaleString()})
          </span>
        </summary>
        <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
          {JSON.stringify(artifact.data, null, 2) ??
            artifact.worktree_path ??
            '(empty)'}
        </pre>
      </details>
    );
  }

  if (iframeSrc === null) {
    return (
      <div className="artifact-empty muted">
        Prototype is missing both <code>worktree_path</code> and a published
        URL. The authoring bridge has not synced yet — pair on a bridge with the
        worktree mounted.
        {imgErr !== null && <div className="error">{imgErr}</div>}
      </div>
    );
  }

  return (
    <div className={`artifact-viewer ${expanded ? 'expanded' : ''}`}>
      <div className="artifact-viewer-toolbar">
        <span className="muted">
          {isPublished ? 'Published snapshot' : 'Draft (worktree)'} ·{' '}
          {artifact.published_expires_at !== null && (
            <span>
              expires{' '}
              {new Date(artifact.published_expires_at).toLocaleDateString()}
            </span>
          )}
        </span>
        <div className="artifact-viewer-actions">
          <button
            type="button"
            className="link"
            onClick={() => void onOpenExternal()}
          >
            Open in browser
          </button>
          {onFullscreen !== undefined && (
            <button type="button" className="link" onClick={onFullscreen}>
              Full screen
            </button>
          )}
        </div>
      </div>
      <iframe
        title={`prototype-${artifact.id}`}
        src={iframeSrc}
        // Architect §8 security envelope. NO allow-forms / allow-popups /
        // allow-top-navigation — prototype code can run + read its own
        // origin, nothing more.
        sandbox="allow-scripts allow-same-origin"
        className="artifact-iframe"
      />
      {imgErr !== null && <div className="error">{imgErr}</div>}
    </div>
  );
}
