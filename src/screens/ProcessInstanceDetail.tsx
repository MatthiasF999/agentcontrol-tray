import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { advanceInstance } from '../process/advanceInstance';
import {
  canOperatorAdvance,
  type ProcessArtifactRow,
  type ProcessInstanceRow,
  type ProcessPhase,
  type ProcessPhaseStatus,
} from '../process/types';
import { useProcessInstanceDetail } from '../process/useProcessInstanceDetail';
import { Colors } from '../theme/tokens';
import { ArtifactViewer } from './ArtifactViewer';
import { ArtifactViewerFullscreen } from './ArtifactViewerFullscreen';

interface Props {
  instanceId: string;
  onBack: () => void;
}

function phaseStatusColor(status: ProcessPhaseStatus): string {
  if (status === 'done') return Colors.statusDoneStrong;
  if (status === 'active') return Colors.accent;
  if (status === 'awaiting_review') return Colors.statusWaitStrong;
  return Colors.statusIdleStrong;
}

function classifyPhase(
  phase: ProcessPhase,
  currentIndex: number,
  currentStatus: ProcessPhaseStatus,
): { label: string; color: string } {
  if (phase.index < currentIndex) {
    return { label: 'done', color: Colors.statusDoneStrong };
  }
  if (phase.index === currentIndex) {
    return { label: currentStatus, color: phaseStatusColor(currentStatus) };
  }
  return { label: 'upcoming', color: Colors.statusIdle };
}

function PhaseTimeline({ instance }: { instance: ProcessInstanceRow }) {
  const phases = instance.template_version_snapshot;
  return (
    <ol className="phase-timeline">
      {phases.map((phase) => {
        const c = classifyPhase(
          phase,
          instance.current_phase_index,
          instance.current_phase_status,
        );
        return (
          <li key={phase.index} className="phase-timeline-step">
            <span
              className="phase-timeline-dot"
              style={{ backgroundColor: c.color }}
            />
            <div className="phase-timeline-body">
              <strong>{phase.title}</strong>
              <span className="muted"> · {phase.kind}</span>
              <div className="muted">{c.label}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ArtifactList({
  artifacts,
  instance,
  phaseIndex,
  onFullscreen,
}: {
  artifacts: ProcessArtifactRow[];
  instance: ProcessInstanceRow;
  phaseIndex: number;
  onFullscreen: (a: ProcessArtifactRow) => void;
}) {
  const phaseArtifacts = artifacts.filter((a) => a.phase_index === phaseIndex);
  if (phaseArtifacts.length === 0) {
    return <p className="muted">No artifacts yet for this phase.</p>;
  }
  return (
    <div className="artifact-list">
      {phaseArtifacts.map((a) => (
        <ArtifactViewer
          key={a.id}
          artifact={a}
          instance={instance}
          onFullscreen={() => onFullscreen(a)}
        />
      ))}
    </div>
  );
}

export function ProcessInstanceDetail({ instanceId, onBack }: Props) {
  const { client, session } = useAuth();
  const { instance, artifacts, phaseRuns, loading, error } =
    useProcessInstanceDetail(instanceId);
  const [advancing, setAdvancing] = useState(false);
  const [advanceErr, setAdvanceErr] = useState<string | null>(null);
  const [fullscreenArtifact, setFullscreenArtifact] =
    useState<ProcessArtifactRow | null>(null);

  async function onAdvance(): Promise<void> {
    if (client === null || session === null || instance === null) return;
    setAdvancing(true);
    setAdvanceErr(null);
    const res = await advanceInstance(client, instance, session.user.id);
    setAdvancing(false);
    if (!res.ok) setAdvanceErr(res.error);
  }

  if (loading) {
    return (
      <main className="container">
        <header className="brand">
          <button type="button" className="link" onClick={onBack}>
            ← Back
          </button>
          <h1>Loading instance…</h1>
        </header>
      </main>
    );
  }
  if (error !== null || instance === null) {
    return (
      <main className="container">
        <header className="brand">
          <button type="button" className="link" onClick={onBack}>
            ← Back
          </button>
          <h1>Instance not found</h1>
        </header>
        {error !== null && <div className="error">{error}</div>}
      </main>
    );
  }

  if (fullscreenArtifact !== null) {
    return (
      <ArtifactViewerFullscreen
        artifact={fullscreenArtifact}
        instance={instance}
        onClose={() => setFullscreenArtifact(null)}
      />
    );
  }

  const phases = instance.template_version_snapshot;
  const currentPhase = phases[instance.current_phase_index];
  const advance = canOperatorAdvance(instance);

  return (
    <main className="container">
      <header className="brand">
        <button type="button" className="link" onClick={onBack}>
          ← Back to processes
        </button>
        <h1>{instance.title}</h1>
        <p className="muted">
          template v{instance.template_version} · phase{' '}
          {instance.current_phase_index + 1}/{phases.length} ·{' '}
          {instance.current_phase_status}
          {instance.completed_at !== null && ' · completed'}
        </p>
      </header>

      <section className="card">
        <h2>Phases</h2>
        <PhaseTimeline instance={instance} />
      </section>

      {currentPhase !== undefined && (
        <section className="card">
          <h2>Current phase — {currentPhase.title}</h2>
          <p className="muted">
            {currentPhase.kind} · advance-requires{' '}
            {currentPhase.advance_requires}
          </p>
          {currentPhase.guidance_markdown !== undefined &&
            currentPhase.guidance_markdown !== null && (
              <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {currentPhase.guidance_markdown}
              </p>
            )}
          <ArtifactList
            artifacts={artifacts}
            instance={instance}
            phaseIndex={instance.current_phase_index}
            onFullscreen={setFullscreenArtifact}
          />
          {advance.eligible ? (
            <button
              type="button"
              onClick={() => void onAdvance()}
              disabled={advancing}
              style={{ marginTop: 12 }}
            >
              {advancing
                ? 'Advancing…'
                : instance.current_phase_index === phases.length - 1
                  ? 'Mark last phase done'
                  : 'Advance to next phase'}
            </button>
          ) : (
            <p className="muted" style={{ marginTop: 12 }}>
              {advance.reason}
            </p>
          )}
          {advanceErr !== null && <div className="error">{advanceErr}</div>}
        </section>
      )}

      <section className="card">
        <h2>All artifacts ({artifacts.length})</h2>
        {artifacts.length === 0 && <p className="muted">None yet.</p>}
        {artifacts.length > 0 && (
          <div className="artifact-list">
            {artifacts.map((a) => (
              <ArtifactViewer
                key={a.id}
                artifact={a}
                instance={instance}
                onFullscreen={() => setFullscreenArtifact(a)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Phase history</h2>
        {phaseRuns.length === 0 && <p className="muted">No transitions yet.</p>}
        {phaseRuns.length > 0 && (
          <ul className="phase-runs">
            {phaseRuns.map((r) => (
              <li key={r.id}>
                <code>{r.transition}</code> on phase{' '}
                <strong>
                  {phases[r.phase_index]?.title ?? `#${r.phase_index}`}
                </strong>
                <span className="muted">
                  {' '}
                  · {new Date(r.at).toLocaleString()}
                </span>
                {r.note !== null && <div className="muted">{r.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
