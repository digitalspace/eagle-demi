'use strict';

/** Response stub for calling a controller directly: records status, body and headers. */
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    send(body) { this.body = body; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

module.exports = { mockRes };
