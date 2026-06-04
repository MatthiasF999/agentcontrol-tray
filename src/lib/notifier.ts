import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { NavRoute } from './navigation';

let _ensured: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (_ensured !== null) return _ensured;
  _ensured = (async () => {
    if (await isPermissionGranted()) return true;
    const result = await requestPermission();
    return result === 'granted';
  })();
  return _ensured;
}

/**
 * Send an OS notification. When `route` is given, clicking the
 * notification deep-links the tray to that view (Add-24, see
 * ./navigation).
 */
export async function notify(
  title: string,
  body: string,
  route?: NavRoute,
): Promise<void> {
  if (!(await ensurePermission())) return;
  sendNotification({ title, body, extra: route ? { route } : undefined });
}
