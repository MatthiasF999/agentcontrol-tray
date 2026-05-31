// Backlog row types — mirrors Supabase migrations 0079/0080/0082.
// Tray is consumption-only (architect §10.2): we never write items,
// only call the `submit_idea` RPC and read these tables via PostgREST.

export type BacklogItemState =
  | "idea"
  | "groomed"
  | "scheduled"
  | "in_progress"
  | "done"
  | "released"
  | "blocked"
  | "cancelled";

export type BacklogPriority = "P0" | "P1" | "P2" | "P3";

export interface BacklogItem {
  id: string;
  org_id: string;
  project_id: string | null;
  release_id: string | null;
  title: string;
  description: string | null;
  state: BacklogItemState;
  priority: BacklogPriority;
  size: string | null;
  blocked_reason: string | null;
  labels: string[];
  submitted_by: string | null;
  created_at: string;
  updated_at: string;
}

export type BacklogReleaseState =
  | "planning"
  | "active"
  | "released"
  | "cancelled";

export interface BacklogRelease {
  id: string;
  org_id: string;
  project_id: string | null;
  name: string;
  semver: string | null;
  state: BacklogReleaseState;
  target_date: string | null;
  goal_markdown: string | null;
  released_at: string | null;
  created_at: string;
}

export type StandupTaskState =
  | "queued"
  | "claimed"
  | "generated"
  | "delivered"
  | "failed";

export interface StandupTask {
  id: string;
  org_id: string;
  project_id: string | null;
  state: StandupTaskState;
  digest_markdown: string | null;
  delivered_at: string | null;
  generated_at: string | null;
  created_at: string;
}

export const BACKLOG_ITEM_FIELDS =
  "id, org_id, project_id, release_id, title, description, state, priority, size, blocked_reason, labels, submitted_by, created_at, updated_at";

export const BACKLOG_RELEASE_FIELDS =
  "id, org_id, project_id, name, semver, state, target_date, goal_markdown, released_at, created_at";

export const STANDUP_TASK_FIELDS =
  "id, org_id, project_id, state, digest_markdown, delivered_at, generated_at, created_at";
