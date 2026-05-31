import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

export interface UpdateState {
  available: boolean;
  current?: string;
  latest?: string;
  notes?: string;
  publishedAt?: string;
  raw?: Update;
}

export async function checkForUpdate(): Promise<UpdateState> {
  const update = await check();
  if (update === null) {
    return { available: false };
  }
  return {
    available: true,
    current: update.currentVersion,
    latest: update.version,
    notes: update.body ?? undefined,
    publishedAt: update.date ?? undefined,
    raw: update,
  };
}

export async function installAndRestart(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
