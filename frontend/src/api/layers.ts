import { useQuery } from '@tanstack/react-query';
import { project } from '../map/mercator';
import { EMPTY_COLLECTION, type FeatureCollection } from '../map/geojson';

/**
 * Third-party map overlays: active wildfires, environmental regions, invasive plant observations.
 *
 * Every read here is a plain `fetch`. None of these hosts is ours, so none of them may be handed
 * the session bearer token that `api()` attaches. Everything a popup or card shows comes back as
 * plain data: values from these services are never assembled into markup.
 */

const DATABC_OWS_URL = 'https://openmaps.gov.bc.ca/geo/pub/ows';
const INVASIVES_WMS_URL =
  'https://openmaps.gov.bc.ca/geo/pub/WHSE_FOREST_VEGETATION.IBC_INVASIVE_SPECIES_OBS_SP/ows';
const INVASIVES_LAYER = 'pub:WHSE_FOREST_VEGETATION.IBC_INVASIVE_SPECIES_OBS_SP';
const WILDFIRE_LAYER = 'pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP';

export const OGL_BC_ATTRIBUTION =
  'Contains information licensed under the Open Government Licence – British Columbia.';

export const REGIONAL_BOUNDARIES_ASSET = '/env_regional_boundaries_reprojected.geojson';

/* -------------------------------------------------------------------------- wildfires */

const FIRE_CENTRES: Record<string, string> = {
  1: 'Cariboo Fire Centre',
  2: 'Kamloops Fire Centre',
  3: 'Coastal Fire Centre',
  4: 'Prince George Fire Centre',
  5: 'Northwest Fire Centre',
  6: 'Southeast Fire Centre',
};

const FIRE_STATUS_COLOUR: Record<string, string> = {
  Out: '#6c757d',
  'Under Control': '#2b9348',
  'Being Held': '#e85d04',
};

/** Out of control, and a fire of note, both read as danger. */
const FIRE_DANGER_COLOUR = '#d90429';

export interface WildfireCard {
  title: string;
  status: string;
  colour: string;
  /** Marker diameter in CSS pixels: a fire of note draws largest, an extinguished fire smallest. */
  sizePx: number;
  fireOfNote: boolean;
  cause: string;
  area: string;
  fireCentre: string;
  location: string;
  ignited: string;
  url: string;
}

type Props = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? '' : String(value));

export function wildfiresUrl(): string {
  return (
    `${DATABC_OWS_URL}?service=WFS&version=1.0.0&request=GetFeature` +
    `&typeName=${WILDFIRE_LAYER}&outputFormat=application/json&srsName=EPSG:4326`
  );
}

/** DataBC's current fires. Fetched afresh every time the overlay goes on: the set changes hourly. */
export async function fetchWildfires(signal?: AbortSignal): Promise<FeatureCollection> {
  // DataBC's gateway only answers CORS when a Referer header is present, so the default
  // referrer policy (strict-origin-when-cross-origin) has to stay; no-referrer breaks it.
  const res = await fetch(wildfiresUrl(), { signal });
  if (!res.ok) throw new Error(`Wildfire layer unavailable (HTTP ${res.status})`);
  const data: unknown = await res.json();
  const features = (data as FeatureCollection | null)?.features;
  return Array.isArray(features) ? { type: 'FeatureCollection', features } : EMPTY_COLLECTION;
}

/** What a wildfire popup shows, as data. */
export function wildfireCard(props: Props): WildfireCard {
  const status = text(props['FIRE_STATUS']) || 'Active';
  const fireOfNote = props['FIRE_OF_NOTE_IND'] === 'Y' || status === 'Fire of Note';
  const fireNumber = text(props['FIRE_NUMBER']) || 'Wildfire';
  const incident = text(props['INCIDENT_NAME']);
  const centre = text(props['FIRE_CENTRE']);

  return {
    title: incident && incident !== fireNumber ? `${incident} (${fireNumber})` : fireNumber,
    status,
    colour: FIRE_STATUS_COLOUR[status] ?? FIRE_DANGER_COLOUR,
    sizePx: fireOfNote ? 30 : status === 'Out' ? 20 : 26,
    fireOfNote,
    cause: text(props['FIRE_CAUSE']) || 'Unknown',
    area: props['CURRENT_SIZE'] != null ? `${text(props['CURRENT_SIZE'])} ha` : 'Unknown',
    fireCentre: FIRE_CENTRES[centre] ?? `Fire Centre #${centre || 'Unknown'}`,
    location: text(props['GEOGRAPHIC_DESCRIPTION']).trim(),
    ignited: text(props['IGNITION_DATE']).replace('Z', ''),
    url: text(props['FIRE_URL']),
  };
}

/**
 * Where to draw a fire. Some rows carry a point outside the world, so the LATITUDE and LONGITUDE
 * columns are the fallback; a row with neither is not drawn.
 */
export function wildfireCoordinates(
  geometry: { coordinates?: unknown } | null,
  props: Props,
): [number, number] | null {
  const point = geometry?.coordinates;
  if (Array.isArray(point) && point.length >= 2) {
    const [lng, lat] = point as number[];
    if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return [lng, lat];
    }
  }
  const lat = Number(props['LATITUDE']);
  const lng = Number(props['LONGITUDE']);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? [lng, lat] : null;
}

/* ---------------------------------------------------------------- environmental regions */

/** The build-time regions asset, served from this app's own origin. */
export async function fetchRegionalBoundaries(signal?: AbortSignal): Promise<FeatureCollection> {
  const res = await fetch(REGIONAL_BOUNDARIES_ASSET, { signal });
  if (!res.ok) throw new Error(`Regional boundaries unavailable (HTTP ${res.status})`);
  return (await res.json()) as FeatureCollection;
}

/* ------------------------------------------------------------------- invasive species */

const INVASIVES_RED = '#ce3e39';
const INVASIVES_GREEN = '#42814a';

/**
 * DataBC's published styles stop drawing below roughly a 5 km wide view, and GetFeatureInfo answers
 * from whatever style is in force, so a click would find nothing where the map shows nothing. This
 * inline style draws at every zoom.
 *
 * One row in five is a survey that confirmed the plant absent, so those draw in the success green
 * rather than the danger red an infestation earns. Absences are also dashed, and their points
 * hollow, so the two kinds stay apart without colour (WCAG 1.4.1).
 */
export const INVASIVES_SLD =
  '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">' +
  `<NamedLayer><Name>${INVASIVES_LAYER}</Name><UserStyle><FeatureTypeStyle>` +
  '<Rule><ogc:Filter><ogc:Not><ogc:PropertyIsNull>' +
  '<ogc:PropertyName>INVASIVE_PLANT_POSITIVE</ogc:PropertyName>' +
  '</ogc:PropertyIsNull></ogc:Not></ogc:Filter>' +
  `<PolygonSymbolizer><Fill><CssParameter name="fill">${INVASIVES_RED}</CssParameter>` +
  '<CssParameter name="fill-opacity">0.6</CssParameter></Fill>' +
  `<Stroke><CssParameter name="stroke">${INVASIVES_RED}</CssParameter></Stroke></PolygonSymbolizer>` +
  '<PointSymbolizer><Graphic><Mark><WellKnownName>circle</WellKnownName>' +
  `<Fill><CssParameter name="fill">${INVASIVES_RED}</CssParameter></Fill></Mark><Size>6</Size></Graphic></PointSymbolizer></Rule>` +
  '<Rule><ElseFilter/>' +
  `<PolygonSymbolizer><Fill><CssParameter name="fill">${INVASIVES_GREEN}</CssParameter>` +
  '<CssParameter name="fill-opacity">0.45</CssParameter></Fill>' +
  `<Stroke><CssParameter name="stroke">${INVASIVES_GREEN}</CssParameter>` +
  '<CssParameter name="stroke-width">1.5</CssParameter>' +
  '<CssParameter name="stroke-dasharray">4 2</CssParameter></Stroke></PolygonSymbolizer>' +
  '<PointSymbolizer><Graphic><Mark><WellKnownName>circle</WellKnownName>' +
  `<Stroke><CssParameter name="stroke">${INVASIVES_GREEN}</CssParameter>` +
  '<CssParameter name="stroke-width">1.5</CssParameter></Stroke></Mark><Size>6</Size></Graphic></PointSymbolizer></Rule>' +
  '</FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>';

/** The style's two rules, as CQL, so the count can be split the same way the map is. */
const PRESENT_CQL = 'INVASIVE_PLANT_POSITIVE IS NOT NULL';
const ABSENT_CQL = 'INVASIVE_PLANT_POSITIVE IS NULL';

/** Long enough that a typed species name is one request, short enough to feel immediate. */
export const INVASIVES_FILTER_DEBOUNCE_MS = 400;

/** The tiles sit over the basemap but under the project markers. */
export const INVASIVES_RASTER_OPACITY = 0.7;

/**
 * A CQL string literal: quotes double, and % and _ are wildcards unless escaped. The backslash is
 * escaped first, or a typed one would turn the wildcard escape that follows it back into a wildcard.
 */
export function invasivesCql(species: string): string {
  const term = species.trim();
  if (!term) return '';
  const literal = term.replace(/'/g, "''").replace(/[\\%_]/g, (match) => `\\${match}`);
  return `INVASIVE_PLANT ILIKE '%${literal}%'`;
}

/**
 * A WMS tile template for a MapLibre raster source.
 *
 * WMS 1.1.1 with `SRS`, not 1.3.0 with `CRS`: 1.3.0 leaves the BBOX axis order to the CRS
 * definition, and MapLibre substitutes `{bbox-epsg-3857}` in west,south,east,north order.
 */
export function invasivesTileUrl(species = ''): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: INVASIVES_LAYER,
    STYLES: '',
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    SRS: 'EPSG:3857',
    WIDTH: '256',
    HEIGHT: '256',
    SLD_BODY: INVASIVES_SLD,
  });
  const cql = invasivesCql(species);
  if (cql) params.set('CQL_FILTER', cql);
  // MapLibre substitutes the token itself, so it has to reach the template unescaped.
  return `${INVASIVES_WMS_URL}?${params}&BBOX={bbox-epsg-3857}`;
}

export interface RasterSource {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  attribution: string;
}

export function invasivesRasterSource(species = ''): RasterSource {
  return {
    type: 'raster',
    tiles: [invasivesTileUrl(species)],
    tileSize: 256,
    attribution: OGL_BC_ATTRIBUTION,
  };
}

/** The viewport a GetFeatureInfo question is asked about. */
export interface MapView {
  bounds: { west: number; south: number; east: number; north: number };
  size: { width: number; height: number };
  /** The clicked point, in pixels from the top left of the map container. */
  pixel: { x: number; y: number };
}

/** Ask the WMS what sits under one pixel, styled and filtered the same way the tiles are. */
export function featureInfoUrl(view: MapView, species = ''): string {
  const sw = project(view.bounds.west, view.bounds.south);
  const ne = project(view.bounds.east, view.bounds.north);

  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo',
    LAYERS: INVASIVES_LAYER,
    QUERY_LAYERS: INVASIVES_LAYER,
    CRS: 'EPSG:3857',
    // The server rejects a box whose corners are the wrong way round: minx,miny,maxx,maxy.
    BBOX: `${sw.x},${sw.y},${ne.x},${ne.y}`,
    WIDTH: String(Math.round(view.size.width)),
    HEIGHT: String(Math.round(view.size.height)),
    I: String(Math.round(view.pixel.x)),
    J: String(Math.round(view.pixel.y)),
    INFO_FORMAT: 'application/json',
    FEATURE_COUNT: '1',
    SLD_BODY: INVASIVES_SLD,
  });
  const cql = invasivesCql(species);
  if (cql) params.set('CQL_FILTER', cql);
  return `${INVASIVES_WMS_URL}?${params}`;
}

/** What an observation popup shows, as data. Null means the pixel carries no observation. */
export interface InvasiveObservation {
  name: string;
  scientific: string | null;
  observed: string | null;
  presence: 'Present' | 'Not present' | null;
}

export function parseInvasiveObservation(props: Props | null): InvasiveObservation | null {
  if (!props) return null;

  const name = text(
    props['INVASIVE_PLANT'] || props['INVASIVE_PLANT_POSITIVE'] || props['INVASIVE_PLANT_NEGATIVE'],
  );
  if (!name) return null;

  // DataBC packs both names into one string: "Japanese knotweed (Reynoutria / Fallopia japonica)".
  const split = /^(.*?)\s*\((.*)\)\s*$/.exec(name);
  const observed = text(props['ACTIVITY_DATE']).replace('Z', '');

  return {
    name: split ? split[1] : name,
    scientific: split ? split[2] : null,
    observed: observed || null,
    presence: props['INVASIVE_PLANT_POSITIVE']
      ? 'Present'
      : props['INVASIVE_PLANT_NEGATIVE']
        ? 'Not present'
        : null,
  };
}

/**
 * The observation under the clicked pixel.
 *
 * Rejects on a failed read: GeoServer answers an error with an XML exception report, which must not
 * be mistaken for bare ground. The caller says the read failed rather than leaving the click
 * looking ignored.
 */
export async function fetchInvasiveObservation(
  view: MapView,
  species = '',
  signal?: AbortSignal,
): Promise<InvasiveObservation | null> {
  const res = await fetch(featureInfoUrl(view, species), { signal });
  if (!res.ok) throw new Error(`Observation lookup failed (HTTP ${res.status})`);
  // A WMS exception answers HTTP 200 with an XML content-type where JSON was asked; treat it as
  // a failed read rather than let it fall through to a raw JSON parse error.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new Error(`Observation lookup failed (content-type ${contentType || 'unknown'})`);
  }
  const data = (await res.json()) as { features?: { properties?: Props }[] } | null;
  return parseInvasiveObservation(data?.features?.[0]?.properties ?? null);
}

export interface InvasiveMatches {
  present: number;
  absent: number;
}

/** How many rows the WFS says match, out of the `hits` envelope it answers with. */
export function parseHits(xml: string): number | null {
  const matched = /numberMatched="(\d+)"/.exec(xml);
  return matched ? Number(matched[1]) : null;
}

export function hitsUrl(cql: string, rule: string): string {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: INVASIVES_LAYER,
    resultType: 'hits',
    CQL_FILTER: `(${cql}) AND ${rule}`,
  });
  return `${DATABC_OWS_URL}?${params}`;
}

async function hits(cql: string, rule: string, signal?: AbortSignal): Promise<number | null> {
  const res = await fetch(hitsUrl(cql, rule), { signal });
  if (!res.ok) throw new Error(`Count failed (HTTP ${res.status})`);
  return parseHits(await res.text());
}

/** Counts for a species, split the way the style splits the map. Null when nothing is typed. */
export async function fetchInvasiveMatches(
  species: string,
  signal?: AbortSignal,
): Promise<InvasiveMatches | null> {
  const cql = invasivesCql(species);
  if (!cql) return null;

  const [present, absent] = await Promise.all([
    hits(cql, PRESENT_CQL, signal),
    hits(cql, ABSENT_CQL, signal),
  ]);
  return present === null || absent === null ? null : { present, absent };
}

/**
 * Counts for the species typed last.
 *
 * Two reads go out per species and the service is slow, so an answer for an earlier species can
 * land after a newer one has already been counted. Only the answer for what is typed now is kept.
 */
export function createInvasiveCounter(apply: (matches: InvasiveMatches | null) => void) {
  let current = '';
  return {
    async count(species: string): Promise<void> {
      const cql = invasivesCql(species);
      current = cql;
      if (!cql) {
        apply(null);
        return;
      }
      try {
        const matches = await fetchInvasiveMatches(species);
        if (current === cql) apply(matches);
      } catch {
        if (current === cql) apply(null);
      }
    },
  };
}

/** The build-time species list. Losing it only costs the dropdown; typing still filters the map. */
export async function fetchInvasiveSpecies(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(new URL('data/invasive-species.json', document.baseURI).toString(), {
    signal,
  });
  if (!res.ok) throw new Error(`Species list unavailable (HTTP ${res.status})`);
  const data = (await res.json()) as { species?: unknown } | null;
  return Array.isArray(data?.species) ? (data.species as string[]) : [];
}

/* ------------------------------------------------------------------------------ hooks */

/** Fresh on every toggle: `gcTime: 0` drops the answer as soon as the overlay goes off. */
export function useWildfires(enabled: boolean) {
  return useQuery({
    queryKey: ['wildfires'],
    queryFn: ({ signal }) => fetchWildfires(signal),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function useRegionalBoundaries(enabled = true) {
  return useQuery({
    queryKey: ['regional-boundaries'],
    queryFn: ({ signal }) => fetchRegionalBoundaries(signal),
    enabled,
    staleTime: Infinity,
  });
}

export function useInvasiveSpecies(enabled: boolean) {
  return useQuery({
    queryKey: ['invasive-species'],
    queryFn: ({ signal }) => fetchInvasiveSpecies(signal),
    enabled,
    staleTime: Infinity,
  });
}
