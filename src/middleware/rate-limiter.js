'use strict';

const hits = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS = 300;     // 300 requests per minute per IP

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of hits.entries()) {
    if (now - data.startTime > WINDOW_MS) {
      hits.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = (req, res, next) => {
  // Skip rate limiting in test environment
  if (process.env.NODE_ENV === 'test') {
    return next();
  }

  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();

  let record = hits.get(ip);
  if (!record || (now - record.startTime > WINDOW_MS)) {
    record = { count: 1, startTime: now };
    hits.set(ip, record);
    return next();
  }

  record.count += 1;
  if (record.count > MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  return next();
};
