'use strict';

/**
 * An engagement URL without its scheme and host: ENGAGE and Eagle can hold one period under
 * different hosts. Null when no path is left, since a bare host identifies no engagement.
 */
function metUrlKey(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return path ? `${path}${url.search}` : null;
}

module.exports = { metUrlKey };
