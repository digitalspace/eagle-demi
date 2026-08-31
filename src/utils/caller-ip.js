'use strict';

/** The one definition of "who is this caller", shared by the request log and the audit trail. */
function callerIp(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '');
  // The LAST entry, never the first: everything before it is caller-supplied, and App Service
  // appends the real `<client-ip>:<port>` after whatever the client sent.
  const last = forwarded.split(',').pop().trim();
  // IPv4 arrives as `1.2.3.4:5678`; bare IPv6 contains colons of its own, so only strip a port when
  // the tail is a plain `:digits` on something that is not already bracketed.
  const withoutPort = /^\[.*\]:\d+$/.test(last)
    ? last.replace(/^\[(.*)\]:\d+$/, '$1')
    : last.replace(/^([^:]+):\d+$/, '$1');

  return withoutPort || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

module.exports = { callerIp };
