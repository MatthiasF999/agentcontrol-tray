import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// First test runner wired in the tray (the Phase 37 ci.yml follow-up).
// `jsdom` because the onboarding suites drive React hooks through
// @testing-library/react's `renderHook`. Kept in its own config so
// `vite.config.ts` stays the Tauri dev/build surface only.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
