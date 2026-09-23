import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Project } from '../api/types';
import {
  boundarySection,
  fieldRows,
  fuzzyMatch,
  matchesBoundary,
  matchesRegion,
  searchProjects,
  useMapExplorerState,
} from './map-state';

function project(over: Partial<Project> & { id: string | number }): Project {
  return {
    name: `Project ${over.id}`,
    gatingState: 'admitted',
    sector: 'Mines',
    status: 'Active',
    region: 'Skeena',
    proponent: 'Acme',
    centroid: [-124, 50],
    ...over,
  } as Project;
}

describe('fuzzyMatch', () => {
  it('matches a substring anywhere in the text', () => {
    expect(fuzzyMatch('Copper Ridge Mine', 'per rid')).toBe(true);
  });

  it('matches a word by its prefix', () => {
    expect(fuzzyMatch('Copper Ridge Mine', 'ridg')).toBe(true);
  });

  it('forgives one typo in a short token and two in a long one', () => {
    expect(fuzzyMatch('Copper Ridge Mine', 'rodge')).toBe(true);
    expect(fuzzyMatch('Copper Ridge Mine', 'coppar')).toBe(true);
    // Three edits from "copper", past the budget for a token of this length.
    expect(fuzzyMatch('Copper Ridge Mine', 'cxppxx')).toBe(false);
  });

  it('needs every token to land, not just one', () => {
    expect(fuzzyMatch('Copper Ridge Mine', 'ridge quarry')).toBe(false);
  });

  it('refuses a query of nothing but short tokens that is not a substring', () => {
    expect(fuzzyMatch('Copper Ridge Mine', 'zz')).toBe(false);
  });
});

describe('searchProjects', () => {
  const MINE = project({ id: 1, name: 'Copper Ridge', sector: 'Mines' });
  const WIND = project({ id: 2, name: 'Alder Wind', sector: 'Energy', region: 'Peace' });

  it('keeps every row when nothing was typed', () => {
    expect(searchProjects([MINE, WIND], '   ')).toEqual([MINE, WIND]);
  });

  it('narrows the server answer to the rows a reader would call a match', () => {
    expect(searchProjects([MINE, WIND], 'coppar')).toEqual([MINE]);
  });

  it('searches the proponent and the Track description, not only the name', () => {
    const rows = [
      project({ id: 3, name: 'North Line', proponent: 'Pacific Hydro' }),
      project({
        id: 4,
        name: 'South Line',
        rawMetadata: { trackAttributes: { description: 'a run-of-river hydro proposal' } },
      }),
      WIND,
    ];
    expect(searchProjects(rows, 'hydro').map((p) => p.id)).toEqual([3, 4]);
  });
});

describe('fieldRows', () => {
  const FULL = project({
    id: 'demi-1',
    legacyEagleId: 'eagle-1',
    eaCertificate: 'E98-05',
    region: 'Skeena',
    rawMetadata: {
      trackAttributes: { project_state_name: 'Active', lead_agency: 'EAO' },
      eagleAttributes: { responsibleEPD: 'A. Director' },
    },
  });

  it('humanises the metadata keys and tags each row with its source', () => {
    const rows = fieldRows(FULL, 'all');
    expect(rows).toContainEqual({
      key: 'Project state name',
      value: 'Active',
      source: 'TRACK',
      long: false,
    });
    expect(rows).toContainEqual({
      key: 'Responsible epd',
      value: 'A. Director',
      source: 'EPIC',
      long: false,
    });
    expect(rows.find((row) => row.key === 'DEMI id')).toMatchObject({ source: 'DEMI', value: 'demi-1' });
  });

  it('carries the certificate and the legacy id, which sit outside the metadata objects', () => {
    const keys = fieldRows(FULL, 'all').map((row) => row.key);
    expect(keys).toContain('EA Certificate');
    expect(keys).toContain('Legacy Eagle id');
  });

  it('drops empty values rather than showing a blank row', () => {
    const rows = fieldRows(project({ id: 5, region: '' }), 'all');
    expect(rows.map((row) => row.key)).not.toContain('Region');
  });

  it('marks a value past 40 characters as long, so the card stacks it', () => {
    const long = 'x'.repeat(41);
    const rows = fieldRows(project({ id: 6, rawMetadata: { trackAttributes: { note: long } } }), 'all');
    expect(rows.find((row) => row.key === 'Note')?.long).toBe(true);
    expect(rows.find((row) => row.key === 'Gating state')?.long).toBe(false);
  });

  it('shows one source at a time when a tab is picked', () => {
    const sources = new Set(fieldRows(FULL, 'track').map((row) => row.source));
    expect([...sources]).toEqual(['TRACK']);
    expect(fieldRows(FULL, 'demi').every((row) => row.source === 'DEMI')).toBe(true);
  });

  it('is empty with nothing selected', () => {
    expect(fieldRows(null, 'all')).toEqual([]);
  });

  // Midday UTC, so the calendar date is the same in UTC and in Pacific time.
  const AS_OF = '2026-03-04T20:00:00.000Z';

  it('carries the wildfire summary, dated in the reader’s own time zone', () => {
    const rows = fieldRows(
      project({
        id: 7,
        sources: {
          wildfire: {
            activeCountWithin50km: 2,
            firesOfNoteNearby: 1,
            nearestDistanceKm: 12.5,
            lastCalculatedAt: AS_OF,
          },
        },
      }),
      'demi',
    );
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey['Nearby fires (50 km)']).toBe(
      `2 active fires, as of ${new Date(AS_OF).toLocaleDateString()}`,
    );
    expect(byKey['Fires of note']).toBe('Fires of Note Nearby');
    expect(byKey['Nearest fire']).toBe('12.5 km');
  });

  it('leaves out the date and the distance the wildfire read did not supply', () => {
    const rows = fieldRows(
      project({
        id: 8,
        sources: {
          wildfire: {
            activeCountWithin50km: 0,
            firesOfNoteNearby: 0,
            nearestDistanceKm: null,
            lastCalculatedAt: '',
          },
        },
      }),
      'demi',
    );
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey['Nearby fires (50 km)']).toBe('0 active fires');
    expect(byKey['Fires of note']).toBe('None nearby');
    expect(rows.map((row) => row.key)).not.toContain('Nearest fire');
  });
});

/** A square from (-125, 49) to (-123, 51). */
const SQUARE = {
  type: 'Polygon',
  coordinates: [[[-125, 49], [-123, 49], [-123, 51], [-125, 51], [-125, 49]]],
};

describe('matchesRegion', () => {
  const ROWS = [{ name: 'Skeena', geometry: SQUARE }];

  it('keeps a project whose own field names a picked region', () => {
    expect(matchesRegion(project({ id: 1, region: 'Skeena Region' }), ['Skeena'], ROWS)).toBe(true);
  });

  it('drops a project whose field names a different region', () => {
    expect(matchesRegion(project({ id: 2, region: 'Kootenay' }), ['Skeena'], ROWS)).toBe(false);
  });

  it('falls back to the centroid for a project that was never tagged', () => {
    const inside = project({ id: 3, region: '', centroid: [-124, 50] });
    const outside = project({ id: 4, region: '', centroid: [-119, 55] });
    expect(matchesRegion(inside, ['Skeena'], ROWS)).toBe(true);
    expect(matchesRegion(outside, ['Skeena'], ROWS)).toBe(false);
  });

  it('keeps an untagged project when the overlay has not supplied a polygon', () => {
    expect(matchesRegion(project({ id: 5, region: '', centroid: [-119, 55] }), ['Skeena'])).toBe(
      true,
    );
  });

  it('keeps every project when no region is picked', () => {
    expect(matchesRegion(project({ id: 6, region: 'Kootenay' }), [], ROWS)).toBe(true);
  });
});

describe('matchesBoundary', () => {
  const ROWS = [{ name: 'Bulkley-Nechako', geometry: SQUARE }];

  it('keeps a project whose own field names a picked boundary', () => {
    const row = project({ id: 1, regionalDistrict: 'Bulkley-Nechako Regional District' });
    expect(matchesBoundary(row, 'regionalDistricts', ['Bulkley-Nechako'], ROWS)).toBe(true);
  });

  it('drops a project whose field names a different one', () => {
    const row = project({ id: 2, regionalDistrict: 'Capital' });
    expect(matchesBoundary(row, 'regionalDistricts', ['Bulkley-Nechako'], ROWS)).toBe(false);
  });

  it('falls back to the centroid for a project that was never tagged', () => {
    const inside = project({ id: 3, centroid: [-124, 50] });
    const outside = project({ id: 4, centroid: [-119, 55] });
    expect(matchesBoundary(inside, 'regionalDistricts', ['Bulkley-Nechako'], ROWS)).toBe(true);
    expect(matchesBoundary(outside, 'regionalDistricts', ['Bulkley-Nechako'], ROWS)).toBe(false);
  });

  it('keeps an untagged project when there is no polygon to test it against', () => {
    const row = project({ id: 5, centroid: [-119, 55] });
    expect(matchesBoundary(row, 'regionalDistricts', ['Bulkley-Nechako'], [])).toBe(true);
  });
});

describe('boundarySection', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ name: `District ${index + 10}` }));
  const filters = {
    gating: [],
    sector: [],
    region: [],
    regionalDistricts: ['District 12'],
    municipalities: [],
    electoralDistricts: [],
  };

  it('offers fifty rows at a time, sorted, and marks what is picked', () => {
    const section = boundarySection('regionalDistricts', rows, '', filters);
    expect(section.label).toBe('Regional district');
    expect(section.options).toHaveLength(50);
    expect(section.options[0].value).toBe('District 10');
    expect(section.options.find((option) => option.value === 'District 12')?.checked).toBe(true);
  });

  it('narrows to what the section search box says', () => {
    const section = boundarySection('regionalDistricts', rows, 'rict 5', filters);
    expect(section.options.map((option) => option.value)).toEqual([
      'District 50', 'District 51', 'District 52', 'District 53', 'District 54',
      'District 55', 'District 56', 'District 57', 'District 58', 'District 59',
    ]);
  });
});

describe('useMapExplorerState layers', () => {
  it('keeps both overlays when a boundary pick and a layer toggle land in one batch', () => {
    const { result } = renderHook(() => useMapExplorerState(10));

    act(() => {
      result.current.toggleValue('regionalDistricts', 'Capital');
      result.current.toggleLayer('municipalities');
    });

    expect(result.current.activeLayers).toEqual(['regions', 'regionalDistricts', 'municipalities']);
    expect(result.current.filters.regionalDistricts).toEqual(['Capital']);
  });

  it('drops only the picks of the overlay turned off', () => {
    const { result } = renderHook(() => useMapExplorerState(10));
    act(() => {
      result.current.toggleValue('regionalDistricts', 'Capital');
      result.current.toggleValue('municipalities', 'Victoria');
    });

    act(() => result.current.toggleLayer('regionalDistricts'));

    expect(result.current.activeLayers).toEqual(['regions', 'municipalities']);
    expect(result.current.filters.regionalDistricts).toEqual([]);
    expect(result.current.filters.municipalities).toEqual(['Victoria']);
  });
});
