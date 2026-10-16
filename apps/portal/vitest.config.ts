import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  resolve: {
    alias: {
      '@energrid/domain-devices': fileURLToPath(
        new URL('../../libs/domain-devices/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.spec.ts'] },
});
