import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInvasiveCounter,
  featureInfoUrl,
  fetchInvasiveMatches,
  fetchInvasiveObservation,
  fetchWildfires,
  INVASIVES_SLD,
  invasivesCql,
  invasivesTileUrl,
  parseHits,
  parseInvasiveObservation,
  wildfireCard,
  type InvasiveMatches,
  type MapView,
} from './layers';

const fetchMock = vi.fn();

const VIEW: MapView = {
  bounds: { west: -126, south: 49, east: -124, north: 50 },
  size: { width: 800, height: 600 },
  pixel: { x: 400.4, y: 299.7 },
};

const jsonAnswer = (body: unknown) =>
  ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }) as Response;
const textAnswer = (body: string) => ({ ok: true, text: async () => body }) as Response;

const hitsXml = (matched: number) =>
  `<wfs:FeatureCollection numberMatched="${matched}" numberReturned="0"></wfs:FeatureCollection>`;

/** The count goes out as two reads, one per rule of the style; answer them apart. */
const hitsAnswering = (present: number, absent: number) =>
  fetchMock.mockImplementation((input: string) => {
    const filter = new URL(String(input)).searchParams.get('CQL_FILTER') ?? '';
    return Promise.resolve(textAnswer(hitsXml(filter.includes('IS NOT NULL') ? present : absent)));
  });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

describe('invasivesCql', () => {
  it('doubles a quote so a name cannot close the literal', () => {
    expect(invasivesCql("Baby's breath")).toBe("INVASIVE_PLANT ILIKE '%Baby''s breath%'");
  });

  it('escapes the wildcards, so they match themselves', () => {
    expect(invasivesCql('50%_knap')).toBe("INVASIVE_PLANT ILIKE '%50\\%\\_knap%'");
  });

  it('filters on nothing when only whitespace was typed', () => {
    expect(invasivesCql('   ')).toBe('');
  });

  // A typed backslash escaped last would have turned the escape in front of the % into a literal
  // one, handing the wildcard straight back to the server.
  it('escapes a typed backslash before the wildcard it sits in front of', () => {
    expect(invasivesCql('a\\%b')).toBe("INVASIVE_PLANT ILIKE '%a\\\\\\%b%'");
  });
});

describe('INVASIVES_SLD', () => {
  it('parses as well-formed XML', () => {
    const doc = new DOMParser().parseFromString(INVASIVES_SLD, 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  });
});

describe('featureInfoUrl', () => {
  it('asks about the clicked pixel of the drawn layer', () => {
    const params = new URL(featureInfoUrl(VIEW)).searchParams;

    expect(params.get('REQUEST')).toBe('GetFeatureInfo');
    expect(params.get('QUERY_LAYERS')).toBe(
      'pub:WHSE_FOREST_VEGETATION.IBC_INVASIVE_SPECIES_OBS_SP',
    );
    expect(params.get('I')).toBe('400');
    expect(params.get('J')).toBe('300');
    expect(params.get('WIDTH')).toBe('800');
    expect(params.get('HEIGHT')).toBe('600');
  });

  it('boxes the viewport in projected metres, corners the way round the server wants', () => {
    const [minX, minY, maxX, maxY] = (new URL(featureInfoUrl(VIEW)).searchParams.get('BBOX') ?? '')
      .split(',')
      .map(Number);

    expect(minX).toBeCloseTo(-14026255.8399525, 3);
    expect(minY).toBeCloseTo(6274861.3940066, 3);
    expect(maxX).toBeCloseTo(-13803616.8583659, 3);
    expect(maxY).toBeCloseTo(6446275.8410172, 3);
  });

  it('names the projection the box is in', () => {
    expect(new URL(featureInfoUrl(VIEW)).searchParams.get('CRS')).toBe('EPSG:3857');
  });

  // Without the same style, the server answers from its own, which draws nothing when zoomed in.
  it('carries the style the tiles are drawn with', () => {
    expect(new URL(featureInfoUrl(VIEW)).searchParams.get('SLD_BODY')).toContain('#ce3e39');
  });

  it('asks about the filtered set when a species is typed', () => {
    const asked = new URL(featureInfoUrl(VIEW, "Baby's breath")).searchParams.get('CQL_FILTER');

    expect(asked).toBe("INVASIVE_PLANT ILIKE '%Baby''s breath%'");
  });

  it('asks about every observation when nothing is typed', () => {
    expect(new URL(featureInfoUrl(VIEW)).searchParams.get('CQL_FILTER')).toBeNull();
  });
});

describe('invasivesTileUrl', () => {
  it('leaves the tile box token for the map to substitute', () => {
    expect(invasivesTileUrl()).toContain('&BBOX={bbox-epsg-3857}');
  });

  it('draws the tiles with the same style the clicks are answered from', () => {
    expect(new URL(invasivesTileUrl()).searchParams.get('SLD_BODY')).toContain('#42814a');
  });

  it('puts the typed species on the tiles', () => {
    expect(new URL(invasivesTileUrl('baby')).searchParams.get('CQL_FILTER')).toBe(
      "INVASIVE_PLANT ILIKE '%baby%'",
    );
  });

  it('takes the filter off the tiles when the species is cleared', () => {
    expect(new URL(invasivesTileUrl('')).searchParams.get('CQL_FILTER')).toBeNull();
  });
});

describe('invasive observation', () => {
  it('splits the scientific name out of the packed name', () => {
    const card = parseInvasiveObservation({
      INVASIVE_PLANT: 'Japanese knotweed (Reynoutria / Fallopia japonica)',
      INVASIVE_PLANT_POSITIVE: 'Japanese knotweed (Reynoutria / Fallopia japonica)',
      ACTIVITY_DATE: '2024-12-17Z',
    });

    expect(card).toEqual({
      name: 'Japanese knotweed',
      scientific: 'Reynoutria / Fallopia japonica',
      observed: '2024-12-17',
      presence: 'Present',
    });
  });

  it('says a confirmed absence is not an infestation', () => {
    const card = parseInvasiveObservation({
      INVASIVE_PLANT: 'Bull thistle',
      INVASIVE_PLANT_POSITIVE: null,
      INVASIVE_PLANT_NEGATIVE: 'Bull thistle',
    });

    expect(card?.presence).toBe('Not present');
  });

  it('leaves presence unsaid when neither column carries a name', () => {
    expect(parseInvasiveObservation({ INVASIVE_PLANT: 'Bull thistle' })?.presence).toBeNull();
  });

  it('reports no observation for a pixel that carries none', () => {
    expect(parseInvasiveObservation(null)).toBeNull();
  });

  it('answers with the observation under the pixel', async () => {
    fetchMock.mockResolvedValue(
      jsonAnswer({
        type: 'FeatureCollection',
        features: [{ properties: { INVASIVE_PLANT: 'Bull thistle' } }],
      }),
    );

    await expect(fetchInvasiveObservation(VIEW)).resolves.toMatchObject({ name: 'Bull thistle' });
  });

  it('reports nothing under a pixel the service returns no feature for', async () => {
    fetchMock.mockResolvedValue(jsonAnswer({ type: 'FeatureCollection', features: [] }));

    await expect(fetchInvasiveObservation(VIEW)).resolves.toBeNull();
  });

  // GeoServer answers an exception report as HTTP 200 with an XML content-type where JSON was
  // asked. The content-type check must catch it before the JSON parse would, so `json` here is
  // never called; if it were, it would throw a raw SyntaxError instead of this message.
  it('fails loudly when the service answers an exception report', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/vnd.ogc.se_xml' }),
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    await expect(fetchInvasiveObservation(VIEW)).rejects.toThrow('Observation lookup failed');
  });

  it('fails loudly on a refused read', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 } as Response);

    await expect(fetchInvasiveObservation(VIEW)).rejects.toThrow('502');
  });
});

describe('invasive counts', () => {
  it('reads the match count out of the hits envelope', () => {
    expect(parseHits(hitsXml(479))).toBe(479);
  });

  it('reports no count when the envelope carries none', () => {
    expect(parseHits('<ServiceExceptionReport/>')).toBeNull();
  });

  it('counts the present and the absent apart', async () => {
    hitsAnswering(479, 218);

    await expect(fetchInvasiveMatches('baby')).resolves.toEqual({ present: 479, absent: 218 });
  });

  it('counts nothing until a species is typed', async () => {
    await expect(fetchInvasiveMatches('  ')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a count that lands after a newer species was typed', async () => {
    const applied: (InvasiveMatches | null)[] = [];
    const counter = createInvasiveCounter((matches) => applied.push(matches));

    const pending: ((answer: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const stale = counter.count('baby');

    hitsAnswering(3, 1);
    await counter.count('knapweed');

    pending[0](textAnswer(hitsXml(697)));
    pending[1](textAnswer(hitsXml(697)));
    await stale;

    expect(applied).toEqual([{ present: 3, absent: 1 }]);
  });

  it('drops the count when the species is cleared', async () => {
    const applied: (InvasiveMatches | null)[] = [];
    const counter = createInvasiveCounter((matches) => applied.push(matches));

    await counter.count('');

    expect(applied).toEqual([null]);
  });

  it('reports no count when the service fails', async () => {
    const applied: (InvasiveMatches | null)[] = [];
    const counter = createInvasiveCounter((matches) => applied.push(matches));
    fetchMock.mockRejectedValue(new Error('network down'));

    await counter.count('baby');

    expect(applied).toEqual([null]);
  });
});

describe('wildfires', () => {
  it('reads the fires the service answers with', async () => {
    fetchMock.mockResolvedValue(
      jsonAnswer({ type: 'FeatureCollection', features: [{ properties: {} }] }),
    );

    await expect(fetchWildfires()).resolves.toMatchObject({ features: [{ properties: {} }] });
  });

  it('answers an empty collection when the body carries no features', async () => {
    fetchMock.mockResolvedValue(jsonAnswer({ error: 'service unavailable' }));

    await expect(fetchWildfires()).resolves.toEqual({ type: 'FeatureCollection', features: [] });
  });

  // DataBC's gateway answers CORS only when a Referer header goes out; no-referrer breaks it.
  it('sends no referrerPolicy, so the browser default carries the Referer', async () => {
    fetchMock.mockResolvedValue(jsonAnswer({ type: 'FeatureCollection', features: [] }));

    await fetchWildfires();

    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('referrerPolicy');
  });

  it('names the incident and the fire number together', () => {
    const card = wildfireCard({ FIRE_NUMBER: 'V71234', INCIDENT_NAME: 'Cameron Bluffs' });

    expect(card.title).toBe('Cameron Bluffs (V71234)');
  });

  it('names the fire centre the number stands for', () => {
    expect(wildfireCard({ FIRE_CENTRE: 3 }).fireCentre).toBe('Coastal Fire Centre');
  });

  it('draws an extinguished fire grey, not as danger', () => {
    expect(wildfireCard({ FIRE_STATUS: 'Out' }).colour).toBe('#6c757d');
  });

  it('draws a fire of note largest', () => {
    expect(wildfireCard({ FIRE_OF_NOTE_IND: 'Y' }).sizePx).toBe(30);
  });

  it('says the size in hectares when the service reports one', () => {
    expect(wildfireCard({ CURRENT_SIZE: 1240.5 }).area).toBe('1240.5 ha');
  });

  it('says the size is unknown rather than showing a bare unit', () => {
    expect(wildfireCard({}).area).toBe('Unknown');
  });
});
