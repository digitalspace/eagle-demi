import { vi } from 'vitest';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A 204, which carries no body at all — `new Response('', { status: 204 })` throws. */
export const noContent = () => new Response(null, { status: 204 });

/**
 * Stubs `fetch` with these answers in order. Anything asked for past them gets an empty object,
 * which every reader here treats as "answered, nothing in it".
 */
export function respond(...responses: Response[]) {
  const fetchMock = vi.fn(async (..._args: unknown[]) => responses.shift() ?? json({}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL a recorded `fetch` call was sent to. */
export const urlOf = (call: unknown[]): string => String(call[0]);

/** `fetch` calls as `METHOD url`, which is what the request-order assertions read. */
export const requests = (mock: { mock: { calls: unknown[][] } }): string[] =>
  mock.mock.calls.map(([input, init]) => `${(init as RequestInit | undefined)?.method || 'GET'} ${String(input)}`);
