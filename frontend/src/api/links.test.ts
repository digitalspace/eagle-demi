import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLink, isMine, listLinks, removeLink, repointLink, type ShortLink } from './links';
import { json, noContent, requests, urlOf } from '../test-http';

const LINK: ShortLink = {
  id: 'site-c-eac',
  url: 'https://demi.gov.bc.ca/projects/402',
  note: 'printed handout',
  shortUrl: 'https://demi.gov.bc.ca/s/site-c-eac',
  createdAt: '2026-08-24T00:00:00.000Z',
  createdBy: 'j.okafor',
  updatedAt: null,
  personal: false,
};

const stub = (...answers: Response[]) => {
  const fetchMock = vi.fn(async () => answers.shift() ?? json({}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe('the links API', () => {
  it('GETs /links', async () => {
    const fetchMock = stub(json([LINK]));

    expect(await listLinks()).toEqual([LINK]);
    expect(urlOf(fetchMock.mock.calls[0])).toContain('/api/links');
  });

  it('POSTs the destination, note and custom code', async () => {
    const fetchMock = stub(json(LINK, 201));

    await createLink('https://demi.gov.bc.ca/x', 'poster', 'abc', false);

    expect(requests(fetchMock)[0]).toContain('POST');
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({
      url: 'https://demi.gov.bc.ca/x',
      note: 'poster',
      code: 'abc',
      personal: false,
    });
  });

  // An empty note or code must not reach the API as '': the route reads a present key as a value.
  it('omits a blank note and a blank code, and carries the personal flag', async () => {
    const fetchMock = stub(json(LINK, 201));

    await createLink('https://demi.gov.bc.ca/x', '', '', true);

    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ url: 'https://demi.gov.bc.ca/x', personal: true });
  });

  it('PUTs a repoint and DELETEs by code', async () => {
    const fetchMock = stub(json(LINK), noContent());

    await repointLink('site-c-eac', 'https://demi.gov.bc.ca/y');
    await removeLink('site-c-eac');

    const [put, del] = requests(fetchMock);
    expect(put).toContain('PUT');
    expect(put).toContain('/api/links/site-c-eac');
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ url: 'https://demi.gov.bc.ca/y' });
    expect(del).toContain('DELETE');
    expect(del).toContain('/api/links/site-c-eac');
  });

  it('surfaces the API error message', async () => {
    stub(json({ error: 'Code already in use' }, 409));

    await expect(createLink('https://demi.gov.bc.ca/x', '', 'taken', false)).rejects.toThrow(
      'Code already in use',
    );
  });
});

describe('isMine', () => {
  // The API lowercases createdBy; the token claim is not guaranteed to be, so a case-sensitive
  // comparison would file every one of the caller's own links under "Shared links".
  it('matches the username case-insensitively', () => {
    expect(isMine(LINK, 'J.Okafor')).toBe(true);
  });

  it('claims nothing for a caller with no username', () => {
    expect(isMine(LINK, '')).toBe(false);
  });
});
