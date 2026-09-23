import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { render, type RenderResult } from '@testing-library/react';
import { ANONYMOUS_SESSION, SessionContext, type Session } from './session/session';

/**
 * A client per test. One shared across tests leaks cached answers between them, and retries are
 * off so a failure assertion does not wait out the real backoff.
 */
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

export function queryWrapper(client: QueryClient = testQueryClient()) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

export function withQueryClient(children: ReactNode): ReactElement {
  const Wrapper = queryWrapper();
  return <Wrapper>{children}</Wrapper>;
}

/** A screen under a fresh query cache, a router and a session, as App wires them. */
export function renderScreen(ui: ReactElement, session: Partial<Session> = {}): RenderResult {
  return render(
    withQueryClient(
      <MemoryRouter>
        <SessionContext.Provider value={{ ...ANONYMOUS_SESSION, ...session }}>{ui}</SessionContext.Provider>
      </MemoryRouter>,
    ),
  );
}
