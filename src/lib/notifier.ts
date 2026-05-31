import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

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

export async function notify(title: string, body: string): Promise<void> {
  if (!(await ensurePermission())) return;
  sendNotification({ title, body });
}
