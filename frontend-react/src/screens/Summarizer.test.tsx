import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Summarizer } from './Summarizer';
import { renderScreen } from '../test-query';
import { json } from '../test-http';
import type { Session } from '../session/session';

const STAFF: Partial<Session> = { authenticated: true, isStaff: true, settled: true };

const ANSWER = {
  summary: 'Crossings are monitored quarterly.',
  citations: [
    {
      n: 1,
      chunkId: 'c1',
      documentId: 'doc1',
      projectId: 'proj1',
      pageNumber: 12,
      documentName: 'Schedule B',
      projectName: 'Site C',
    },
  ],
  estimatedCostCad: 0.0123,
  usage: { prompt_tokens: 900, completion_tokens: 120 },
};

function stub(...responses: Response[]) {
  const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(responses.shift() ?? json(ANSWER)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const askBox = () => screen.getByLabelText('Ask a question of the registry');
const askButton = () => screen.getByRole('button', { name: /^(Ask|Asking…)$/ });

afterEach(() => vi.unstubAllGlobals());

describe('Summarizer', () => {
  it('sends no request until the question is asked, then renders the answer and its sources', async () => {
    const fetchMock = stub();

    renderScreen(<Summarizer />, STAFF);

    await userEvent.type(askBox(), 'watercourse crossing');
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(askButton());

    expect(await screen.findByText(ANSWER.summary)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/search/summary?keywords=watercourse%20crossing&fuzzy=true',
    );
    expect(screen.getByText('AI-generated from the sources below')).toBeInTheDocument();
    expect(screen.getByText('Schedule B')).toBeInTheDocument();
    expect(screen.getByText('Site C')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('asks on Enter as well as on the button', async () => {
    const fetchMock = stub();

    renderScreen(<Summarizer />, STAFF);

    await userEvent.type(askBox(), 'pipeline{Enter}');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('labels the cost as an estimate and names the token counts behind it', async () => {
    stub();

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');

    const line = await screen.findByText(/est\. /);
    expect(line).toHaveTextContent('CA$0.0123');
    expect(line).toHaveTextContent('900 tokens in / 120 out');
    expect(line).toHaveTextContent('estimated from list rates, not billed amounts');
  });

  it('will not send a blank question', async () => {
    const fetchMock = stub();

    renderScreen(<Summarizer />, STAFF);

    expect(askButton()).toBeDisabled();
    await userEvent.type(askBox(), '   {Enter}');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says why an answer is null rather than leaving the panel empty', async () => {
    stub(json({ summary: null, reason: 'no_results' }));

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'zzzz{Enter}');

    expect(
      await screen.findByText('Nothing in the registry matched that. Try different or fewer words.'),
    ).toBeInTheDocument();
  });

  it('says the summariser is switched off when the API says so', async () => {
    stub(json({ summary: null, reason: 'disabled' }));

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');

    expect(await screen.findByText('The summariser is switched off in this environment.')).toBeInTheDocument();
  });

  it('keeps a failed read a message about the summariser, not about the search results', async () => {
    // Retried twice on a 5xx, as the Angular fetch did, before the message lands.
    stub(json({ error: 'boom' }, 500), json({ error: 'boom' }, 500), json({ error: 'boom' }, 500));

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');

    expect(
      await screen.findByText(
        'The summariser could not answer that. The search results themselves are unaffected.',
        undefined,
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 10000);

  it('aborts an answer still in flight when the reader leaves the page', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const { signal } = fetchMock.mock.calls[0][1] as RequestInit;
    expect(signal!.aborted).toBe(false);

    unmount();

    await waitFor(() => expect(signal!.aborted).toBe(true));
  });

  it('drops the previous answer when asking it again fails', async () => {
    const failure = () => json({ error: 'boom' }, 500);
    stub(json(ANSWER), failure(), failure(), failure());

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');
    expect(await screen.findByText(ANSWER.summary)).toBeInTheDocument();

    await userEvent.click(askButton());

    expect(
      await screen.findByText(
        'The summariser could not answer that. The search results themselves are unaffected.',
        undefined,
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(ANSWER.summary)).not.toBeInTheDocument();
    expect(screen.queryByText('Schedule B')).not.toBeInTheDocument();
    expect(screen.queryByText(/est\. /)).not.toBeInTheDocument();
  }, 10000);

  it('clears the answer when the box is emptied and asked again', async () => {
    stub();

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');
    expect(await screen.findByText(ANSWER.summary)).toBeInTheDocument();

    await userEvent.clear(askBox());
    await userEvent.type(askBox(), '{Enter}');

    await waitFor(() => expect(screen.queryByText(ANSWER.summary)).not.toBeInTheDocument());
    expect(screen.queryByText('Schedule B')).not.toBeInTheDocument();
    expect(screen.queryByText(/est\. /)).not.toBeInTheDocument();
  });

  it('clears a reason callout when the box is emptied and asked again', async () => {
    stub(json({ summary: null, reason: 'no_results' }));

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'zzzz{Enter}');
    expect(await screen.findByText(/Nothing in the registry matched that/)).toBeInTheDocument();

    await userEvent.clear(askBox());
    await userEvent.type(askBox(), '{Enter}');

    await waitFor(() => expect(screen.queryByText(/Nothing in the registry matched that/)).not.toBeInTheDocument());
  });

  it('marks only the pressed row busy when two citations share one document', async () => {
    const twoCitations = {
      ...ANSWER,
      citations: [
        { ...ANSWER.citations[0], n: 1, chunkId: 'c1' },
        { ...ANSWER.citations[0], n: 2, chunkId: 'c2', pageNumber: 13 },
      ],
    };
    // The download read never settles, so the busy state stays on screen to be read.
    const fetchMock = vi.fn((..._args: unknown[]) =>
      fetchMock.mock.calls.length === 1 ? Promise.resolve(json(twoCitations)) : new Promise<Response>(() => undefined),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Download' }))[0]);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Preparing…' })).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });

  it('offers a download per cited passage, with the project id the citation carries', async () => {
    const fetchMock = stub(json(ANSWER), json({ url: 'https://storage.example/presigned' }));
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderScreen(<Summarizer />, STAFF);
    await userEvent.type(askBox(), 'pipeline{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));

    await waitFor(() => expect(open).toHaveBeenCalledWith('https://storage.example/presigned', '_blank', 'noopener'));
    expect(String(fetchMock.mock.calls[1][0])).toContain('/documents/doc1/download?project=proj1');
  });
});
