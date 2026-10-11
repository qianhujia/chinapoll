import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  // The SPA is served by the public Worker from dist/web (see wrangler.toml).
  build: {
    outDir: 'dist/web'
  },
  define: {
    // Deployment build identifier, surfaced by /api/health (see worker/index.ts).
    __BUILD_SHA__: JSON.stringify(process.env.GITHUB_SHA ?? 'dev')
  },
  // The /api proxy keeps the browser's original Host header (changeOrigin is
  // left off) so the Worker's same-origin (CSRF) check compares the Origin
  // header against the same origin the page was loaded from. If the Host were
  // rewritten to 127.0.0.1:8787, every cookie-authenticated mutation (proposal,
  // comment, logout, account) would be rejected with 403 in local development.
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787'
      }
    }
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787'
      }
    }
  }
});
