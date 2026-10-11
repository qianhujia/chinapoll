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
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  }
});
