import { useCallback, useEffect, useState } from "react";
import { settings } from "./storage";

export type Theme = "light" | "dark" | "system";
export type UpdateChannel = "stable" | "beta";

export interface AppSettings {
  theme: Theme;
  pollIntervalSeconds: number;
  updateChannel: UpdateChannel;
  bridgeApiKey: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  pollIntervalSeconds: 4,
  updateChannel: "stable",
  bridgeApiKey: null,
};

const KEY = "app.settings.v1";

export async function loadAppSettings(): Promise<AppSettings> {
  const stored = await settings.get<Partial<AppSettings>>(KEY);
  if (stored === null) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveAppSettings(next: AppSettings): Promise<void> {
  await settings.set(KEY, next);
}

export function useAppSettings(): {
  values: AppSettings;
  loading: boolean;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [values, setValues] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const cur = await loadAppSettings();
      setValues(cur);
      setLoading(false);
    })();
  }, []);

  const update = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setValues((prev) => {
        const next = { ...prev, [key]: value };
        void saveAppSettings(next);
        return next;
      });
    },
    [],
  );

  const reset = useCallback(async () => {
    await saveAppSettings(DEFAULT_SETTINGS);
    setValues(DEFAULT_SETTINGS);
  }, []);

  return { values, loading, update, reset };
}
