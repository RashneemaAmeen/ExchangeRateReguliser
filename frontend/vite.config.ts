import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // The browser only talks to /api on the Vite origin; the backend URL (and any
      // provider credentials) never reach the frontend bundle.
      proxy: {
        '/api': { target: env.VITE_API_PROXY_TARGET || 'http://localhost:4000', changeOrigin: true },
      },
    },
  };
});
