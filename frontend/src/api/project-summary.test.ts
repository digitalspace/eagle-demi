import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLists,
  fetchOrganizations,
  fetchProjectFacts,
  fetchProjectSummary,
  joinLabels,
  resolveListLabel,
} from './project-summary';
import { json, respond, urlOf } from '../test-http';

afterEach(() => vi.unstubAllGlobals());

const LISTS = new Map([['5d3f6c7eda7a384218296035', 'Post Decision - Construction']]);

describe('resolveListLabel', () => {
  it('turns a stored List ObjectId into its name', () => {
    expect(resolveListLabel('5d3f6c7eda7a384218296035', LISTS)).toEqual({
      text: 'Post Decision - Construction',
      unresolved: false,
      pending: false,
    });
  });

  it('passes a value that is already a name through untouched', () => {
    expect(resolveListLabel('Peace', LISTS).text).toBe('Peace');
  });

  it('reads the name off the {_id, name} shape without consulting the lookup', () => {
    expect(resolveListLabel({ _id: 'nothing-matches', name: 'BC Hydro' }, null)).toEqual({
      text: 'BC Hydro',
      unresolved: false,
      pending: false,
    });
  });

  it('falls back to the id, marked unresolved, when no row matches', () => {
    const label = resolveListLabel('aaaaaaaaaaaaaaaaaaaaaaaa', LISTS);
    expect(label).toEqual({ text: 'aaaaaaaaaaaaaaaaaaaaaaaa', unresolved: true, pending: false });
  });

  it('withholds an id while the lookup is still in flight', () => {
    expect(resolveListLabel('5d3f6c7eda7a384218296035', null)).toEqual({
      text: '',
      unresolved: false,
      pending: true,
    });
  });

  it('does not stall a plain name on a lookup that has not landed', () => {
    expect(resolveListLabel('Peace', null)).toEqual({ text: 'Peace', unresolved: false, pending: false });
  });

  it('answers empty for a field the record does not carry', () => {
    expect(resolveListLabel(undefined, LISTS).text).toBe('');
  });
});

describe('joinLabels', () => {
  it('renders the resolved names as one line', () => {
    expect(joinLabels(['Peace', '5d3f6c7eda7a384218296035'], LISTS, ' · ').text).toBe(
      'Peace · Post Decision - Construction',
    );
  });

  it('names every id it could not place in the title, and nothing when all resolved', () => {
    expect(joinLabels(['aaaaaaaaaaaaaaaaaaaaaaaa'], LISTS, ', ').title).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(joinLabels(['Peace'], LISTS, ', ').title).toBe('');
  });

  it('drops an absent field rather than leaving a stray separator', () => {
    expect(joinLabels([undefined, 'Peace'], LISTS, ' · ').text).toBe('Peace');
  });
});

describe('fetchLists', () => {
  it('reads every List row in one page and indexes it by id', async () => {
    const fetchMock = respond(json([{ searchResults: [{ id: 'a1', name: 'Pre-Application' }] }]));

    expect(await fetchLists()).toEqual(new Map([['a1', 'Pre-Application']]));
    expect(urlOf(fetchMock.mock.calls[0])).toContain('dataset=List');
  });

  it('drops a row with no name so the id shows with its explanation instead of a blank', async () => {
    respond(json([{ searchResults: [{ id: 'a1' }, { id: 'a2', name: 'Application Review' }] }]));

    expect(await fetchLists()).toEqual(new Map([['a2', 'Application Review']]));
  });

  it('settles on an empty table when the lookup fails, rather than leaving labels pending', async () => {
    respond(json({ error: 'boom' }, 500));

    expect(await fetchLists()).toEqual(new Map());
  });
});

describe('fetchOrganizations', () => {
  it('indexes Indigenous Group rows on the id the generator stored', async () => {
    const fetchMock = respond(
      json([{ searchResults: [{ id: 'org1', _id: 'mongo1', name: 'Sample Nation', city: 'Victoria' }] }]),
    );

    const rows = await fetchOrganizations();

    expect(rows.get('org1')).toMatchObject({ id: 'org1', name: 'Sample Nation', city: 'Victoria' });
    expect(urlOf(fetchMock.mock.calls[0])).toContain('dataset=Organization');
  });

  it('settles on an empty table when the lookup fails, so the cards lose detail and not the section', async () => {
    respond(json({ error: 'boom' }, 500));

    expect(await fetchOrganizations()).toEqual(new Map());
  });
});

describe('fetchProjectFacts', () => {
  it('returns the project record', async () => {
    respond(json({ id: '272', name: 'Site C' }));

    expect(await fetchProjectFacts('272')).toMatchObject({ name: 'Site C' });
  });

  it('gives one answer for hidden and missing, so neither discloses the other', async () => {
    // Twice: the client refreshes the token and replays once on a 403 before giving up.
    respond(json({ error: 'nope' }, 403), json({ error: 'nope' }, 403));
    await expect(fetchProjectFacts('272')).rejects.toThrow(
      'That project is not in the registry, or you do not have access to it.',
    );

    respond(json({ error: 'nope' }, 404));
    await expect(fetchProjectFacts('272')).rejects.toThrow(
      'That project is not in the registry, or you do not have access to it.',
    );
  });

  it('names the status for any other failure', async () => {
    respond(json({ error: 'boom' }, 500));

    await expect(fetchProjectFacts('272')).rejects.toThrow('Could not load the project (HTTP 500).');
  });
});

describe('fetchProjectSummary', () => {
  it('loads the record for a reader who may see it', async () => {
    respond(json({ id: 's1', projectId: '272', generatedAt: '2026-01-01T00:00:00Z', model: 'a-model' }));

    expect(await fetchProjectSummary('272')).toEqual({
      record: expect.objectContaining({ id: 's1' }),
      reason: null,
    });
  });

  it('reads 404 as no row generated yet', async () => {
    respond(json({ error: 'not found' }, 404));

    expect(await fetchProjectSummary('272')).toEqual({ record: null, reason: 'missing' });
  });

  it('reads a 401 from an expired session as a sign-in gate, not a failure', async () => {
    respond(json({ error: 'nope' }, 401), json({ error: 'nope' }, 401));

    expect(await fetchProjectSummary('272')).toEqual({ record: null, reason: 'signin' });
  });

  it('reads a 403 the same way', async () => {
    respond(json({ error: 'nope' }, 403), json({ error: 'nope' }, 403));

    expect(await fetchProjectSummary('272')).toEqual({ record: null, reason: 'signin' });
  });

  it('still keeps a real outage an error', async () => {
    respond(json({ error: 'boom' }, 500));

    expect(await fetchProjectSummary('272')).toEqual({ record: null, reason: 'error' });
  });

  it('reads the switched-off body the same way the search summary sends it', async () => {
    respond(json({ summary: null, reason: 'disabled' }));

    expect(await fetchProjectSummary('272')).toEqual({ record: null, reason: 'disabled' });
  });
});
