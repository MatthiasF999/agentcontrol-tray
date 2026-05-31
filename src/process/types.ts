// Shared TypeScript types for the Phase-32 process-templates feature.
//
// These mirror the supabase schema introduced in migrations 0068-0072 (see
// /supabase/migrations/) and the architect blueprint
// /agentcontrol-bridge/docs/PHASE-32-0-ARCHITECT-BLUEPRINT.md.
//
// They are the tray-side counterpart of `bridge-server/src/types/protocol.ts`.
// Phase 32.1 of the bridge-side will move these into a shared protocol file;
// for now we duplicate so the tray can ship without waiting for the cross-repo
// protocol drop.

export type ProcessPhaseKind = "human-only" | "claude-doable" | "hybrid";

export type ProcessAdvanceRequires =
  | "artifact_present"
  | "operator_confirm"
  | "autonomous_task_succeeded"
  | "review_approved";

export interface ProcessPhase {
  index: number;
  key: string;
  title: string;
  kind: ProcessPhaseKind;
  expected_artifact_types: string[];
  claude_prompt_template?: string | null;
  advance_requires: ProcessAdvanceRequires;
  guidance_markdown?: string | null;
}

export type ProcessPhaseStatus =
  | "pending"
  | "active"
  | "awaiting_review"
  | "done";

export interface ProcessTemplateRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  version: number;
  phases: ProcessPhase[];
  is_default: boolean;
  deprecated_at: string | null;
  created_at: string;
}

export interface ProcessInstanceRow {
  id: string;
  template_id: string;
  template_version: number;
  template_version_snapshot: ProcessPhase[];
  org_id: string;
  project_id: string;
  title: string;
  current_phase_index: number;
  current_phase_status: ProcessPhaseStatus;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProcessArtifactRow {
  id: string;
  instance_id: string;
  phase_index: number;
  artifact_type: string;
  data: unknown | null;
  worktree_path: string | null;
  published_url: string | null;
  published_at: string | null;
  published_expires_at: string | null;
  bridge_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ProcessPhaseTransition =
  | "entered"
  | "reviewed"
  | "done"
  | "reopened"
  | "skipped";

export interface ProcessPhaseRunRow {
  id: string;
  instance_id: string;
  phase_index: number;
  transition: ProcessPhaseTransition;
  actor: string | null;
  autonomous_task_id: string | null;
  note: string | null;
  at: string;
}

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  default_template_id: string | null;
  archived_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// View-model helpers
// ---------------------------------------------------------------------------

export interface ProjectWithInstances {
  project: ProjectRow;
  instances: ProcessInstanceRow[];
}

export function instanceIsActive(instance: ProcessInstanceRow): boolean {
  return instance.completed_at === null;
}

/**
 * Returns true when the phase is human-only and ready to be advanced by an
 * operator (no autonomous-task dependency). The detail screen surfaces an
 * Advance button only in this case.
 */
export function canOperatorAdvance(
  instance: ProcessInstanceRow,
): { eligible: boolean; reason?: string } {
  const phases = instance.template_version_snapshot;
  const phase = phases[instance.current_phase_index];
  if (phase === undefined) {
    return { eligible: false, reason: "Phase index out of bounds." };
  }
  if (instance.completed_at !== null) {
    return { eligible: false, reason: "Instance already completed." };
  }
  if (phase.kind !== "human-only") {
    return {
      eligible: false,
      reason: "Only human-only phases advance from the tray (others wait on Claude).",
    };
  }
  if (
    instance.current_phase_status !== "active" &&
    instance.current_phase_status !== "pending"
  ) {
    return {
      eligible: false,
      reason: `Phase status is ${instance.current_phase_status}.`,
    };
  }
  return { eligible: true };
}
