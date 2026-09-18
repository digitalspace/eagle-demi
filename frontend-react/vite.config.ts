/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// public/env.js is the single source of truth for the dev proxy targets. Change DEV_PROXY_TARGET
// there; the dev server picks it up on the next restart.
const envJs = readFileSync(fileURLToPath(new URL('./public/env.js', import.meta.url)), 'utf-8');
const sandbox: { __env: Record<string, string> } = { __env: {} };
runInNewContext(envJs, sandbox);

const target =
  sandbox.__env['DEV_PROXY_TARGET'] ||
  sandbox.__env['API_LOCATION'] ||
  'https://demi-apim-test.azure-api.net';

const proxyRule = {
  target,
  secure: false,
  changeOrigin: true,
  // The dev server must not cut off long proxied requests: OCR extraction can take up to 280s.
  proxyTimeout: 350_000,
  timeout: 350_000,
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    proxy: {
      '/api': proxyRule,
      // eagle-notify only allows https origins in CORS, so local dev reaches it through the proxy too.
      '/notify-api': {
        ...proxyRule,
        target:
          sandbox.__env['DEV_NOTIFY_PROXY_TARGET'] || 'https://notify-api-test.azurewebsites.net',
        rewrite: (path: string) => path.replace(/^\/notify-api/, ''),
      },
    },
  },
  build: {
    // Flat: scripts/deploy-azure.sh uploads this directory as the site root.
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
