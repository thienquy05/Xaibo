// Renderer bundle only; main, service, shared and preload are compiled by tsc (tsconfig.build.json).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('dist/renderer', import.meta.url)), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
