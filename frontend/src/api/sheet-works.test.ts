import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { json, respond, urlOf } from '../test-http';
import { queryWrapper } from '../test-query';
import { ApiError } from './client';
import { useWorkplans } from './sheet-works';

vi.mock('./keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => true,
}));

beforeEach(async () => {
  window.__env = { API_PATH: '/api', API_LOCATION: '' };
  const { initConfig } = await import('../config');
  await initConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('useWorkplans', () => {
  it('hands a 404 from /workplans to the caller as error.status', async () => {
    const fetchMock = respond(json({ error: 'Not found' }, 404));

    const { result } = renderHook(() => useWorkplans(), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(urlOf(fetchMock.mock.calls[0])).toMatch(/\/api\/workplans$/);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(404);
  });
});
