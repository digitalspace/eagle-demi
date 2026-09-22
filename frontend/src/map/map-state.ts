import { useCallback, useMemo, useState } from 'react';
import type { Project } from '../api/types';
import type { BoundaryLayer, BoundaryRow } from '../api/boundaries';
import { containsPoint, type Geometry, type Position } from './geojson';

/**
 * Filter, sort and selection state for Map Explorer. Only this screen reads it, so it is a hook
 * over plain state rather than a shared store; the predicates below are exported separately so
 * they can be checked without rendering a map.
 */

export const BOUNDARY_LAYERS: BoundaryLayer[] = [
  'regionalDistricts',
  'municipalities',
  'electoralDistricts',
];

/** Boundary layer id -> the denormalised project field naming that boundary. */
export const BOUNDARY_FIELD: Record<BoundaryLayer, 'regionalDistrict' | 'municipality' | 'electoralDistrict'> = {
  regionalDistricts: 'regionalDistrict',
  municipalities: 'municipality',
  electoralDistricts: 'electoralDistrict',
};

export const BOUNDARY_SECTION_LABEL: Record<BoundaryLayer, string> = {
  regionalDistricts: 'Regional district',
  municipalities: 'Municipality',
  electoralDistricts: 'Electoral district',
};

export type FilterKey = 'gating' | 'sector' | 'region' | BoundaryLayer;

export type Filters = Record<FilterKey, string[]>;

export const EMPTY_FILTERS: Filters = {
  gating: [],
  sector: [],
  region: [],
  regionalDistricts: [],
  municipalities: [],
  electoralDistricts: [],
};

/** The polygons behind the ticked names, per layer. Only loaded layers appear. */
export type BoundaryGeometries = Partial<Record<BoundaryLayer | 'region', BoundaryRow[]>>;

/** One ring of [lng, lat] vertices drawn freehand, with the saved area's name when it has one. */
export interface Lasso {
  ring: number[][];
  /** null for an unnamed freehand draw. */
  label: string | null;
}

/** The chip id the lasso answers to; it is one shape, so it needs no value of its own. */
export const LASSO_CHIP_ID = 'lasso:area';
export const LASSO_FALLBACK_LABEL = 'Lasso area';

/** Under four points the shape has no interior, so a stray click clears rather than filters. */
export const LASSO_MIN_POINTS = 4;

export function lassoGeometry(ring: number[][]): Geometry {
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * Spread into every animated camera call. maplibre drops the animation under
 * `prefers-reduced-motion` unless the options say the move is essential, and these moves are short
 * and asked for by the reader, so they play.
 */
export const CAMERA_MOTION = { essential: true } as const;

/** Fast at the start, settling at the end, the way a map pan is expected to feel. */
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/** The three camera speeds, in milliseconds. Tune here; every call reads them. */
const PAN_MS = 800;
const FLY_MS = 1600;
const FIT_MS = 900;

/** Sliding to a pin the reader can already see. */
export const CAMERA_PAN = { duration: PAN_MS, easing: easeOut, ...CAMERA_MOTION } as const;

/** Coming in from the province-wide view: maplibre turns a flight longer than `maxDuration` into an instant jump, so a fixed duration is used instead. */
export const CAMERA_FLY = { duration: FLY_MS, ...CAMERA_MOTION } as const;

/** Framing a cluster, a boundary or a drawn area. */
export const CAMERA_FIT = { duration: FIT_MS, easing: easeOut, ...CAMERA_MOTION } as const;

export type SortBy = 'relevance' | 'name';

/** The nine EAO environmental regions, as the Angular screen listed them. */
export const AVAILABLE_REGIONS = [
  'Vancouver Island',
  'Lower Mainland',
  'Thompson',
  'Kootenay',
  'Cariboo',
  'Skeena',
  'Omineca',
  'Okanagan',
  'Peace',
];

export interface FilterOption {
  value: string;
  label: string;
  checked: boolean;
}

export interface FilterSection {
  id: FilterKey;
  label: string;
  searchable: boolean;
  searchValue: string;
  options: FilterOption[];
}

const gatingLabel = (value: string): string => (value === 'staged' ? 'Staged' : 'Admitted');

type GeoField = 'region' | 'regionalDistrict' | 'municipality' | 'electoralDistrict';

/**
 * Does the project fall inside any one name ticked in this section?
 *
 * The denormalised field on the project wins when the record carries one — it matches when either
 * name contains the other, so "Skeena Region" answers a picked "Skeena". Ray casting the centroid
 * is only the fallback for rows that were never tagged, and a row with neither a field nor a
 * loaded polygon to test against is kept.
 */
function matchesGeoSelection(
  project: Project,
  field: GeoField,
  picked: string[],
  rows: BoundaryRow[] | undefined,
): boolean {
  if (!picked.length) return true;

  const names = picked.map((name) => name.toLowerCase());
  const value = String(project[field] || '').toLowerCase();
  if (value) return names.some((name) => value.includes(name) || name.includes(value));

  const geometries = (rows || [])
    .filter((row) => names.includes((row.name || '').toLowerCase()))
    .map((row) => row.geometry ?? row.simplifiedGeometry)
    .filter((geometry): geometry is Geometry => !!geometry);
  if (!project.centroid || !geometries.length) return true;

  const point: Position = [Number(project.centroid[0]), Number(project.centroid[1])];
  return geometries.some((geometry) => containsPoint(geometry, point));
}

export function matchesRegion(
  project: Project,
  picked: string[],
  rows?: BoundaryRow[],
): boolean {
  return matchesGeoSelection(project, 'region', picked, rows);
}

export function matchesBoundary(
  project: Project,
  layer: BoundaryLayer,
  picked: string[],
  rows: BoundaryRow[] | undefined,
): boolean {
  return matchesGeoSelection(project, BOUNDARY_FIELD[layer], picked, rows);
}

/**
 * A drawn area keeps only what it encloses. A project with no centroid has nothing to test, so it
 * drops out — the drawn shape is an explicit "these ones", not a filter something can slip past.
 */
export function matchesLasso(project: Project, lasso: Lasso | null): boolean {
  if (!lasso) return true;
  if (!project.centroid) return false;
  const point: Position = [Number(project.centroid[0]), Number(project.centroid[1])];
  return containsPoint(lassoGeometry(lasso.ring), point);
}

/**
 * Does one project survive the active filters?
 *
 * `skipSector` lets the sector counts answer "how many rows would this chip give me", which is a
 * question about every filter except sector. Counts and the chip that applies them must come from
 * one predicate, or a chip promises rows that clicking it cannot deliver.
 */
function matchesProjectFilters(
  project: Project,
  filters: Filters,
  skipSector = false,
  geometries: BoundaryGeometries = {},
  lasso: Lasso | null = null,
): boolean {
  if (!matchesLasso(project, lasso)) return false;
  if (filters.gating.length && !filters.gating.includes(project.gatingState || '')) return false;
  // Exact match on the trimmed value: the chips are built from these values, and substring
  // matching merged distinct sectors such as "Coal Mines" and "Power Plants".
  if (!skipSector && filters.sector.length && !filters.sector.includes((project.sector || '').trim())) {
    return false;
  }
  if (!matchesRegion(project, filters.region, geometries.region)) return false;
  // OR within a boundary section, AND across them.
  return BOUNDARY_LAYERS.every((layer) =>
    matchesBoundary(project, layer, filters[layer], geometries[layer]),
  );
}

export function filterProjects(
  projects: Project[],
  filters: Filters,
  geometries: BoundaryGeometries = {},
  lasso: Lasso | null = null,
): Project[] {
  return projects.filter((project) =>
    matchesProjectFilters(project, filters, false, geometries, lasso),
  );
}

/**
 * Sectors present in the corpus with the count each chip would return, commonest first.
 *
 * Takes the boundary polygons and the drawn area the rail is filtered by: counting without them
 * offers a chip that the same predicate then rejects, and suggests sectors nothing is left in.
 */
export function sectorOptions(
  projects: Project[],
  filters: Filters,
  geometries: BoundaryGeometries = {},
  lasso: Lasso | null = null,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const project of projects) {
    if (!matchesProjectFilters(project, filters, true, geometries, lasso)) continue;
    const value = (project.sector || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  // A picked sector keeps its chip at zero: without it the chip vanishes, leaving an empty map
  // with nothing to click to get back.
  for (const picked of filters.sector) if (!counts.has(picked)) counts.set(picked, 0);

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function buildSections(
  projects: Project[],
  filters: Filters,
  sectorQuery: string,
  geometries: BoundaryGeometries = {},
  lasso: Lasso | null = null,
): FilterSection[] {
  const needle = sectorQuery.toLowerCase().trim();
  return [
    {
      id: 'gating',
      label: 'Gating state',
      searchable: false,
      searchValue: '',
      options: ['admitted', 'staged'].map((value) => ({
        value,
        label: gatingLabel(value),
        checked: filters.gating.includes(value),
      })),
    },
    {
      id: 'sector',
      label: 'Sector',
      searchable: true,
      searchValue: sectorQuery,
      options: sectorOptions(projects, filters, geometries, lasso)
        .filter((option) => !needle || option.value.toLowerCase().includes(needle))
        .map((option) => ({
          value: option.value,
          label: `${option.value} (${option.count})`,
          checked: filters.sector.includes(option.value),
        })),
    },
    {
      id: 'region',
      label: 'Environmental region',
      searchable: false,
      searchValue: '',
      options: AVAILABLE_REGIONS.map((name) => ({
        value: name,
        label: name,
        checked: filters.region.includes(name),
      })),
    },
  ];
}

/** ponytail: 50-row cap, the section's own search box is the way past it; virtualise if lists grow. */
export const BOUNDARY_OPTION_CAP = 50;

/** Boundary names, sorted, narrowed by the section's search box. */
export function boundaryNames(rows: BoundaryRow[] | undefined, query: string): string[] {
  const needle = query.toLowerCase().trim();
  // A boundary read that answered with anything but a list still leaves a usable filter section.
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row.name || '')
    .filter((name) => name && (!needle || name.toLowerCase().includes(needle)))
    .sort((a, b) => a.localeCompare(b));
}

export function boundarySection(
  layer: BoundaryLayer,
  rows: BoundaryRow[] | undefined,
  query: string,
  filters: Filters,
): FilterSection {
  const picked = filters[layer];
  return {
    id: layer,
    label: BOUNDARY_SECTION_LABEL[layer],
    searchable: true,
    searchValue: query,
    options: boundaryNames(rows, query)
      .slice(0, BOUNDARY_OPTION_CAP)
      .map((name) => ({ value: name, label: name, checked: picked.includes(name) })),
  };
}

/** One chip per picked value. `id` is `section:value`, so a chip removes only itself. */
export function activeFilters(
  filters: Filters,
  lasso: Lasso | null = null,
): { id: string; label: string }[] {
  const rows: { id: string; label: string }[] = [];
  for (const value of filters.gating) rows.push({ id: `gating:${value}`, label: gatingLabel(value) });
  for (const value of filters.sector) rows.push({ id: `sector:${value}`, label: value });
  for (const value of filters.region) rows.push({ id: `region:${value}`, label: value });
  for (const layer of BOUNDARY_LAYERS) {
    for (const value of filters[layer]) rows.push({ id: `${layer}:${value}`, label: value });
  }
  if (lasso) rows.push({ id: LASSO_CHIP_ID, label: lasso.label ?? LASSO_FALLBACK_LABEL });
  return rows;
}

export function sortProjects(projects: Project[], sortBy: SortBy): Project[] {
  if (sortBy !== 'name') return projects;
  return [...projects].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** `…` while the first read is in flight: pairing null with a stale total flashes "0 of 1,204". */
export function resultCountLabel(shown: number | null | undefined, total: number | null): string {
  if (shown === null || shown === undefined) return '…';
  if (total === null || total <= shown) return String(shown);
  return `${shown} of ${total.toLocaleString()}`;
}

export function projectMeta(project: Project): string {
  return [project.sector, project.status, project.region].filter(Boolean).join(' · ');
}

export function pillClass(state: string | undefined): string {
  return state === 'staged' ? 'pill--warning' : 'pill--success';
}

/** Projects sharing one centroid, which clustering cannot separate once it is fully zoomed in. */
export function coLocated(projects: Project[], selected: Project | null): Project[] {
  if (!selected?.centroid) return [];
  const [lng, lat] = selected.centroid;
  return projects.filter(
    (project) =>
      project.id !== selected.id &&
      project.centroid?.[0] === lng &&
      project.centroid?.[1] === lat,
  );
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  if (b.length === 0) return a.length;

  const row = new Int32Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) row[i] = i;

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const value =
        a.charAt(i - 1) === b.charAt(j - 1)
          ? row[j - 1]
          : Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      row[j - 1] = prev;
      prev = value;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Substring first, then per-token prefix or near-spelling. Tokens of two characters or fewer are
 * dropped: at that length every word in the corpus is within one edit of every other.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (!text || !query) return false;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack.includes(needle)) return true;

  const tokens = needle.split(/\s+/).filter((token) => token.length > 2);
  if (tokens.length === 0) return false;

  const words = haystack.split(/[^a-z0-9]+/).filter((word) => word.length > 2);

  return tokens.every((token) =>
    words.some((word) => {
      if (word.startsWith(token)) return true;
      const maxDistance = token.length >= 5 ? 2 : 1;
      // Lengths further apart than the budget cannot close it, so skip the O(n·m) walk.
      if (Math.abs(word.length - token.length) > maxDistance) return false;
      return levenshtein(word, token) <= maxDistance;
    }),
  );
}

/** The one blob the client filter matches against, field order as the Angular screen had it. */
export function projectSearchText(project: Project): string {
  const trackDescription = project.rawMetadata?.trackAttributes?.['description'];
  return [
    project.name,
    project.sector,
    project.status,
    project.region,
    project.gatingState,
    project.description,
    typeof trackDescription === 'string' ? trackDescription : '',
    project.proponent,
  ]
    .map((value) => value || '')
    .join(' ');
}

/**
 * The client half of search. The API already answered the same words, but its index stems and
 * scores; this narrows what came back to rows a reader would accept as a match.
 */
export function searchProjects(projects: Project[], query: string): Project[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return projects;
  return projects.filter((project) => fuzzyMatch(projectSearchText(project), needle));
}

export type FieldSource = 'TRACK' | 'EPIC' | 'DEMI';

export interface FieldRow {
  key: string;
  value: string;
  source: FieldSource;
  long: boolean;
}

export type SourceTab = 'all' | 'track' | 'epic' | 'demi';

export const SOURCE_TABS: { id: SourceTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'track', label: 'Track' },
  { id: 'epic', label: 'EPIC' },
  { id: 'demi', label: 'DEMI' },
];

function humanise(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * `key: value` rows for the selected project, tagged with where the value came from.
 *
 * Built by walking the metadata objects rather than from a fixed field list: the Track payload is
 * a checked-in export whose columns move, and a hard-coded list drifts into showing blanks.
 */
export function fieldRows(project: Project | null, tab: SourceTab): FieldRow[] {
  if (!project) return [];

  const rows: FieldRow[] = [];
  const push = (source: FieldSource, key: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Past ~40 chars a right-aligned value wraps into a cramped column; the card stacks it instead.
    rows.push({ key, value: text, source, long: text.length > 40 });
  };

  for (const [key, value] of Object.entries(project.rawMetadata?.trackAttributes || {})) {
    push('TRACK', humanise(key), value);
  }
  // Track's own column, but it arrives on the mapped project rather than in `trackAttributes`.
  push('TRACK', 'EA Certificate', project.eaCertificate);
  for (const [key, value] of Object.entries(project.rawMetadata?.eagleAttributes || {})) {
    push('EPIC', humanise(key), value);
  }
  push('EPIC', 'Legacy Eagle id', project.legacyEagleId);

  push('DEMI', 'DEMI id', project.id);
  push('DEMI', 'Gating state', project.gatingState);
  push('DEMI', 'Region', project.region);
  push('DEMI', 'Regional district', project.regionalDistrict);
  push('DEMI', 'Municipality', project.municipality);
  push('DEMI', 'Electoral district', project.electoralDistrict);
  if (project.centroid) {
    push('DEMI', 'Centroid (lon, lat)', `${project.centroid[0]}, ${project.centroid[1]}`);
  }

  const wildfire = project.sources?.wildfire;
  if (wildfire) {
    const asOf = wildfire.lastCalculatedAt
      ? new Date(wildfire.lastCalculatedAt).toLocaleDateString()
      : '';
    push(
      'DEMI',
      'Nearby fires (50 km)',
      `${wildfire.activeCountWithin50km} active fires${asOf ? `, as of ${asOf}` : ''}`,
    );
    push('DEMI', 'Fires of note', wildfire.firesOfNoteNearby > 0 ? 'Fires of Note Nearby' : 'None nearby');
    if (wildfire.nearestDistanceKm != null) {
      push('DEMI', 'Nearest fire', `${wildfire.nearestDistanceKm} km`);
    }
  }

  if (tab === 'all') return rows;
  const wanted: FieldSource = tab === 'track' ? 'TRACK' : tab === 'epic' ? 'EPIC' : 'DEMI';
  return rows.filter((row) => row.source === wanted);
}

/** Overlays drawn on the map. Environmental regions are on when the screen opens, as in Angular. */
const DEFAULT_ACTIVE_LAYERS = ['regions'];

export function useMapExplorerState(perPage: number) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  /** One search box per searchable section, keyed by section id. */
  const [sectionQueries, setSectionQueries] = useState<Record<string, string>>({});
  const [activeLayers, setActiveLayers] = useState<string[]>(DEFAULT_ACTIVE_LAYERS);
  const [sortBy, setSortBy] = useState<SortBy>('relevance');
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [visibleCount, setVisibleCount] = useState(perPage);
  const [lasso, setLasso] = useState<Lasso | null>(null);

  const setSectionQuery = useCallback((section: string, value: string) => {
    setSectionQueries((current) => ({ ...current, [section]: value }));
  }, []);

  const toggleValue = useCallback((section: FilterKey, value: string) => {
    setFilters((current) => {
      const picked = current[section];
      const next = picked.includes(value)
        ? picked.filter((entry) => entry !== value)
        : [...picked, value];
      return { ...current, [section]: next };
    });
    // Ticking a boundary whose overlay is off would filter the results against something the map is
    // not drawing, so the overlay goes on with it.
    if ((BOUNDARY_LAYERS as string[]).includes(section)) {
      setActiveLayers((current) => (current.includes(section) ? current : [...current, section]));
    }
    setVisibleCount(perPage);
  }, [perPage]);

  const toggleLayer = useCallback((layer: string) => {
    setActiveLayers((current) =>
      current.includes(layer) ? current.filter((entry) => entry !== layer) : [...current, layer],
    );
  }, []);

  // Turning an overlay off drops that layer's picks; the other layers keep filtering. Done in
  // render, not an effect, so no frame filters by an overlay the map has stopped drawing.
  const [prunedFor, setPrunedFor] = useState(activeLayers);
  if (prunedFor !== activeLayers) {
    setPrunedFor(activeLayers);
    const off = BOUNDARY_LAYERS.filter(
      (layer) => filters[layer].length && !activeLayers.includes(layer),
    );
    if (off.length) setFilters({ ...filters, ...Object.fromEntries(off.map((layer) => [layer, []])) });
  }

  const clearFilter = useCallback((id: string) => {
    if (id === LASSO_CHIP_ID) {
      setLasso(null);
      setVisibleCount(perPage);
      return;
    }
    const split = id.indexOf(':');
    toggleValue(id.slice(0, split) as FilterKey, id.slice(split + 1));
  }, [toggleValue, perPage]);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setLasso(null);
    setVisibleCount(perPage);
  }, [perPage]);

  const chips = useMemo(() => activeFilters(filters, lasso), [filters, lasso]);

  return {
    filters,
    chips,
    sectionQueries,
    setSectionQuery,
    activeLayers,
    toggleLayer,
    sortBy,
    setSortBy,
    selectedId,
    setSelectedId,
    visibleCount,
    setVisibleCount,
    lasso,
    setLasso,
    toggleValue,
    clearFilter,
    clearFilters,
  };
}
