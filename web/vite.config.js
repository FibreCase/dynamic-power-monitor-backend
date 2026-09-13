import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the backend's API/WS/health routes so the app can use
// plain relative paths in both dev (this proxy) and prod (same-origin,
// served by FastAPI's static mount) - see power_monitor/app.py.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/healthz': 'http://127.0.0.1:8000',
      '/ota': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    outDir: 'dist', // must match power_monitor/config.py's web_dist_dir default
    emptyOutDir: true,
  },
})
