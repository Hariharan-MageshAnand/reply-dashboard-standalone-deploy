import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 collides with the Emergence-Hiring-App frontend on this machine;
    // strictPort keeps the origin stable for CORS and OAuth redirects. The API
    // must stay on 4000 — the registered OAuth redirect URIs point there.
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
