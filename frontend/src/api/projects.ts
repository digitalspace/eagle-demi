import { useQuery } from '@tanstack/react-query';
import { searchDataset, searchRetry } from './search';
import type { Project, RawMetadata, RawProject } from './types';

/** Where a project with no usable centroid is placed: the middle of BC. */
export const BC_CENTRE: [number, number] = [-125.0, 54.0];

/**
 * Shown instead of an empty list when the load fails. An outage and a filtered-to-nothing result
 * look identical otherwise, which hid backend failures entirely.
 */
export const LOAD_ERROR_MESSAGE =
  'Could not load registry data from the API. This is a connection or server error — ' +
  'the list below is empty, not filtered.';

export const projectsKey = (query: string) => ['search', 'Project', query] as const;

/** Coordinates arrive in several shapes and occasionally reversed; heal what is recoverable. */
export function parseCentroid(raw: unknown): [number, number] {
  if (!raw) return BC_CENTRE;

  let coords: number[] = [];
  if (Array.isArray(raw) && raw.length === 2) {
    coords = [Number(raw[0]), Number(raw[1])];
  } else if (typeof raw === 'object') {
    const holder = raw as { coordinates?: unknown; coords?: unknown };
    const pair = holder.coordinates ?? holder.coords;
    if (Array.isArray(pair) && pair.length === 2) coords = [Number(pair[0]), Number(pair[1])];
  }

  if (coords.length !== 2 || Number.isNaN(coords[0]) || Number.isNaN(coords[1])) return BC_CENTRE;

  let [lon, lat] = coords;
  // [lat, lon] rather than [lon, lat].
  if (lon > 40 && lon < 65 && lat < -110 && lat > -140) [lon, lat] = [lat, lon];
  if (lon > 110 && lon < 140) lon = -lon;
  // Swapped AND sign-stripped, e.g. [53.354, 45.861].
  if (lon > 40 && lon < 60 && lat > 110 && lat < 140) [lon, lat] = [-lat, lon];

  if (lon < -140 || lon > -110 || lat < 45 || lat > 61) return BC_CENTRE;
  return [lon, lat];
}

const PLACEHOLDER_DESCRIPTION = /^No project description provided\.?$/;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The description as the record carries it, never invented.
 *
 * Angular substituted generated marketing prose here when a project had none. That text described
 * real assessment projects in words nobody wrote, so it is dropped rather than ported; an empty
 * description renders as empty.
 */
function describe(p: RawProject, meta: RawMetadata): string {
  const description = p.description || text(meta.trackAttributes?.['description']);
  return PLACEHOLDER_DESCRIPTION.test(description) ? '' : description;
}

function proponentOf(p: RawProject, meta: RawMetadata): string {
  const name =
    (typeof p.proponent === 'string' ? p.proponent : p.proponent?.name) ||
    text(meta.trackAttributes?.['proponent_name']);
  return name && name !== 'Proponent Organization' ? name : 'Proponent Organization';
}

export function mapProject(p: RawProject): Project {
  const rawMetadata: RawMetadata = p.metadata || {
    trackAttributes: {
      track_project_id: p.trackProjectId || p.id || 'N/A',
      lead_agency: p.leadAgency || 'BC Environmental Assessment Office',
      decision_date: p.eaDecisionDate || null,
      name: p.name,
      description: p.description,
    },
    eagleAttributes: {
      _id: p._id,
      name: p.name,
      responsibleEPD: p.responsibleEPD || 'Project Assessment Director',
      locationDescription: p.region || 'British Columbia',
      centroid: p.centroid,
    },
  };

  const description = describe(p, rawMetadata);
  const typeName = text(rawMetadata['type_name']) || text(rawMetadata.trackAttributes?.['type_name']);

  return {
    _id: p._id,
    id: p.id || p.trackProjectId || p._id || '',
    trackProjectId: p.trackProjectId || p.id,
    legacyEagleId: p.legacyEagleId || p._id,
    name: p.name || 'Unnamed Project',
    // Server markup only survives where the field it describes survived untouched: marking a
    // phrase inside text of our own invention is worse than not marking at all.
    highlighted: {
      name: p.name ? p.highlighted?.name || '' : '',
      description: description === p.description ? p.highlighted?.description || '' : '',
    },
    sector: p.sector && p.sector !== 'Other' ? p.sector : typeName || 'Other',
    status: p.status || text(rawMetadata.trackAttributes?.['project_state_name']) || 'Active',
    centroid: parseCentroid(p.centroid),
    gatingState: p.isPublished === false ? 'staged' : 'admitted',
    region: p.region || 'British Columbia',
    description,
    proponent: proponentOf(p, rawMetadata),
    // No fallback: an invented certificate number is a claim about a legal document.
    eaCertificate: p.eaCertificate === undefined ? undefined : p.eaCertificate || null,
    rawMetadata,
    sources: p.sources,
  };
}

export interface ProjectsResult {
  projects: Project[];
  /** Index-wide match total, or null where the backend reported none. */
  matchCount: number | null;
}

/**
 * The project corpus for a query. Shared by every screen that lists or names a project, so they
 * read one cache rather than each issuing the same `/search` call.
 */
export function useProjects(query = '') {
  return useQuery({
    queryKey: projectsKey(query),
    queryFn: async (): Promise<ProjectsResult> => {
      const { searchResults, count } = await searchDataset<RawProject>('Project', query);
      return { projects: searchResults.map(mapProject), matchCount: count };
    },
    ...searchRetry,
  });
}
