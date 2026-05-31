import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProcessInstanceRow } from './types';

/**
 * Operator-driven phase advance for human-only phases.
 *
 * The architect doc (§6) describes a `process_instance_advance` RPC that the
 * bridge ships in Phase 32.2. Until that RPC lands, the tray performs the
 * minimum direct UPDATE that the human-only path needs:
 *
 *   - bump current_phase_index (or close the instance if the last phase
 *     just finished),
 *   - flip current_phase_status to 'pending' on the new phase,
 *   - append a process_phase_runs row with transition='done' for the
 *     current phase and a follow-up 'entered' row for the new phase.
 *
 * RLS gates these to org members (and 0070's column-RLS lets end-user JWTs
 * write current_phase_index/_status). When the bridge ships the RPC we switch
 * to `client.rpc('process_instance_advance', { p_instance_id })` — the tray
 * keeps the same call-site shape, just swap the body.
 */
export async function advanceInstance(
  client: SupabaseClient,
  instance: ProcessInstanceRow,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const phases = instance.template_version_snapshot;
  const currentIndex = instance.current_phase_index;
  const nextIndex = currentIndex + 1;
  const isLastPhase = nextIndex >= phases.length;

  const now = new Date().toISOString();
  const patch: Partial<ProcessInstanceRow> & { updated_at?: string } = {
    current_phase_status: isLastPhase ? 'done' : 'pending',
    current_phase_index: isLastPhase ? currentIndex : nextIndex,
    ...(isLastPhase ? { completed_at: now } : {}),
  };

  const { error: updErr } = await client
    .from('process_instances')
    .update(patch)
    .eq('id', instance.id);
  if (updErr !== null) return { ok: false, error: updErr.message };

  const rows = [
    {
      instance_id: instance.id,
      phase_index: currentIndex,
      transition: 'done' as const,
      actor: actorUserId,
    },
    ...(isLastPhase
      ? []
      : [
          {
            instance_id: instance.id,
            phase_index: nextIndex,
            transition: 'entered' as const,
            actor: actorUserId,
          },
        ]),
  ];
  const { error: runErr } = await client
    .from('process_phase_runs')
    .insert(rows);
  if (runErr !== null) return { ok: false, error: runErr.message };

  return { ok: true };
}
