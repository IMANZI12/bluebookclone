import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 1: dev server on 5173, with /api proxied to the Express backend
// on 4000 so the React app can fetch('/api/health') without CORS gymnastics.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
