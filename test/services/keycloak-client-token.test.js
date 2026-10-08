'use strict';

/** The shared client-credentials helper, and the seed's wrapper that keeps its `[seed]` prefix. */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { clientCredentialsToken } = require('../../src/services/keycloak-client-token');
const { clientToken } = require('../../src/seed/sources');

const ISSUER = 'https://login.example/auth/realms/eao-epic';

test('clientCredentialsToken', async (t) => {
  await t.test('posts client credentials to the realm and returns the token and its lifetime', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return Response.json({ access_token: 'tok', expires_in: 300 });
    };

    const result = await clientCredentialsToken({ issuer: ISSUER, clientId: 'c', clientSecret: 's', fetch });

    assert.deepStrictEqual(result, { accessToken: 'tok', expiresIn: 300 });
    assert.deepStrictEqual(calls, [{
      url: `${ISSUER}/protocol/openid-connect/token`,
      body: 'grant_type=client_credentials&client_id=c&client_secret=s'
    }]);
  });

  await t.test('a 2xx without access_token throws', async () => {
    const fetch = async () => Response.json({ expires_in: 300 });
    await assert.rejects(clientCredentialsToken({ issuer: ISSUER, clientId: 'c', clientSecret: 's', fetch }),
      /token for c: the response carries no access_token/);
  });
});

test('the seed token keeps its [seed] prefix on a failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  await assert.rejects(clientToken('track-reader', 's'), { message: '[seed] token for track-reader: HTTP 401' });
});
