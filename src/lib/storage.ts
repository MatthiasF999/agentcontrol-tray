import { LazyStore } from '@tauri-apps/plugin-store';

const SETTINGS_FILE = 'settings.json';
const SESSION_FILE = 'session.json';

let _settings: LazyStore | null = null;
let _session: LazyStore | null = null;

function settingsStore(): LazyStore {
  if (_settings === null) _settings = new LazyStore(SETTINGS_FILE);
  return _settings;
}

function sessionStore(): LazyStore {
  if (_session === null) _session = new LazyStore(SESSION_FILE);
  return _session;
}

export const settings = {
  async get<T>(key: string): Promise<T | null> {
    return ((await settingsStore().get(key)) as T | undefined) ?? null;
  },
  async set<T>(key: string, value: T): Promise<void> {
    await settingsStore().set(key, value);
    await settingsStore().save();
  },
  async remove(key: string): Promise<void> {
    await settingsStore().delete(key);
    await settingsStore().save();
  },
};

export const supabaseStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    return ((await sessionStore().get(key)) as string | undefined) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await sessionStore().set(key, value);
    await sessionStore().save();
  },
  async removeItem(key: string): Promise<void> {
    await sessionStore().delete(key);
    await sessionStore().save();
  },
};
