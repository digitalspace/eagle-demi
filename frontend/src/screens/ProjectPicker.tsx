import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { hasNrptiData } from '../api/nrpti';
import { useProjects } from '../api/projects';
import type { Project } from '../api/types';
import { joinLabels, useLists, PROJECT_LIST_ERROR } from '../api/project-summary';
import { projectPath } from '../search/record-types';
import { useSheetWorksView, type Badge } from './sheet-works-badges';

/** Rows drawn at once. The filter still runs over all 411; a 411-row list is a wall, not a list. */
export const MAX_ROWS = 50;

const SKELETON_ROWS = [1, 2, 3, 4, 5, 6];

const searchBox = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.8rem 1rem',
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  font: 'var(--typography-regular-body)',
} as const;

/** The way into the Project summary screen. */
export function ProjectPicker() {
  return (
    <ProjectSearch title="AI Project Summary" pathFor={projectPath}>
      Pick a project to read its stored summary. Every summary is generated offline and read here, so opening one
      costs no model call.
    </ProjectSearch>
  );
}

const NRPTI_BADGE: Badge = {
  key: 'nrpti',
  tone: 'info',
  content: (
    <>
      NRPTI <span className="visually-hidden">records available</span>
    </>
  ),
};

/** The way into the Project details screen. */
export function ProjectDetailsPicker() {
  const sheet = useSheetWorksView();
  const badgesFor = useCallback(
    (row: Project) => [...(hasNrptiData(row.legacyEagleId) ? [NRPTI_BADGE] : []), ...sheet.badgesFor(row)],
    [sheet],
  );
  return (
    <ProjectSearch
      title="Project details"
      pathFor={(id) => `/project-details/${encodeURIComponent(id)}`}
      badgesFor={badgesFor}
      keep={sheet.keep}
      controls={sheet.control}
    >
      Pick a project to see data about it from other sources.
    </ProjectSearch>
  );
}

interface ProjectSearchProps {
  title: string;
  pathFor: (id: string) => string;
  /** Pills after the row's name, in order. */
  badgesFor?: (row: Project) => Badge[];
  /** Rows to search at all; the count line counts only these. */
  keep?: (row: Project) => boolean;
  /** Drawn under the search box. */
  controls?: ReactNode;
  children: ReactNode;
}

interface ResultItem {
  row: Project;
  meta: ReturnType<typeof joinLabels>;
  badges: Badge[];
}

interface ResultRowProps {
  item: ResultItem;
  to: string;
  onArrow: (delta: number, event: KeyboardEvent) => void;
}

function ResultRow({ item, to, onArrow }: ResultRowProps) {
  return (
    <li>
      <Link
        className="pp-result"
        to={to}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') onArrow(1, event);
          if (event.key === 'ArrowUp') onArrow(-1, event);
        }}
      >
        <span className="pp-result__name">
          {item.row.name}
          {item.badges.map((badge) => (
            <Fragment key={badge.key}>
              {' '}
              <span className={`pill pill--${badge.tone}`}>{badge.content}</span>
            </Fragment>
          ))}
        </span>
        {item.meta.text && (
          // `title` names any id the List lookup could not place; empty drops the attribute.
          <span className="pp-result__meta" title={item.meta.title || undefined}>
            {item.meta.text}
          </span>
        )}
      </Link>
    </li>
  );
}

/**
 * Project search, shared by every screen that opens one project. Results are plain links, not a
 * combobox, so Enter, open-in-new-tab and focus stay the browser's; only arrow movement is added.
 */
function ProjectSearch({ title, pathFor, badgesFor, keep, controls, children }: ProjectSearchProps) {
  // Shared registry corpus, mapped by the one `mapProject`: a second read of the same rows
  // would default them differently and show a region the registry screens never did.
  const projects = useProjects();
  const lists = useLists();

  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);

  // The one control on the screen: typing should be the first thing that works, without a click.
  useEffect(() => search.current?.focus(), []);

  const rows = projects.data?.projects;
  const total = projects.data ? (projects.data.matchCount ?? rows?.length ?? null) : null;
  const failed = projects.isError;
  /** True only before the first answer lands: an empty list afterwards is a result, not a wait. */
  const loading = projects.isPending && !failed;

  /** Case-insensitive substring on the name, alphabetical. Every match, before the display cap. */
  const matches = useMemo<Project[]>(() => {
    const needle = query.trim().toLowerCase();
    return (rows || [])
      .filter((row) => (!keep || keep(row)) && (!needle || row.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, query, keep]);

  const labels = lists.data ?? null;
  const visible = useMemo(
    () =>
      matches.slice(0, MAX_ROWS).map((row) => ({
        row,
        // Region or proponent, as one muted line. Phase is not on the shared row, and re-reading
        // for it would be the duplicate read this reuse avoids: it stays on the project's own page.
        meta: joinLabels([row.region || row.proponent], labels, ' · '),
        badges: badgesFor?.(row) ?? [],
      })),
    [matches, labels, badgesFor],
  );

  const countLabel = useMemo(() => {
    const found = matches.length;
    const loaded = rows?.length ?? 0;
    const parts = [`${found} ${found === 1 ? 'project' : 'projects'}`];
    if (found > MAX_ROWS) parts.push(`showing the first ${MAX_ROWS}`);
    // The read is one page. Saying "411 projects" over a 500-row page that held 500 of 900 would
    // be a claim about the registry this screen cannot make.
    if (total !== null && total > loaded) parts.push(`${loaded} of ${total} loaded`);
    return parts.join(' · ');
  }, [matches, rows, total]);

  /**
   * Arrow keys walk from the box into the list and back. `from` is the row's index, or -1 for the
   * search box. Enter and the links themselves are untouched: they are anchors.
   */
  function moveFocus(from: number, delta: number, event: KeyboardEvent) {
    event.preventDefault();
    const next = from + delta;
    if (next < 0) {
      search.current?.focus();
      return;
    }
    const links = results.current?.querySelectorAll<HTMLAnchorElement>('.pp-result');
    if (!links?.length) return;
    links[Math.min(next, links.length - 1)]?.focus();
  }

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>{title}</h1>
          <p>{children}</p>
        </div>
      </div>

      <section className="panel panel--padded">
        <label
          htmlFor="pp-search"
          className="micro-label"
          style={{ display: 'block', marginBottom: 'var(--layout-margin-xsmall)' }}
        >
          Find a project
        </label>
        <input
          id="pp-search"
          ref={search}
          type="search"
          placeholder="Project name"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') moveFocus(-1, 1, event);
          }}
          style={searchBox}
        />
        {controls}

        {/* Polite, so a filtered count is announced without interrupting the letter being typed. */}
        <p className="panel__lede pp-count" style={{ margin: 'var(--layout-margin-small) 0 0' }} aria-live="polite">
          {loading ? (
            <>
              <span className="skeleton skeleton--text" style={{ width: '8rem' }} aria-hidden="true" />
              <span className="visually-hidden">Loading the project list…</span>
            </>
          ) : (
            // No "0 projects" over a failed read: that is the outage reading as an empty registry.
            !failed && countLabel
          )}
        </p>
      </section>

      {failed && (
        <section className="panel panel--padded">
          <div className="callout callout--warning" role="alert">
            <p>{PROJECT_LIST_ERROR}</p>
          </div>
        </section>
      )}

      {!failed && (
        <section className="panel panel--padded" aria-busy={loading ? 'true' : undefined} ref={results}>
          {loading ? (
            <ul className="pp-list">
              {SKELETON_ROWS.map((row) => (
                <li key={row} className="pp-result" aria-hidden="true">
                  <span className="skeleton skeleton--text" style={{ width: '40%' }} />
                  <span className="skeleton skeleton--text" style={{ width: '25%', marginTop: '0.35rem' }} />
                </li>
              ))}
            </ul>
          ) : !matches.length ? (
            // Distinct from a query that matched nothing: the ACL left this reader zero rows to search.
            <p role="status" style={{ margin: 0 }}>
              {!rows?.length
                ? 'No projects are visible to you.'
                : `No project matches${query.trim() ? ` “${query}”` : ''}${keep ? ' with this filter' : ''}.`}
            </p>
          ) : (
            <ul className="pp-list">
              {visible.map((item, index) => (
                <ResultRow
                  key={item.row.id}
                  item={item}
                  to={pathFor(String(item.row.id))}
                  onArrow={(delta, event) => moveFocus(index, delta, event)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
