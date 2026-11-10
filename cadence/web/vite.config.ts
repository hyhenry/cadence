import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' keeps every asset URL relative so the app works under HA Ingress
// (/api/hassio_ingress/<token>/).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.CADENCE_PORT ?? 8099}`, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
});
