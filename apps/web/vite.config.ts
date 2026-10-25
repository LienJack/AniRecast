import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5178,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7878',
        configure: (proxy) => {
          // Node buffers response headers until the first body chunk; for SSE that would hold the
          // EventSource in "connecting" until the next event. Flush them once the proxy has set them.
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            if (String(proxyRes.headers['content-type'] ?? '').startsWith('text/event-stream'))
              setImmediate(() => res.flushHeaders());
          });
        },
      },
    },
  },
});
