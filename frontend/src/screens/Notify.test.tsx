import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notify } from './Notify';
import { renderScreen } from '../test-query';
import { json, requests, respond } from '../test-http';

/** The API modules read config at call time; this screen only needs the notify base. */
let notifyLocation: string | undefined = '/notify-api';
vi.mock('../config', () => ({
  config: () => ({ API_PATH: '/api', NOTIFY_API_LOCATION: notifyLocation, KEYCLOAK_ENABLED: false }),
}));

const STATS = {
  subscribers: { confirmed: 1200, unconfirmed: 34, unsubscribed: 8 },
  services: [{ serviceName: 'project-updates', confirmed: 1180 }],
  confirmationsByDay: [],
  bounces: { addresses: 5, hard: 2 },
  sending: { usedThisHour: 12, hourlyBudget: 500 },
  templates: 3,
};

const CAMPAIGNS = {
  campaigns: [
    { id: 'c1', status: 'sending', templateName: 'Weekly digest', serviceLabel: 'Project updates', templateVersion: 2, audience: 900, sent: 400, failed: 1, createdAt: '2026-09-03T17:30:00Z' },
    { id: 'c2', status: 'sending', templateName: 'Backlog', audience: 10, sent: 0, failed: 0, createdAt: '2026-09-02T17:30:00Z' },
  ],
  activeId: 'c1',
};

beforeEach(() => {
  vi.unstubAllGlobals();
  notifyLocation = '/notify-api';
});

describe('Notify', () => {
  it('reads stats and campaigns from the notify host, not the DEMI API', async () => {
    const fetchMock = respond(json(STATS), json(CAMPAIGNS));
    renderScreen(<Notify />);

    await screen.findByText('1,200');
    expect(requests(fetchMock)).toEqual([
      `GET ${window.location.origin}/notify-api/api/staff/stats`,
      `GET ${window.location.origin}/notify-api/api/staff/campaigns`,
    ]);
  });

  it('shows the endpoint, a connected pill and the stat figures once loaded', async () => {
    respond(json(STATS), json(CAMPAIGNS));
    renderScreen(<Notify />);

    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText(`${window.location.host}/notify-api/api`)).toBeTruthy();
    expect(screen.getByText('12 / 500')).toBeTruthy();
    expect(screen.getByText('project-updates')).toBeTruthy();
  });

  it('names the oldest sending campaign Sending and queues the rest', async () => {
    respond(json(STATS), json(CAMPAIGNS));
    renderScreen(<Notify />);

    expect(await screen.findByText('Sending')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
  });

  it('reports a 403 as a missing staff role rather than an unreachable service', async () => {
    respond(json({ error: 'forbidden' }, 403), json({ error: 'forbidden' }, 403));
    renderScreen(<Notify />);

    expect(await screen.findByText('No staff role')).toBeTruthy();
    expect(screen.getByText('eagle-notify returned HTTP 403')).toBeTruthy();
  });

  // The message comes from another service, so only reasons this app has wording for are rendered.
  it('keeps eagle-notify’s own text off the screen', async () => {
    const text = 'Error: pg_query failed at 10.0.0.4 for role notify_rw';
    respond(json({ error: text }, 500), json({ error: text }, 500));
    renderScreen(<Notify />);

    expect(await screen.findByText('eagle-notify returned HTTP 500')).toBeTruthy();
    expect(screen.queryByText(text)).toBeNull();
  });

  it('asks for nothing and says so when no notify service is set', async () => {
    notifyLocation = undefined;
    const fetchMock = respond(json(STATS), json(CAMPAIGNS));
    renderScreen(<Notify />);

    expect(await screen.findByText(/No eagle-notify service is set/)).toBeTruthy();
    expect(screen.queryByText('Connection')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for nothing when the service is named by a relative path in a build', async () => {
    vi.stubEnv('DEV', false);
    const fetchMock = respond(json(STATS), json(CAMPAIGNS));
    renderScreen(<Notify />);

    expect(await screen.findByText(/No eagle-notify service is set/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('reports a 401 against the token, not the service', async () => {
    respond(json({}, 401), json({}, 401));
    renderScreen(<Notify />);

    expect(await screen.findByText("Token's client not allowed on eagle-notify")).toBeTruthy();
  });

  it('shows the empty tables when nothing has been sent or subscribed', async () => {
    respond(json({ ...STATS, services: [] }), json({ campaigns: [], activeId: null }));
    renderScreen(<Notify />);

    expect(await screen.findByText('No service has a confirmed subscriber.')).toBeTruthy();
    expect(screen.getByText('No campaigns have been created.')).toBeTruthy();
  });

  it('sends straight away when eagle-notify holds one template', async () => {
    const fetchMock = respond(
      json(STATS),
      json(CAMPAIGNS),
      json({ templates: [{ id: 't1', name: 'Digest', subject: 'Hi' }] }),
      json({ to: 'someone@gov.bc.ca' }),
    );
    renderScreen(<Notify />);
    await screen.findByText('Connected');

    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(await screen.findByText('Sent to someone@gov.bc.ca')).toBeTruthy();
    expect(requests(fetchMock).at(-1)).toBe(
      `POST ${window.location.origin}/notify-api/api/staff/templates/t1/test`,
    );
  });

  it('asks which template to send when there is more than one, and sends nothing yet', async () => {
    const fetchMock = respond(
      json(STATS),
      json(CAMPAIGNS),
      json({ templates: [{ id: 't1', name: 'Digest', subject: 'Hi' }, { id: 't2', name: 'Alert', subject: 'Oi' }] }),
      json({ to: 'someone@gov.bc.ca' }),
    );
    renderScreen(<Notify />);
    await screen.findByText('Connected');

    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    const picker = await screen.findByLabelText('Template to test');
    expect(requests(fetchMock).some((line) => line.startsWith('POST'))).toBe(false);

    await userEvent.selectOptions(picker, 't2');
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(await screen.findByText('Sent to someone@gov.bc.ca')).toBeTruthy();
    expect(requests(fetchMock).at(-1)).toBe(
      `POST ${window.location.origin}/notify-api/api/staff/templates/t2/test`,
    );
  });

  it('names the refusal on a failed test send and leaves the connection pill alone', async () => {
    respond(
      json(STATS),
      json(CAMPAIGNS),
      json({ templates: [{ id: 't1', name: 'Digest', subject: 'Hi' }] }),
      json({ error: 'send_budget_exhausted' }, 429),
    );
    renderScreen(<Notify />);
    await screen.findByText('Connected');

    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(await screen.findByText('Send budget exhausted, try later')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  });

  it('reports a failed template read against the send, not the connection', async () => {
    respond(json(STATS), json(CAMPAIGNS), json({ error: 'templates unavailable' }, 500));
    renderScreen(<Notify />);
    await screen.findByText('Connected');

    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(await screen.findByText('eagle-notify returned HTTP 500')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('says there is nothing to send when eagle-notify holds no template', async () => {
    const fetchMock = respond(json(STATS), json(CAMPAIGNS), json({ templates: [] }));
    renderScreen(<Notify />);
    await screen.findByText('Connected');

    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(await screen.findByText('No template to send')).toBeTruthy();
    expect(requests(fetchMock).some((line) => line.startsWith('POST'))).toBe(false);
  });
});
