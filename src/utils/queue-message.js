'use strict';

/** A queue body as an object: a Buffer or string is JSON-parsed, anything else passes through as is. */
function queueBody(message, what) {
  if (!Buffer.isBuffer(message) && typeof message !== 'string') return message;
  const text = Buffer.isBuffer(message) ? message.toString('utf8') : message;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what} message is not JSON: ${err.message}`, { cause: err });
  }
}

module.exports = { queueBody };
