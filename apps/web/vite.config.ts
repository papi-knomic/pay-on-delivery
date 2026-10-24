import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = `http://localhost:${process.env.API_PORT ?? 3000}`;

export default defineConfig({
  plugins: [react()],
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: {
      '@pod/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/health': API,
      '/webhooks': API,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
