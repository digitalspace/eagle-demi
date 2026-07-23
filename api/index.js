'use strict';

const { app } = require('@azure/functions');
const serverless = require('serverless-http');
const expressApp = require('../src/app');

// Wrap Express app as serverless Azure Function handler
const handler = serverless(expressApp);

// Register Azure Functions v4 HTTP Trigger
app.http('expressApi', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '{*segments}',
  handler: async (request, context) => {
    return handler(request, context);
  }
});
