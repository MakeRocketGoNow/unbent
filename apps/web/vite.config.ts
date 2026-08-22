import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // better-auth/react is a linked workspace dependency with its own nested react
    // symlink, which Vite would otherwise pre-bundle into a second React instance —
    // producing "invalid hook call" at runtime. Force one copy.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    proxy: {
      // Proxying keeps the API same-origin in development, so session cookies work
      // without CORS or SameSite workarounds. In production Pages routes /api to the
      // Worker, which is the same origin for real.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
