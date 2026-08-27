'use strict';

/**
 * Short-link destination validation. Stdlib `URL` only — see `docs`/plan for why nothing existing
 * in the repo covers this (CORS's allowlist is a string match, not a URL parse).
 */

const MAX_URL_LENGTH = 2048;

/**
 * @param {string} url
 * @param {string[]} allowedHosts - hostname must equal an entry, or end with '.' + entry.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
function validateDestination(url, allowedHosts) {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, reason: 'url must be a non-empty string' };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `url must be at most ${MAX_URL_LENGTH} characters` };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return { ok: false, reason: 'url is not a valid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'url must use https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'url must not carry credentials' };
  }

  const host = parsed.hostname;
  const allowed = (allowedHosts || []).some(entry => host === entry || host.endsWith(`.${entry}`));
  if (!allowed) {
    return { ok: false, reason: 'url host is not on the allowlist' };
  }

  return { ok: true, url: parsed.href };
}

module.exports = { validateDestination };
