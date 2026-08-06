import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const apiProxyTarget = process.env.PORTAL_API_PROXY_TARGET || 'http://192.168.1.60:3000'
const voiceProxyTarget = apiProxyTarget.replace(/^http/, 'ws')
const backendLabel =
  process.env.VITE_BACKEND_LABEL ||
  process.env.VITE_API_BASE_URL ||
  'same-origin'

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/portal',
  plugins: [vue()],
  define: {
    'import.meta.env.VITE_BACKEND_LABEL': JSON.stringify(backendLabel),
  },
  server: {
    port: 4300,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      clientPort: 4300,
    },
    proxy: {
      '/auth': apiProxyTarget,
      '/portal': {
        target: apiProxyTarget,
        ws: true,
      },
      '/voice': {
        target: voiceProxyTarget,
        ws: true,
      },
    },
  },
  preview: {
    port: 4300,
  },
  build: {
    outDir: '../../dist/apps/portal',
    emptyOutDir: true,
  },
})
