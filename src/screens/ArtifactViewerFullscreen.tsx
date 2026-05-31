import { useEffect } from 'react';
import type { ProcessArtifactRow, ProcessInstanceRow } from '../process/types';
import { ArtifactViewer } from './ArtifactViewer';

interface Props {
  artifact: ProcessArtifactRow;
  instance: ProcessInstanceRow;
  onClose: () => void;
}

/**
 * Modal-style full-screen viewer. Escapes back via Esc or the close button.
 * Designed for usability tests where the operator demos a prototype to a
 * stakeholder on the bridge host.
 */
export function ArtifactViewerFullscreen({
  artifact,
  instance,
  onClose,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fullscreen-viewer">
      <div className="fullscreen-viewer-bar">
        <span className="muted">{artifact.artifact_type}</span>
        <button type="button" onClick={onClose}>
          Close (Esc)
        </button>
      </div>
      <ArtifactViewer artifact={artifact} instance={instance} expanded={true} />
    </div>
  );
}
