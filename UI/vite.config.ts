import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies the bridge host (server/index.ts) so the browser
// only ever talks to one origin. Override the host port via BRIDGE_UI_PORT.
const HOST_PORT = Number(process.env.BRIDGE_UI_PORT ?? 4000);

export default defineConfig({
  plugins: [react()],
  // The bridge is a CommonJS `file:../API` dep (symlinked outside
  // node_modules) — include its dist so the CJS->ESM interop runs on the
  // deep `dist/socket/channels` import used by the client.
  optimizeDeps: {
    include: ['screeps-web-api-bridge/dist/socket/channels'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /API[\\/]dist/],
    },
  },
  server: {
    // Loopback-only: the dashboard is reached via an SSH tunnel / VS Code port
    // forwarding, never exposed directly. 127.0.0.1 (not the IPv6-localhost
    // Vite would otherwise pick) so plain `ssh -L 5173:127.0.0.1:5173` works.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://localhost:${HOST_PORT}`,
      '/bridge-ws': {
        target: `ws://localhost:${HOST_PORT}`,
        ws: true,
      },
    },
  },
});
