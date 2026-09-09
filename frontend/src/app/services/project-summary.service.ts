import { Injectable, computed, inject, signal } from '@angular/core';
import { RegistryStateService } from './registry-state.service';
import {
  LabelLine,
  ListRef,
  OrganizationRow,
  ProjectFacts,
  ProjectListRow,
  ProjectSummaryRecord,
  ResolvedLabel
} from '../models/project-summary.models';
import {
  MOCK_ORGANIZATIONS,
  MOCK_PROJECT_SUMMARY,
  MOCK_PROJECT_SUMMARY_FACTS
} from '../mocks/mock-project-summary.data';
import { MOCK_PROJECTS } from '../mocks/mock-registry.data';

/** Why there is no generated summary. `null` alongside a record means there is one. */
export type SummaryReason = 'missing' | 'disabled' | 'error';

/** An Eagle ObjectId. Anything else in a lookup field is already the label. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Said to a reader who is looking at an id, so the page never shows one without saying why. */
const UNRESOLVED_HINT = 'Not in the registry’s list of names: ';

/**
 * Rows to ask for in the one `List` read. There are about 250 and the page is staff-only, so this
 * fits in a single request — the API caps a page at 1000 and refuses over 100 anonymously.
 */
const LIST_PAGE_SIZE = 1000;

/**
 * Rows to ask for in the one project read behind the picker. There are 411 projects on test and
 * the controller caps a page at 500, so the browser holds the whole list and filters it locally.
 */
const PROJECT_PAGE_SIZE = 500;

/**
 * Turn one stored lookup value into a label.
 *
 * @param lists  id -> name, or null while the lookup is still in flight.
 */
export function resolveListLabel(
  value: ListRef | undefined,
  lists: Map<string, string> | null
): ResolvedLabel {
  if (value === null || value === undefined) return { text: '', unresolved: false, pending: false };

  if (typeof value === 'object') {
    const name = (value.name || '').trim();
    if (name) return { text: name, unresolved: false, pending: false };
    return resolveListLabel(value._id ?? null, lists);
  }

  const text = String(value).trim();
  // Not an id, so it is the label already: mock fixtures, Track's own string columns and any
  // record the backfill resolved all land here untouched.
  if (!text || !OBJECT_ID.test(text)) return { text, unresolved: false, pending: false };

  // Withheld rather than shown and swapped a moment later — the id would flash on every load.
  if (!lists) return { text: '', unresolved: false, pending: true };

  const name = lists.get(text);
  return name
    ? { text: name, unresolved: false, pending: false }
    : { text, unresolved: true, pending: false };
}

/** Resolve several lookup values and render them as one line. */
export function joinLabels(
  values: (ListRef | undefined)[],
  lists: Map<string, string> | null,
  separator: string
): LabelLine {
  const parts = values.map(value => resolveListLabel(value, lists));
  const unresolved = parts.filter(part => part.unresolved).map(part => part.text);
  return {
    text: parts.map(part => part.text).filter(Boolean).join(separator),
    pending: parts.some(part => part.pending),
    title: unresolved.length ? UNRESOLVED_HINT + unresolved.join(', ') : '',
    parts
  };
}

/**
 * The two reads behind the Project summary screen, plus the Organization lookup the nation cards
 * join against.
 *
 * A service of its own rather than three more signals on RegistryStateService: nothing here is
 * shared with any other screen, and the registry service's signals are global state that every
 * screen resets. Same shape as LinksService and ApiKeysService.
 *
 * THE THREE LEGS ARE INDEPENDENT. Facts render on their own, and a missing or switched-off summary
 * is a normal answer, not a failure — the page still has a project to show. That is why each leg
 * owns a separate signal pair and nothing throws across them.
 */
@Injectable({ providedIn: 'root' })
export class ProjectSummaryService {
  private registry = inject(RegistryStateService);

  /** The project id currently loaded, so a second visit to the same row is not re-fetched. */
  loadedId = signal<string | null>(null);

  facts = signal<ProjectFacts | null>(null);
  factsLoading = signal<boolean>(false);
  factsError = signal<string>('');

  summary = signal<ProjectSummaryRecord | null>(null);
  summaryLoading = signal<boolean>(false);
  /** Set whenever `summary()` is null for a reason the page should say out loud. */
  summaryReason = signal<SummaryReason | null>(null);

  /** Every project the picker lists. null while unread, so the list shows skeletons not "none". */
  projects = signal<ProjectListRow[] | null>(null);
  projectsLoading = signal<boolean>(false);
  projectsError = signal<string>('');
  /**
   * Projects the index holds, which is not `projects().length` once there are more than a page of
   * them. The picker says so rather than presenting a truncated list as the whole registry.
   */
  projectsTotal = signal<number | null>(null);

  /** Organization rows by id. null while unread — the nation cards show skeletons until it lands. */
  organizations = signal<Map<string, OrganizationRow> | null>(null);

  /** `List` row names by id. null while unread, so a label waits rather than rendering the id. */
  lists = signal<Map<string, string> | null>(null);

  /** One lookup value as a label. See `resolveListLabel` for the three shapes it takes. */
  resolveLabel(value: ListRef | undefined): ResolvedLabel {
    return resolveListLabel(value, this.lists());
  }

  /** Several lookup values as one rendered line. */
  labelLine(values: (ListRef | undefined)[], separator: string): LabelLine {
    return joinLabels(values, this.lists(), separator);
  }

  /** Chunk-level citation lookup, `n` -> resolved row, for every AI block on the page. */
  citationsByNumber = computed(() => {
    const map = new Map<number, import('../models/project-summary.models').ProjectSummaryCitation>();
    for (const c of this.summary()?.citations || []) map.set(c.n, c);
    return map;
  });

  /**
   * Fire all four reads for one project.
   *
   * Deliberately not awaited as a group: the facts leg is the only one the page cannot render
   * without, so it must not wait behind a slow Organization list of 246 rows.
   */
  load(projectId: string): void {
    if (this.loadedId() === projectId) return;
    this.loadedId.set(projectId);

    this.loadFacts(projectId);
    this.loadSummary(projectId);
    this.loadOrganizations();
    this.loadLists();
  }

  private async loadFacts(projectId: string): Promise<void> {
    this.facts.set(null);
    this.factsError.set('');

    if (this.registry.config.USE_MOCK_DATA) {
      this.facts.set(MOCK_PROJECT_SUMMARY_FACTS);
      return;
    }

    this.factsLoading.set(true);
    try {
      const res = await fetch(`${this.registry.getBasePath()}/projects/${encodeURIComponent(projectId)}`);
      if (res.status === 403 || res.status === 404) {
        // Same answer for "not readable" and "not there", for the reason fetchDocument gives:
        // telling them apart would disclose that a hidden row exists.
        throw new Error('That project is not in the registry, or you do not have access to it.');
      }
      if (!res.ok) throw new Error(`Could not load the project (HTTP ${res.status}).`);
      this.facts.set(await res.json());
    } catch (err) {
      console.error('[ProjectSummary] project read failed:', err);
      this.factsError.set(err instanceof Error ? err.message : 'Could not load the project.');
    } finally {
      this.factsLoading.set(false);
    }
  }

  private async loadSummary(projectId: string): Promise<void> {
    this.summary.set(null);
    this.summaryReason.set(null);

    if (this.registry.config.USE_MOCK_DATA) {
      this.summary.set(MOCK_PROJECT_SUMMARY);
      return;
    }

    this.summaryLoading.set(true);
    try {
      const res = await fetch(`${this.registry.getBasePath()}/projects/${encodeURIComponent(projectId)}/summary`);
      // 404 is the documented "no row generated yet" answer, not an error worth an alert.
      if (res.status === 404) {
        this.summaryReason.set('missing');
        return;
      }
      if (!res.ok) throw new Error(`Summary API returned status ${res.status}`);
      const body = await res.json();
      // `{summary: null, reason: 'disabled'}` is the switched-off shape /search/summary already
      // uses, and it reads exactly like 404 on the page: no generated summary here.
      if (!body || body.summary === null || body.reason) {
        this.summaryReason.set(body?.reason === 'disabled' ? 'disabled' : 'missing');
        return;
      }
      this.summary.set(body as ProjectSummaryRecord);
    } catch (err) {
      console.error('[ProjectSummary] summary read failed:', err);
      this.summaryReason.set('error');
    } finally {
      this.summaryLoading.set(false);
    }
  }

  /**
   * Every project the caller may see, in one read, cached for the session — the picker's list.
   *
   * The same `dataset=Project` search the registry screens make, but deliberately not their
   * `projects()` signal: that one carries whatever the global keyword query last matched, and a
   * picker that filters in the browser has to hold the whole list. The `List` lookup rides along
   * because a row's phase is an id on every record the backfill left unresolved.
   */
  async loadProjects(): Promise<void> {
    if (this.projects() || this.projectsLoading()) return;
    this.projectsError.set('');
    this.loadLists();

    if (this.registry.config.USE_MOCK_DATA) {
      this.projects.set(MOCK_PROJECTS.map(p => ({
        id: String(p.id),
        name: p.name,
        region: p.region ?? null,
        proponent: p.proponent ?? null
      })));
      this.projectsTotal.set(MOCK_PROJECTS.length);
      return;
    }

    this.projectsLoading.set(true);
    try {
      const params = `dataset=Project&pageSize=${PROJECT_PAGE_SIZE}`;
      const res = await fetch(`${this.registry.getBasePath()}/search?${params}`);
      if (!res.ok) throw new Error(`Project search returned status ${res.status}`);
      const body = await res.json();
      const rows: any[] = body?.[0]?.searchResults || [];
      // A nameless row is dropped: it cannot be searched for and would render as a blank link.
      this.projects.set(rows
        .filter(r => r.name && (r.id ?? r._id))
        .map(r => ({
          id: String(r.id ?? r._id),
          name: String(r.name),
          region: r.region ?? null,
          proponent: r.proponent ?? null,
          currentPhaseName: r.currentPhaseName ?? null
        })));
      this.projectsTotal.set(body?.[0]?.meta?.[0]?.searchResultsTotal ?? body?.[0]?.count ?? null);
    } catch (err) {
      // Left null, not emptied: an outage must not read as "the registry has no projects".
      console.error('[ProjectSummary] project list read failed:', err);
      this.projectsError.set('The project list could not be loaded. Reload the page to try again.');
    } finally {
      this.projectsLoading.set(false);
    }
  }

  /**
   * One point-read of every Indigenous Group Organization row, indexed by id.
   *
   * 246 rows on test, so one request beats one request per nation, and the response is the same
   * whichever project asked for it — hence the cache. Address and website come from here and never
   * from the model: a contact detail a model wrote is a contact detail nobody verified.
   */
  private async loadOrganizations(): Promise<void> {
    if (this.organizations()) return;

    if (this.registry.config.USE_MOCK_DATA) {
      this.organizations.set(new Map(MOCK_ORGANIZATIONS.map(o => [o.id, o])));
      return;
    }

    try {
      const params = 'dataset=Organization&and[companyType]=Indigenous Group&pageSize=500';
      const res = await fetch(`${this.registry.getBasePath()}/search?${params}`);
      if (!res.ok) throw new Error(`Organization search returned status ${res.status}`);
      const body = await res.json();
      // `id` before `_id`: the generator stores `organizationId` from this same endpoint's `id`,
      // so indexing on anything else would join nothing.
      const rows: any[] = body?.[0]?.searchResults || [];
      this.organizations.set(new Map(rows.map(r => [String(r.id ?? r._id), {
        id: String(r.id ?? r._id),
        name: r.name || '',
        companyType: r.companyType,
        address1: r.address1,
        city: r.city,
        province: r.province,
        postal: r.postal,
        country: r.country,
        website: r.website
      } as OrganizationRow])));
    } catch (err) {
      // A nation card without an address still carries the name and its citation, so this failing
      // costs detail, not the section.
      console.warn('[ProjectSummary] Organization lookup failed:', err);
      this.organizations.set(new Map());
    }
  }

  /**
   * Every Eagle `List` row as id -> name, in one request, cached for the session.
   *
   * The project record stores List ObjectIds in `CEAAInvolvement`, `eacDecision`,
   * `currentPhaseName` and `phaseHistory`, so without this the page renders ids. The same read
   * eagle-public makes for the same reason (`api.ts`, `dataset=List`); no endpoint resolves the
   * names on the project record itself.
   *
   * The whole table rather than the ids this project needs: it is 250 tiny rows, it is the same
   * answer for every project, and asking by id would be a request per project instead of per
   * session.
   */
  private async loadLists(): Promise<void> {
    if (this.lists()) return;

    if (this.registry.config.USE_MOCK_DATA) {
      // The fixture already carries names and resolution is a no-op on a name — but the table
      // still has to be SET, or every label would sit on `pending` forever.
      this.lists.set(new Map());
      return;
    }

    try {
      const res = await fetch(`${this.registry.getBasePath()}/search?dataset=List&pageSize=${LIST_PAGE_SIZE}`);
      if (!res.ok) throw new Error(`List search returned status ${res.status}`);
      const body = await res.json();
      const rows: any[] = body?.[0]?.searchResults || [];
      // A nameless row is dropped rather than mapped to '': an id with its "not in the list"
      // tooltip says more than a blank.
      this.lists.set(new Map(
        rows.filter(r => r.name).map(r => [String(r.id ?? r._id), String(r.name)])
      ));
    } catch (err) {
      // An empty table, not a retry. Ids then render with the tooltip that explains them, which is
      // a worse page than names but still the page — the same call the Organization lookup makes.
      console.warn('[ProjectSummary] List lookup failed:', err);
      this.lists.set(new Map());
    }
  }
}
