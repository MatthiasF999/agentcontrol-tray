/**
 * Add-24 — OS-notification → in-app deep-link routing.
 *
 * A notification emitted via `notify(title, body, route)` carries the
 * target route in its `extra` payload. While the tray is alive (the
 * window hides, it never closes), `onAction` fires when the user clicks
 * the notification; we forward the route to the Rust `show_main_window`
 * IPC, which focuses the window and emits a `navigate` event. The React
 * router subscribes via `onNavigate` and switches view.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onAction } from '@tauri-apps/plugin-notification';

export type NavRoute = 'home' | 'settings' | 'processes' | 'backlog' | 'teams';

const ROUTES: readonly NavRoute[] = [
  'home',
  'settings',
  'processes',
  'backlog',
  'teams',
];

export function isNavRoute(value: unknown): value is NavRoute {
  return (
    typeof value === 'string' && (ROUTES as readonly string[]).includes(value)
  );
}

/**
 * Bring the main window forward and navigate to `route`. Wraps the Rust
 * `show_main_window` IPC (show + focus + emit `navigate`).
 */
export async function openAtRoute(route: NavRoute): Promise<void> {
  await invoke('show_main_window', { route });
}

/**
 * Register the notification-click → routing bridge. Call once at app
 * start. Returns an unregister fn.
 */
export async function installNotificationRouting(): Promise<() => void> {
  const listener = await onAction((notification) => {
    const route = notification.extra?.route;
    if (isNavRoute(route)) void openAtRoute(route);
  });
  return () => void listener.unregister();
}

/**
 * Subscribe the router to `navigate` events from the Rust IPC. Returns an
 * unlisten fn.
 */
export async function onNavigate(
  cb: (route: NavRoute) => void,
): Promise<UnlistenFn> {
  return listen<string>('navigate', (event) => {
    if (isNavRoute(event.payload)) cb(event.payload);
  });
}
