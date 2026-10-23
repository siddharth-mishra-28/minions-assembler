import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3100', '/docs': 'http://127.0.0.1:3100' } },
  test: { environment: 'jsdom', globals: true, include: ['src/**/*.test.{ts,tsx}'] },
});
