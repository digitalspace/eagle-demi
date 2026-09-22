import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulateAccess } from './access';

vi.mock('../config', () => ({ config: () => ({ API_PATH: '/api' }) }));

const REQUEST = { roles: ['public'] };

const stub = (answer: Response) => vi.stubGlobal('fetch', vi.fn(async () => answer));

afterEach(() => vi.unstubAllGlobals());

describe('simulateAccess', () => {
  it('reports the engine’s own refusal', async () => {
    stub(new Response(JSON.stringify({ error: 'roles must be an array' }), { status: 400 }));

    await expect(simulateAccess(REQUEST)).rejects.toThrow('roles must be an array');
  });

  it('names the status when a refusal carries no message', async () => {
    stub(new Response('', { status: 503 }));

    await expect(simulateAccess(REQUEST)).rejects.toThrow('The access engine answered 503.');
  });

  // An answer with nothing in it is still an answer, which is how the Angular screen reported it.
  it('reports a 200 whose body will not parse as an answer, not as silence', async () => {
    stub(new Response('<html>gateway</html>', { status: 200 }));

    await expect(simulateAccess(REQUEST)).rejects.toThrow('The access engine answered 200.');
  });

  it('reports a request that never came back as silence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));

    await expect(simulateAccess(REQUEST)).rejects.toThrow('The access engine did not answer.');
  });
});
