import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { usePairingStatus } from '../bridge/usePairingStatus';
import {
  instanceIsActive,
  type ProcessInstanceRow,
  type ProjectWithInstances,
} from '../process/types';
import { useProjectsWithInstances } from '../process/useProjectsWithInstances';
import { ProcessInstanceDetail } from './ProcessInstanceDetail';

interface Props {
  onBack: () => void;
}

function InstanceRow({
  instance,
  artifactsCount,
  onOpen,
}: {
  instance: ProcessInstanceRow;
  artifactsCount: number;
  onOpen: (id: string) => void;
}) {
  const phases = instance.template_version_snapshot;
  const phase = phases[instance.current_phase_index];
  const phaseLabel =
    phase !== undefined
      ? `${phase.title} (${instance.current_phase_status})`
      : `phase ${instance.current_phase_index}`;
  return (
    <li
      className="instance-row"
      onClick={() => onOpen(instance.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(instance.id);
      }}
    >
      <div className="instance-row-head">
        <strong>{instance.title}</strong>
        {!instanceIsActive(instance) && (
          <span className="badge">completed</span>
        )}
      </div>
      <div className="muted">
        {phaseLabel} · {artifactsCount} artifact
        {artifactsCount === 1 ? '' : 's'} · v{instance.template_version}
      </div>
    </li>
  );
}

function ProjectGroup({
  group,
  onOpen,
}: {
  group: ProjectWithInstances;
  onOpen: (id: string) => void;
}) {
  const { project, instances } = group;
  return (
    <section className="card">
      <div className="project-card-head">
        <h2>{project.name}</h2>
        <span className="muted">
          {instances.length} instance{instances.length === 1 ? '' : 's'}
        </span>
      </div>
      {project.description !== null && (
        <p className="muted">{project.description}</p>
      )}
      {instances.length === 0 ? (
        <p className="muted">
          No process instances yet. Use the AgentControl app (or the tray's
          "Start process" action — landing in 32.6) to kick one off.
        </p>
      ) : (
        <ul className="instance-list">
          {instances.map((i) => (
            <InstanceRow
              key={i.id}
              instance={i}
              artifactsCount={0}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="link"
        onClick={() =>
          alert(
            'Process-creation lands in Phase 32.6 (tray seeded with the Hacker School default template). For now, create from the AgentControl app.',
          )
        }
        style={{ marginTop: 8 }}
      >
        Start a new process for this project →
      </button>
    </section>
  );
}

export function ProcessInstancesScreen({ onBack }: Props) {
  const { status } = usePairingStatus();
  const orgId = status?.state === 'paired' ? status.orgId : null;
  const { session } = useAuth();
  const { groups, loading, error } = useProjectsWithInstances(orgId);
  const [openInstanceId, setOpenInstanceId] = useState<string | null>(null);

  if (openInstanceId !== null) {
    return (
      <ProcessInstanceDetail
        instanceId={openInstanceId}
        onBack={() => setOpenInstanceId(null)}
      />
    );
  }

  return (
    <main className="container">
      <header className="brand">
        <button type="button" className="link" onClick={onBack}>
          ← Home
        </button>
        <h1>Processes</h1>
        <p className="muted">
          Projects in this org and their process instances (phase 32 templates).
        </p>
      </header>

      {orgId === null && (
        <section className="card">
          <p className="muted">Pair this tray to a bridge to load processes.</p>
        </section>
      )}

      {orgId !== null && session === null && (
        <section className="card">
          <p className="muted">Sign in to view processes.</p>
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
          <p className="muted">
            No projects yet in this org. Create one in the AgentControl app.
          </p>
        </section>
      )}

      {groups.map((g) => (
        <ProjectGroup key={g.project.id} group={g} onOpen={setOpenInstanceId} />
      ))}
    </main>
  );
}
