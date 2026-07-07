'use strict';

module.exports = (req, res, next) => {
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY || 'eagle-demi-api-key';

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing X-Api-Key header.' });
  }
  next();
};
