import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccessModel } from './AccessModel';
import { json } from '../test-http';
import { renderScreen } from '../test-query';
import type { SimulateResponse } from '../api/access';
import { READ_TIMEOUT_MS } from '../api/client';

vi.mock('../api/keycloak', () => ({
  getToken: () => 'test-token',
  refreshToken: async () => false,
}));

/** An answer shaped exactly like `POST /access/simulate` returns one. */
const answer = (over: Partial<SimulateResponse> = {}): SimulateResponse => ({
  roles: ['public', 'staff'],
  level: 2,
  tier: 'public',
  privileged: false,
  staffUi: true,
  rows: {
    1: { readable: true, via: 'team', read: ['team'] },
    2: { readable: true, via: 'role', read: ['staff'] },
    3: { readable: true, via: 'role', read: ['staff', 'idir'] },
    4: { readable: true, via: 'role', read: ['staff', 'idir', 'public'] },
  },
  fields: {
    projects: [
      { field: 'name', defaultVis: 4, maxVis: 4, when: null, visible: true },
      { field: 'cacEmail', defaultVis: 2, maxVis: 4, when: 'cacPublished', visible: true },
      { field: 'read', defaultVis: 0, maxVis: 0, when: null, visible: false },
    ],
    documents: [
      { field: 'displayName', defaultVis: 4, maxVis: 4, when: null, visible: true },
      { field: 's3Key', defaultVis: 0, maxVis: 0, when: null, visible: false },
    ],
  },
  predicatesAssumedFalse: true,
  notes: { sealedCompartment: 'live, /api/sealed only' },
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

/** Answer every simulate call the same way. */
function stub(reply: () => Response = () => json(answer())) {
  fetchMock = vi.fn(async () => reply());
  vi.stubGlobal('fetch', fetchMock);
}

/** The bodies POSTed to the simulator, oldest first. */
const simulatePosts = (): RequestInit[] =>
  fetchMock.mock.calls
    .filter((call) => String(call[0]).includes('/access/simulate'))
    .map((call) => call[1] as RequestInit);

const lastBody = () => JSON.parse(String(simulatePosts().at(-1)?.body)) as Record<string, unknown>;

const SIGNED_IN = { authenticated: true, isStaff: true, level: 2, staffUi: true };

/** Render signed in and wait for the first answer to land. */
async function settle() {
  renderScreen(<AccessModel />, SIGNED_IN);
  await screen.findByText('Roles after the engine resolves them');
}

const attentionRow = (text: string) =>
  screen.getAllByText(text, { selector: '.attention-row__title' })[0].closest('.attention-row') as HTMLElement;

const fieldNames = () =>
  screen.getAllByRole('cell').map((cell) => cell.querySelector('code')?.textContent).filter(Boolean);

beforeEach(() => stub());

afterEach(() => vi.unstubAllGlobals());

describe('the described caller', () => {
  it('sends the described caller as the request body, omitting what was not asked for', async () => {
    const user = userEvent.setup();
    await settle();

    await user.click(screen.getByLabelText('staff'));
    await user.click(screen.getByLabelText('IDIR'));
    await user.type(screen.getByLabelText(/Team membership/), '402, 111');
    await user.type(screen.getByLabelText(/Key project scope/), '402');
    await user.click(screen.getByLabelText('The caller holds one'));
    await user.type(await screen.findByLabelText(/Scope ids/), '402');
    await user.click(screen.getByLabelText('Level 3'));

    await waitFor(() =>
      expect(lastBody()).toEqual({
        roles: ['public', 'staff'],
        identityProvider: 'idir',
        teams: ['402', '111'],
        projectScope: ['402'],
        credential: { scope: { type: 'project', ids: ['402'] }, levels: [2, 3] },
      }),
    );
    expect(simulatePosts().at(-1)?.method).toBe('POST');
  });

  it('omits every optional key for a caller with nothing but the public floor', async () => {
    await settle();

    expect(lastBody()).toEqual({ roles: ['public'] });
  });

  it('omits a scope box holding only separators — an empty scope reads nothing', async () => {
    await settle();

    fireEvent.change(screen.getByLabelText(/Key project scope/), { target: { value: ',' } });

    await waitFor(() => expect(lastBody()['roles']).toEqual(['public']));
    expect(lastBody()['projectScope']).toBeUndefined();
  });

  it('omits a ticked credential until it has ids and levels — half-typed is not refusable', async () => {
    const user = userEvent.setup();
    await settle();

    await user.click(screen.getByLabelText('The caller holds one'));

    await waitFor(() => expect(screen.getByLabelText('Level 1')).toBeInTheDocument());
    expect(lastBody()['credential']).toBeUndefined();
  });

  it('carries the caller‘s bearer token, which the simulator now requires', async () => {
    await settle();

    expect(new Headers(simulatePosts()[0].headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('collapses rapid changes into one request', async () => {
    await settle();
    const before = simulatePosts().length;

    const teams = screen.getByLabelText(/Team membership/);
    fireEvent.change(teams, { target: { value: '4' } });
    fireEvent.change(teams, { target: { value: '40' } });
    fireEvent.change(teams, { target: { value: '402' } });

    await waitFor(() => expect(lastBody()['teams']).toEqual(['402']));
    expect(simulatePosts().length - before).toBe(1);
  });

  it('asks nothing and offers a sign-in message when there is no session', async () => {
    renderScreen(<AccessModel />);

    expect(await screen.findByText(/Sign in to run the simulator/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(simulatePosts()).toHaveLength(0);
  });
});

describe('the engine‘s answer', () => {
  it('renders each ladder row with the arm that got the caller there', async () => {
    await settle();

    expect(attentionRow('Level 1 — Team only').textContent).toContain('via team');
    expect(attentionRow('Level 1 — Team only').textContent).toContain('Readable');
    expect(attentionRow('Level 2 — All EAO').textContent).toContain('via role');
  });

  it('draws the read[] chips from the response, never from a local copy of the ladder', async () => {
    await settle();

    const chips = within(attentionRow('Level 3 — All IDIR'))
      .getAllByText(/./, { selector: '.role-chip' })
      .map((chip) => chip.textContent);
    expect(chips).toEqual(['staff', 'idir']);
  });

  it('marks an unreachable level withheld and shows no arm', async () => {
    stub(() =>
      json(
        answer({
          rows: {
            1: { readable: false, via: null, read: ['team'] },
            2: { readable: false, via: null, read: ['staff'] },
            3: { readable: false, via: null, read: ['staff', 'idir'] },
            4: { readable: true, via: 'role', read: ['staff', 'idir', 'public'] },
          },
        }),
      ),
    );
    await settle();

    const row = attentionRow('Level 1 — Team only');
    expect(row.textContent).toContain('Withheld');
    expect(row.textContent).not.toContain('via');
  });

  it('renders the field catalogs and hides the plumbing keys until asked', async () => {
    const user = userEvent.setup();
    await settle();

    expect(fieldNames()).toContain('name');
    expect(fieldNames()).toContain('cacEmail');
    expect(fieldNames()).not.toContain('read');
    expect(fieldNames()).not.toContain('s3Key');
    expect(screen.getAllByText(/1 plumbing key hidden/).length).toBeGreaterThan(0);

    await user.click(screen.getByLabelText('Show plumbing keys'));

    expect(fieldNames()).toContain('read');
    expect(fieldNames()).toContain('s3Key');
  });

  it('shows a field‘s predicate and its dial ceiling', async () => {
    await settle();

    const row = screen.getByText('cacEmail').closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual([
      'cacEmail',
      '2',
      '4',
      'cacPublished',
      'Returned',
    ]);
  });

  it('renders the sealed compartment as a note from the response, never a control', async () => {
    await settle();

    const sealed = attentionRow('Level 0 — sealed compartment');
    expect(sealed.textContent).toContain('live, /api/sealed only');
    expect(sealed.querySelector('input')).toBeNull();
  });

  it('never asks /me itself — the session already holds the real caller', async () => {
    await settle();

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/me'))).toHaveLength(0);
    expect(screen.getByText(/You, right now: level/).textContent).toContain('level 2');
  });
});

describe('a refusal', () => {
  it('drops the answer it was showing and reports the engine‘s own message', async () => {
    await settle();
    expect(screen.getByText('Roles after the engine resolves them')).toBeInTheDocument();

    stub(() => json({ error: 'scope.ids must be a non-empty array' }, 400));
    fireEvent.change(screen.getByLabelText(/Team membership/), { target: { value: '402' } });

    expect(await screen.findByText(/scope.ids must be a non-empty array/)).toBeInTheDocument();
    expect(screen.queryByText('Roles after the engine resolves them')).not.toBeInTheDocument();
  });

  it('reports a request that never came back as silence, not as a refusal message', async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    renderScreen(<AccessModel />, SIGNED_IN);

    expect(await screen.findByText(/The access engine did not answer/)).toBeInTheDocument();
  });

  it('gives up on a hung simulate rather than waiting forever', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const budget = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(10));
    fetchMock = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderScreen(<AccessModel />, SIGNED_IN);

    expect(await screen.findByText(/The access engine did not answer/)).toBeInTheDocument();
    expect(budget).toHaveBeenCalledWith(READ_TIMEOUT_MS);
  });

  it('falls back to the status when the engine refuses without a message', async () => {
    stub(() => json({}, 503));

    renderScreen(<AccessModel />, SIGNED_IN);

    expect(await screen.findByText(/The access engine answered 503/)).toBeInTheDocument();
  });
});
