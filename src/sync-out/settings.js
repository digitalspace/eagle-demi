'use strict';

/**
 * Sync-out settings, read from the environment on every access so a test or a restarted worker
 * sees the current value. These move into `src/config.js` once the queue trigger is wired.
 *
 * The Eagle block is the Eagle consumer's alone: removing that consumer removes these keys too.
 */

const DEFAULT_QUEUE = 'sync-out';
const DEFAULT_MAX_ATTEMPTS = 3;

const env = (name) => (process.env[name] || '').trim();

const settings = {
  get queue() { return env('SYNC_OUT_QUEUE') || DEFAULT_QUEUE; },
  get maxAttempts() {
    const value = Number(env('SYNC_OUT_MAX_ATTEMPTS'));
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ATTEMPTS;
  },

  eagle: {
    get enabled() { return env('SYNC_OUT_EAGLE_ENABLED') === 'true'; },
    get apiBase() { return env('EAGLE_PROTECTED_API_BASE').replace(/\/+$/, ''); },
    get issuer() { return env('EAGLE_KC_ISSUER').replace(/\/+$/, ''); },
    get clientId() { return env('EAGLE_KC_CLIENT_ID'); },
    get clientSecret() { return env('EAGLE_KC_CLIENT_SECRET'); },
    get milestone() { return env('EAGLE_ENGAGE_MILESTONE'); }
  }
};

module.exports = settings;
