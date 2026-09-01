/**
 * Dev server proxy — auto-generated from public/env.js
 *
 * env.js is the single source of truth.  Change DEV_PROXY_TARGET there;
 * the dev server picks it up on next restart.  No need to touch this file.
 */
const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

const envJs = fs.readFileSync(path.join(__dirname, 'public', 'env.js'), 'utf-8');
const sandbox = { __env: {} };
vm.runInNewContext(envJs, sandbox);

const target = sandbox.__env.DEV_PROXY_TARGET || sandbox.__env.API_LOCATION || 'https://demi-apim-test.azure-api.net';

const proxyRule = {
  target,
  secure: false,
  changeOrigin: true,
  // Prevent Angular dev server from timing out long-running proxied requests
  // (e.g. eagle-demi OCR extraction can take up to 280s).
  proxyTimeout: 350_000,
  timeout: 350_000,
};

module.exports = {
  '/api': proxyRule,
  // eagle-notify only allows https origins in CORS, so local dev reaches it through the proxy too.
  '/notify-api': { ...proxyRule, target: sandbox.__env.DEV_NOTIFY_PROXY_TARGET || 'https://notify-api-test.azurewebsites.net', pathRewrite: { '^/notify-api': '' } }
};
