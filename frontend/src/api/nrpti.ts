import { useQuery } from '@tanstack/react-query';

// Read in the browser straight from NRPTI's public API; nothing goes through DEMI or browser storage.
// Plain fetch with no bearer token: the host is not ours.

// The backend sync (src/scripts/sync-nrpti.js) keeps its own copy; the two builds share no code.
const NRPTI_SEARCH_URL = 'https://nrpti-api-f00029-prod.apps.silver.devops.gov.bc.ca/api/public/search';
// NRPTI answers 502 from 5,000 rows a page; 1,000 takes about the same 2-4 s as 100.
const PAGE_SIZE = 1000;
// Stops a runaway query; no business project needs a second page today.
const MAX_PAGES = 5;

const MINE_DATASET = 'MineBCMI';

/** Business list of projects with NRPTI data, by Eagle id. Names are for the reader only. */
const NRPTI_PROJECTS: Record<string, string> = {
  '588511e8aaecd9001b827a9b': 'Baldy Ridge Extension',
  '588511c0aaecd9001b82522a': 'Blackwater Gold',
  '58851067aaecd9001b80fb60': 'Bodie Waste Dump',
  '588511caaaecd9001b825bcb': 'Brucejack Mine',
  '588510deaaecd9001b816eec': 'Brule Mine',
  '5d40cc5b4cb2c7001b1336b8': 'Cariboo Gold Project',
  '58851069aaecd9001b80fd4d': 'Cougar South/Main Pits and West Spoil Coal',
  '58851004aaecd9001b809d03': 'Elkhorn Quarry Extension',
  '58851024aaecd9001b80bbd3': 'Eskay Creek Mine',
  '588511a6aaecd9001b823734': 'Fording River Operations Swift',
  '588510c6aaecd9001b8157d0': 'Galore Creek Copper-Gold-Silver',
  '5885112baaecd9001b81bbf4': 'Giscome Quarry and Lime Plant',
  '5cd9b4b56a15600025df0cc8': 'Highland Valley Copper Mine Life Extension',
  '5885106baaecd9001b80ff3a': 'Huckleberry Copper and Gold Mine',
  '5885100caaecd9001b80a4b7': 'Kemess South',
  '588511e6aaecd9001b8278ae': 'Kemess Underground',
  '5885118daaecd9001b821e2b': 'Kitsault Mine',
  '588511ceaaecd9001b825fa5': 'Kootenay West Mine',
  '58851156aaecd9001b81e652': 'KSM',
  '58851032aaecd9001b80c94e': 'Laredo Limestone',
  '58851079aaecd9001b810cb5': 'Line Creek Coal',
  '58851185aaecd9001b821677': 'Line Creek Operations Phase II',
  '5885100eaaecd9001b80a6a4': 'McGillivray Coal',
  '58851117aaecd9001b81a8b2': 'Mt. Milligan Copper-Gold',
  '58851049aaecd9001b80de7d': 'Mt. Polley Copper',
  '5885119caaecd9001b822d93': 'Murray River Coal',
  '58850ff8aaecd9001b809175': 'Nazko Lava Quarry Extension',
  '588510b6aaecd9001b814868': 'Orca Sand and Gravel',
  '588510c4aaecd9001b8155e3': 'Red Chris Porphyry Copper-Gold Mine',
  '5885120aaaecd9001b829d45': 'Red Mountain Underground Gold',
  '58851142aaecd9001b81d310': 'Roman Coal Mine',
  '58851040aaecd9001b80d6c9': 'Stronsay Lead/Zinc',
  '5885102caaecd9001b80c387': 'Sulphurets Gold/Silver',
  '588510d6aaecd9001b816738': 'Swamp Point Aggregate Mine',
  '58851056aaecd9001b80ebf8': 'Tulsequah Chief Mine',
  '58851002aaecd9001b809b16': 'Willow Creek',
  '58851085aaecd9001b811843': 'Wolverine Coal Mine',
};

export const hasNrptiData = (eagleId: string | undefined): boolean => !!eagleId && Object.hasOwn(NRPTI_PROJECTS, eagleId);

// Business-list projects whose BCMI mine lacks their Eagle id in `_epicProjectIds`: Eagle id -> mine `_sourceRefId`.
const UNLINKED_MINE_GUIDS: Record<string, string> = {
  '588511c0aaecd9001b82522a': '745b65a7-4849-4156-97dc-dc2d5c3f2154', // Blackwater Gold -> Blackwater Mine
  '58851067aaecd9001b80fb60': '6133891d-3398-466a-a4e9-f3c5d837a0f1', // Bodie Waste Dump -> Elkview Operations
  '5d40cc5b4cb2c7001b1336b8': '99dca8cc-3bb8-4818-8c04-974557be73b8', // Cariboo Gold Project -> Cariboo Gold Mine
  '58851069aaecd9001b80fd4d': '5bff9d66-758b-464f-b9cd-17047c186f05', // Cougar South/Main Pits -> Greenhills Operations
  '588511a6aaecd9001b823734': '739e90ee-807c-4287-91a3-7099352e1ffa', // Fording River Swift -> Fording River Operations
  '58851156aaecd9001b81e652': '86404595-0ac0-4489-a848-a8dce3ed1d96', // KSM -> KSM Mine
};

// EPD rows carry no project id, mine guid or project name; these were matched once by
// authorization holder (the certificate holder). Eagle id -> NRPTI record `_id`s.
const LINKED_RECORD_IDS: Record<string, string[]> = {
  // Galore Creek: Galore Creek Mining Corporation camp and access-road inspections
  '588510c6aaecd9001b8157d0': [
    '5f3d784e9524bf00211cc23f',
    '5ecea9a5589694001a08969f',
    '5ece978f589694001a08531e',
    '5fdb35de32fb130021418c10',
    '5fdb345e32fb130021417e3e',
    '5fe46fe3a9c099001a601a62',
    '5eceb5de589694001a08be3d',
    '5eceb5d9589694001a08be2b',
    '5eceb689589694001a08c066',
  ],
};

export const RECORD_KINDS: Record<string, string> = {
  Inspection: 'Inspection',
  Order: 'Order',
  AdministrativePenalty: 'Administrative penalty',
  Warning: 'Warning',
  Certificate: 'Certificate',
  Permit: 'Permit',
  Agreement: 'Agreement',
  ConstructionPlan: 'Construction plan',
  ManagementPlan: 'Management plan',
  SelfReport: 'Self-report',
};
// NRPTI takes a comma list here and returns every kind in one call; each row names its kind in `_schemaName`.
const RECORD_DATASETS = Object.keys(RECORD_KINDS).join(',');

const AGENCIES: Record<string, string> = {
  AGENCY_EAO: 'Environmental Assessment Office',
  AGENCY_ENV: 'Ministry of Environment',
  AGENCY_ENV_BCPARKS: 'BC Parks',
  AGENCY_ENV_COS: 'Conservation Officer Service',
  AGENCY_ENV_EPD: 'Environmental Protection Division',
  AGENCY_ALC: 'Agricultural Land Commission',
  AGENCY_OGC: 'BC Energy Regulator',
  AGENCY_FLNRO: 'Ministry of Forests',
  AGENCY_EMLI: 'Ministry of Energy, Mines and Low Carbon Innovation',
};

export interface NrptiMine {
  id: string;
  guid: string;
  name: string;
  status: string;
  commodities: string[];
  permittee: string;
  region: string;
  /** Null unless the mine's owner let BCMI show it. */
  permitNumber: string | null;
}

interface NrptiDocument {
  id: string;
  fileName: string;
  url: string;
}

export interface NrptiRecord {
  id: string;
  kind: string;
  title: string;
  dateIssued: string | null;
  agency: string;
  documents: NrptiDocument[];
}

/** One query that hit MAX_PAGES. `read` counts rows NRPTI returned; `total` is null when NRPTI did not report one. */
export interface NrptiTruncation {
  what: 'mines' | 'records';
  read: number;
  total: number | null;
}

interface RecordSet {
  records: NrptiRecord[];
  truncated: NrptiTruncation[];
}

type Row = Record<string, unknown>;

interface SearchResult {
  rows: Row[];
  total: number | null;
  complete: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const isPublic = (item: Row): boolean => Array.isArray(item['read']) && item['read'].includes('public');
const isWebUrl = (value: unknown): boolean => /^https?:\/\//i.test(text(value));

/** An array value repeats the key; NRPTI matches a repeated `and[field]` as any of the values. */
type SearchParams = Record<string, string | string[]>;

async function searchPage(params: SearchParams, pageNum: number, signal?: AbortSignal, pageSize = PAGE_SIZE) {
  const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => [value].flat().map((v) => [key, v])));
  query.set('pageNum', String(pageNum));
  query.set('pageSize', String(pageSize));
  const res = await fetch(`${NRPTI_SEARCH_URL}?${query}`, { signal });
  if (!res.ok) throw new Error(`NRPTI unavailable (HTTP ${res.status})`);
  const data: unknown = await res.json();
  const block = Array.isArray(data) ? (data[0] as { searchResults?: unknown; meta?: unknown } | undefined) : undefined;
  const meta = Array.isArray(block?.meta) ? (block.meta[0] as { searchResultsTotal?: unknown } | undefined) : undefined;
  return {
    rows: Array.isArray(block?.searchResults) ? (block.searchResults as Row[]) : [],
    total: typeof meta?.searchResultsTotal === 'number' ? meta.searchResultsTotal : null,
  };
}

/** Pages until NRPTI's total is reached or a page comes back short, at most MAX_PAGES. */
async function search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
  const rows: Row[] = [];
  let total: number | null = null;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const page = await searchPage(params, pageNum, signal);
    rows.push(...page.rows);
    total = page.total ?? total;
    if (page.rows.length < PAGE_SIZE || (total !== null && rows.length >= total)) return { rows, total, complete: true };
  }
  if (total !== null) return { rows, total, complete: false };
  // No total to compare: NRPTI skips pageNum * pageSize rows, so this asks for the one row after the last page.
  try {
    const next = await searchPage(params, MAX_PAGES * PAGE_SIZE, signal, 1);
    return { rows, total, complete: next.rows.length === 0 };
  } catch {
    // The probe only decides the truncation note; a failed one must not lose the rows already read.
    return { rows, total, complete: false };
  }
}

const truncation = (what: NrptiTruncation['what'], { rows, total, complete }: SearchResult): NrptiTruncation[] =>
  complete ? [] : [{ what, read: rows.length, total }];

function toMine(row: Row): NrptiMine {
  const commodities = Array.isArray(row['commodities']) ? row['commodities'].map(text).filter(Boolean) : [];
  return {
    id: text(row['_id']) || text(row['_sourceRefId']),
    guid: text(row['_sourceRefId']),
    name: text(row['name']) || 'Unnamed mine',
    status: text(row['status']),
    commodities: [...new Set(commodities)],
    permittee: text(row['permittee']),
    region: text(row['region']),
    permitNumber: row['showPermitNumber'] === true ? text(row['permitNumber']) || null : null,
  };
}

/** `issuedTo` is never read: it can hold a person's name. */
function toRecord(row: Row): NrptiRecord {
  const schema = text(row['_schemaName']);
  const kind = RECORD_KINDS[schema] ?? schema;
  const agencyCode = text(row['issuingAgency']);
  const documents = (Array.isArray(row['documents']) ? (row['documents'] as unknown[]) : [])
    .filter((doc): doc is Row => !!doc && typeof doc === 'object' && isWebUrl((doc as Row)['url']))
    .filter(isPublic)
    .map((doc) => ({
      id: text(doc['_id']) || text(doc['url']),
      fileName: text(doc['fileName']) || 'Document',
      url: text(doc['url']),
    }));
  return {
    id: text(row['_id']),
    kind,
    title: text(row['recordName']) || kind,
    dateIssued: text(row['dateIssued']) || null,
    agency: AGENCIES[agencyCode] ?? agencyCode.replace(/^AGENCY_/, ''),
    documents,
  };
}

async function searchRecords(filter: SearchParams, signal?: AbortSignal): Promise<RecordSet> {
  // Newest first, so the page bound drops the oldest rows.
  const params = { dataset: RECORD_DATASETS, populate: 'true', sortBy: '-dateIssued', ...filter };
  const result = await search(params, signal);
  // Eagle-origin rows are already in DEMI.
  const records = result.rows.filter((row) => row['sourceSystemRef'] !== 'epic').map(toRecord);
  return { records, truncated: truncation('records', result) };
}

/** Rows without an id are dropped: they cannot be told apart. */
const uniqueById = <T extends { id: string }>(items: T[]): T[] => [
  ...new Map(items.filter((item) => item.id).map((item) => [item.id, item])).values(),
];

interface MineSet {
  mines: NrptiMine[];
  truncated: NrptiTruncation[];
}

/** Different fields never combine as "any of" in NRPTI, so a mapped mine is its own read. */
async function fetchMines(eagleId: string, signal?: AbortSignal): Promise<MineSet> {
  const mappedGuid = UNLINKED_MINE_GUIDS[eagleId];
  const reads = [search({ dataset: MINE_DATASET, 'and[_epicProjectIds]': eagleId }, signal)];
  if (mappedGuid) reads.push(search({ dataset: MINE_DATASET, 'and[_sourceRefId]': mappedGuid }, signal));
  const results = await Promise.all(reads);
  return {
    mines: uniqueById(results.flatMap((result) => result.rows).map(toMine)),
    truncated: results.flatMap((result) => truncation('mines', result)),
  };
}

const QUERY_OPTIONS = { staleTime: 5 * 60_000, retry: 1 };

/**
 * Mines, then records by Eagle id, by mine guid and by fixed record id, each its own query so
 * the panel shows a part as it lands. Disabled without an Eagle id; never matched by name.
 */
export function useNrptiForProject(eagleId: string) {
  const enabled = !!eagleId;
  const linkedIds = LINKED_RECORD_IDS[eagleId];
  const mines = useQuery({
    queryKey: ['nrpti', eagleId, 'mines'],
    queryFn: ({ signal }) => fetchMines(eagleId, signal),
    enabled,
    ...QUERY_OPTIONS,
  });
  const guids = mines.data?.mines.map((mine) => mine.guid).filter(Boolean) ?? [];
  const byProject = useQuery({
    queryKey: ['nrpti', eagleId, 'by-project'],
    queryFn: ({ signal }) => searchRecords({ 'and[_epicProjectId]': eagleId }, signal),
    enabled,
    ...QUERY_OPTIONS,
  });
  // A repeated `and[mineGuid]` matches any of the guids, so every mine is one read.
  const byMine = useQuery({
    queryKey: ['nrpti', eagleId, 'by-mine', guids],
    queryFn: ({ signal }) => searchRecords({ 'and[mineGuid]': guids }, signal),
    enabled: guids.length > 0,
    ...QUERY_OPTIONS,
  });
  const linked = useQuery({
    queryKey: ['nrpti', eagleId, 'linked'],
    queryFn: ({ signal }) => searchRecords({ 'and[_id]': linkedIds ?? [] }, signal),
    enabled: enabled && !!linkedIds,
    ...QUERY_OPTIONS,
  });
  const parts = [byProject, byMine, linked];
  const records = uniqueById(parts.flatMap((part) => part.data?.records ?? [])).sort((a, b) =>
    (b.dateIssued ?? '').localeCompare(a.dateIssued ?? ''),
  );
  return {
    mines: mines.data?.mines ?? [],
    minesLoading: mines.isLoading,
    records,
    truncated: [mines, ...parts].flatMap((query) => query.data?.truncated ?? []),
    // The mine-guid read cannot start until the mines land.
    recordsLoading: mines.isLoading || parts.some((part) => part.isLoading),
    isError: [mines, ...parts].some((query) => query.isError),
  };
}
