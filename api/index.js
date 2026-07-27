'use strict';

const { app } = require('@azure/functions');
const serverless = require('serverless-http');

let handler = null;

function getHandler() {
  if (handler) return handler;
  const expressApp = require('../src/app');
  handler = serverless(expressApp, {
    request(request, event, context) {
      if (context) {
        context.callbackWaitsForEmptyEventLoop = false;
      }
    }
  });
  return handler;
}

async function handleExpress(request, context) {
  try {
    const serverlessHandler = getHandler();
    return await serverlessHandler(request, context);
  } catch (err) {
    context.error('[expressApi] Adapter Error:', err);
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Internal Server Error', stack: err.stack })
    };
  }
}

app.http('expressApi', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '{*rest}',
  handler: handleExpress
});

app.http('expressApiRoot', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '',
  handler: handleExpress
});


