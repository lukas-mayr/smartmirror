import { defineConfig } from 'vite';

export default defineConfig({
  // Wird vom Core unter / ausgeliefert.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Ein Bundle statt vieler Chunks: die App ist klein und wird ueber WLAN
    // von einem Raspberry Pi geladen – ein Rundlauf weniger ist mehr wert als
    // feingranulares Code-Splitting.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
      '/modules': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
    },
  },
});
