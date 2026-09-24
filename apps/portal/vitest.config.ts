import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  test: { environment: 'jsdom', include: ['src/components/weather/*.spec.ts'] },
});
