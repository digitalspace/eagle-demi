import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  KEY_DOCUMENT_LABELS,
  joinLabels,
  resolveListLabel,
  useLists,
  useOrganizations,
  useProjectFacts,
  useProjectSummary,
  type ConditionItem,
  type FederalDocumentRef,
  type LabelLine,
  type NationNote,
  type OrganizationRow,
  type PhaseHistoryEntry,
  type ProjectSummaryCitation,
  type SummaryDocumentRef,
  type TimelineRow,
} from '../api/project-summary';
import { useDownload } from '../hooks/useDownload';
import { useSession } from '../session/session';
import { dayMonthYear, dayMonthYearTime, cad } from '../dates';

/** The public EPIC project page, which is where a reader goes for the documents themselves. */
const EPIC_PROJECT_BASE = 'https://projects.eao.gov.bc.ca/p';

/** `phaseHistory` rows are bare names in Eagle and dated objects in Track. Read both. */
const phaseLabel = (entry: PhaseHistoryEntry): string =>
  typeof entry === 'string' ? entry : entry?.name || entry?.phaseName || '';

const phaseDate = (entry: PhaseHistoryEntry): string | null =>
  typeof entry === 'string' ? null : entry?.date || entry?.dateCompleted || null;

const address = (org: OrganizationRow): string =>
  [org.address1, org.city, org.province, org.postal].filter(Boolean).join(', ');

const AI_BADGE = <span className="pill pill--info">AI-generated from the sources below</span>;

const SKELETON_CARDS = [1, 2, 3, 4];

/** A registry row as "Title (14 Oct 2014)". Its date is scraped text, so an odd one renders raw. */
function dated(row: FederalDocumentRef): string {
  if (!row.date) return row.title;
  return `${row.title} (${dayMonthYear(row.date) || row.date})`;
}

/**
 * Project summary — the stored, offline-generated status page for one project.
 *
 * The page never calls a model. Facts come from `GET /projects/:id` live; everything generated is
 * one stored row read from `GET /projects/:id/summary`, written by the generation script. That is
 * why it is instant, and why a section can simply be absent: the generator found no source
 * document for it and wrote null rather than inventing one.
 *
 * Every generated block carries the same two things as the AI Summary screen: the "AI-generated
 * from the sources below" badge, and citation chips that resolve to a real document row.
 */
export function ProjectSummary() {
  const projectId = useParams().id || '';
  const { isStaff } = useSession();

  const factsQuery = useProjectFacts(projectId);
  const summaryQuery = useProjectSummary(projectId, isStaff);
  const organizations = useOrganizations();
  const lists = useLists();

  const download = useDownload();
  const dialog = useRef<HTMLDialogElement>(null);
  /** The card that opened the dialog, so focus goes back to it rather than to the top of the page. */
  const opener = useRef<HTMLElement | null>(null);
  const [openCondition, setOpenCondition] = useState<ConditionItem | null>(null);

  const facts = factsQuery.data ?? null;
  const factsError = factsQuery.isError
    ? factsQuery.error instanceof Error
      ? factsQuery.error.message
      : 'Could not load the project.'
    : '';
  const summary = summaryQuery.data?.record ?? null;
  const summaryReason = summaryQuery.data?.reason ?? null;
  // isLoading, not isPending: a disabled query is pending for ever, so an empty id would leave the
  // skeletons on screen with nothing on its way.
  const summaryLoading = summaryQuery.isLoading;
  const sections = summary?.sections ?? null;
  /** True once the summary read has settled with nothing to show — 404, disabled, or a failure. */
  const noSummary = !summary && !!summaryReason;

  // The lookup table is null until it lands, so a label waits rather than rendering an id.
  const labels = lists.data ?? null;
  const labelLine = (values: Parameters<typeof joinLabels>[0], separator: string): LabelLine =>
    joinLabels(values, labels, separator);
  const resolve = (value: Parameters<typeof resolveListLabel>[0]) => resolveListLabel(value, labels);

  const proponent = facts?.proponentName || facts?.proponent || '';

  // Uppercase eyebrow: the Act the project is assessed under, then federal involvement. Every line
  // here goes through the lookup, because these fields hold `List` ObjectIds on the real record.
  const eyebrow = labelLine([facts?.legislation, facts?.CEAAInvolvement], ' · ');

  // The address is a plain string; only the region is a lookup, so it carries the whole line.
  const region = labelLine([facts?.region], '');
  const location: LabelLine = {
    ...region,
    text: [facts?.address, region.text ? `${region.text} region` : ''].filter(Boolean).join(' · '),
  };

  const statusLabel = labelLine([facts?.eacDecision, facts?.currentPhaseName], ', ');

  /**
   * Colour of the status card's left border. Never the only carrier of the message: the same three
   * states are spelled out in the label text beside it.
   */
  const statusTone = ((): 'success' | 'warning' | 'neutral' => {
    // The RESOLVED names: the stored values are ids, and no id contains "issued".
    const decision = resolve(facts?.eacDecision).text.toLowerCase();
    const certificate = (facts?.eaCertificate || '').toLowerCase();
    if (decision.includes('issued') || /^[a-z]\d{2}-\d{2}$/.test(certificate)) return 'success';
    const phase = resolve(facts?.currentPhaseName).text.toLowerCase();
    if (
      decision.includes('progress') ||
      certificate.includes('progress') ||
      phase.includes('review') ||
      phase.includes('application')
    ) {
      return 'warning';
    }
    return 'neutral';
  })();

  const latestAmendment =
    (summary?.facts?.amendments || [])
      .map((row) => row.datePosted)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;

  /**
   * The undated phase names, in order, for the one-line sequence under the status label.
   *
   * Eagle's `phaseHistory` rows carry no date and cannot sit on a dated axis, so they render here;
   * Track's dated phase rows stay on the timeline.
   */
  const phaseSequence = (() => {
    const current = resolve(facts?.currentPhaseName).text.trim().toLowerCase();
    const line = labelLine(
      (facts?.phaseHistory || []).filter((entry) => !phaseDate(entry)).map((entry) => phaseLabel(entry)),
      '',
    );
    return {
      rows: line.parts
        .filter((part) => !!part.text)
        .map((part) => ({ name: part.text, current: !!current && part.text.trim().toLowerCase() === current })),
      title: line.title,
    };
  })();

  /**
   * The merged timeline: dated phase rows, the decision date, one row per amendment, and the
   * model's extracted events — newest first. A row with no date cannot be placed on the axis, so
   * it sinks to the end.
   */
  const timeline = ((): TimelineRow[] => {
    const dated_: TimelineRow[] = [];

    (facts?.phaseHistory || []).forEach((entry, i) => {
      const date = phaseDate(entry);
      // Track's dated rows carry the name, but the same field is a List id on Eagle's.
      const label = labelLine([phaseLabel(entry)], '');
      if (!date || !label.text) return;
      dated_.push({ key: `phase-${i}`, date, label: label.text, kind: 'phase', title: label.title });
    });

    if (facts?.decisionDate) {
      dated_.push({
        key: 'decision',
        date: facts.decisionDate,
        label: facts.eaCertificate ? `Certificate ${facts.eaCertificate} issued` : 'Decision issued',
        kind: 'decision',
      });
    }

    for (const a of summary?.facts?.amendments || []) {
      if (!a.datePosted) continue;
      dated_.push({ key: `amend-${a.documentId}`, date: a.datePosted, label: a.displayName, kind: 'amendment' });
    }

    for (const e of sections?.timelineEvents || []) {
      dated_.push({ key: `ai-${e.date}-${e.label}`, date: e.date, label: e.label, kind: 'ai', citations: e.citations });
    }

    dated_.sort((a, b) => {
      if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : 0;
      return String(b.date).localeCompare(String(a.date));
    });
    return dated_;
  })();

  /** Amendment document rows joined to the one cited sentence the model wrote about each. */
  const amendmentRows = (() => {
    const notes = new Map((sections?.amendments || []).map((a) => [a.documentId, a]));
    return (summary?.facts?.amendments || []).map((doc) => ({
      ...doc,
      sentence: notes.get(doc.documentId)?.sentence || '',
      citations: notes.get(doc.documentId)?.citations || [],
    }));
  })();

  /**
   * Extracted nation names joined to their Organization row.
   *
   * Three outcomes, not two: a card, a plain cited row for a name the join could not match, and
   * `pending` while the organisation list is still in flight — without which every card would
   * flash as "unmatched" for as long as that request takes.
   */
  const nationRows: { note: NationNote; org: OrganizationRow | null; pending: boolean }[] = (
    sections?.nations || []
  )
    // A nameless note would render as citation chips under a blank line: sources for nothing.
    .filter((note) => !!note.name?.trim())
    .map((note) => ({
      note,
      org: note.organizationId ? organizations.data?.get(note.organizationId) || null : null,
      pending: !!note.organizationId && !organizations.data,
    }));

  /** The registry facts behind a federal section Canada holds, and null for one DEMI holds. */
  const federal = sections?.federal ?? null;
  const federalFacts = federal?.source === 'iaac' ? federal.facts || null : null;
  /** Guarded: a federal section built from registry facts alone can arrive with no `items` key. */
  const federalItems = federal?.items || [];

  const federalLine = (() => {
    if (!federalFacts) return '';
    const parts = [`Federal assessment: ${federalFacts.status || 'status not recorded'}`];
    if (federalFacts.decision) {
      parts.push(dated(federalFacts.decision));
    } else {
      parts.push('No federal decision statement yet');
      if (federalFacts.latest) parts.push(`Latest: ${dated(federalFacts.latest)}`);
    }
    return parts.join(' · ');
  })();

  /** The file when the registry filed one, else the page that prints the decision, else nothing. */
  const federalDecisionUrl = federalFacts?.decision
    ? federalFacts.decision.pdfUrl || federalFacts.decision.pageUrl || null
    : null;

  /** The link's label. A decision whose text would not read is still a file worth offering. */
  const federalDecisionLabel = (() => {
    const decision = federalFacts?.decision;
    const isPdf = !!decision?.pdfUrl || decision?.format === 'pdf';
    if (!isPdf) return 'Decision statement (registry page)';
    return decision?.pageCount ? `Decision statement (PDF, ${decision.pageCount} pages)` : 'Decision statement (PDF)';
  })();

  const keyDocuments = (summary?.facts?.keyDocuments || []).map((doc) => ({
    ...doc,
    ...(KEY_DOCUMENT_LABELS[doc.role] || { label: doc.role, note: '' }),
  }));

  /** The public EPIC page for this project. Empty when the record carries no Eagle id. */
  const eagleId = facts?.eagleId || facts?.legacyEagleId;
  const epicUrl = eagleId ? `${EPIC_PROJECT_BASE}/${eagleId}/project-details` : '';

  /** Resolve the `[n]` markers on one generated claim to the chunks they point at. */
  const citationsByNumber = useMemo(
    () => new Map((summary?.citations || []).map((c) => [c.n, c])),
    [summary],
  );

  function showCondition(item: ConditionItem, event: MouseEvent<HTMLButtonElement>) {
    opener.current = event.currentTarget;
    setOpenCondition(item);
  }

  // showModal() only after the sheet is in the DOM: the dialog's own contents are conditional, and
  // opening it before React has written them photographs an empty sheet.
  useEffect(() => {
    if (openCondition) dialog.current?.showModal();
  }, [openCondition]);

  /** Escape and the close button both land here through the dialog's own `close` event. */
  function onDialogClose() {
    setOpenCondition(null);
    opener.current?.focus();
    opener.current = null;
  }

  /**
   * Clicking the backdrop closes. A `<dialog>` backdrop is not a separate element, so the click
   * arrives on the dialog itself; target versus currentTarget separates "on the sheet" from
   * "outside it". Bound to the element rather than through JSX because a click handler on a
   * `<dialog>` reads to a linter as an interaction added to a non-interactive element; Escape is
   * the keyboard path and the element provides it.
   */
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClick = (event: Event) => {
      if (event.target === element) element.close();
    };
    element.addEventListener('click', onClick);
    return () => element.removeEventListener('click', onClick);
  }, []);

  /**
   * Cited sources under a generated claim. Same chip everywhere on the page, folded away until
   * asked for: the claim is what a reader came for, the documents behind it are the follow-up.
   * Native `<details>`, so the disclosure, the keyboard reach and the expanded state are the browser's.
   */
  function cites(numbers?: number[]) {
    const cited = (numbers || [])
      .map((n) => citationsByNumber.get(n))
      .filter((c): c is ProjectSummaryCitation => !!c);
    if (!cited.length) return null;

    return (
      <details className="ps-sources">
        <summary className="ps-sources__summary">Sources ({cited.length})</summary>
        <ul className="ps-cites">
          {cited.map((c) => (
            <li key={c.chunkId}>
              {c.source === 'iaac' && c.url ? (
                // Nothing in DEMI resolves `iaac:158078`, so this chip links the registry's own PDF
                // and never reaches the document download.
                <a className="ps-cite" href={c.url} target="_blank" rel="noopener" title={c.documentName}>
                  <span className="ps-cite__n">[{c.n}]</span>
                  <span className="ps-cite__doc">IAAC registry, p.&nbsp;{c.pageNumber}</span>
                  <span className="ps-cite__action">
                    {citeAction(c)}
                    <span className="visually-hidden"> (opens in a new tab)</span>
                  </span>
                </a>
              ) : c.source === 'iaac' ? (
                // The registry gave no PDF url for this one, and there is no DEMI document behind
                // it to fall back to: not a link anywhere.
                <span className="ps-cite" title={c.documentName}>
                  <span className="ps-cite__n">[{c.n}]</span>
                  <span className="ps-cite__doc">IAAC registry, p.&nbsp;{c.pageNumber}</span>
                  <span className="ps-cite__action">{citeAction(c)}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="ps-cite"
                  onClick={() => void download.start(c.documentId, projectId)}
                  disabled={download.busyId === c.documentId}
                >
                  <span className="ps-cite__n">[{c.n}]</span>
                  <span className="ps-cite__doc">{c.documentName}</span>
                  <span className="ps-cite__page">p.&nbsp;{c.pageNumber}</span>
                  <span className="ps-cite__action">
                    {download.busyId === c.documentId ? 'Preparing…' : 'Open document'}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </details>
    );
  }

  /**
   * The one-line note a section leaves when it generated nothing. A document the registry holds but
   * has not extracted yet is named and linked: "no source document" would be untrue, and the reader
   * can open the file the page is waiting on.
   */
  function absentNote(section: string, fallback: string) {
    const pending: SummaryDocumentRef | null =
      summary?.sectionErrors?.[section] === 'not_extracted' ? summary.sectionSources?.[section] || null : null;
    return (
      <p className="ps-note">
        {pending ? (
          <>
            <button
              type="button"
              className="ps-card__link ps-card__link--button"
              onClick={() => void download.start(pending.documentId, projectId)}
              disabled={download.busyId === pending.documentId}
            >
              {pending.displayName}
            </button>{' '}
            is in the registry but not yet extracted.
          </>
        ) : (
          fallback
        )}
      </p>
    );
  }

  const conditionCard = (item: ConditionItem): ReactNode => (
    <button key={item.n} type="button" className="ps-card ps-card--action" onClick={(event) => showCondition(item, event)}>
      <span className="micro-label ps-card__category">{item.category}</span>
      <span className="ps-card__title">{item.title}</span>
      <span className="ps-card__text">{item.oneLiner}</span>
      <span className="ps-card__cue" aria-hidden="true">
        Open
      </span>
      <span className="visually-hidden">Open the summary of this condition</span>
    </button>
  );

  return (
    <>
      <div className="ps">
        <Link className="ps__back" to="/projects">
          <span aria-hidden="true">←</span> All projects
        </Link>

        {factsError && (
          <div className="callout callout--warning" role="alert">
            <p>{factsError}</p>
          </div>
        )}

        {facts ? (
          <>
            <header className="ps__header">
              {/* `title` names any id the List lookup could not place; empty removes the attribute. */}
              {eyebrow.text && (
                <p className="micro-label ps__eyebrow" title={eyebrow.title || undefined}>
                  {eyebrow.text}
                </p>
              )}
              <h1 className="ps__title">{facts.name}</h1>
              <p className="ps__meta">
                {location.text && <span title={location.title || undefined}>{location.text}</span>}
                {proponent && (
                  <span>
                    Proponent: <strong>{proponent}</strong>
                  </span>
                )}
              </p>
            </header>

            {/* Status. The border colour repeats what the label already says; never the only cue. */}
            <section className={`ps-status ps-status--${statusTone}`} aria-labelledby="ps-status-h">
              <div className="ps-status__body">
                {/* Blank rather than "Status not recorded" while the List lookup is in flight: the
                    two fields behind this heading are ids until it lands. */}
                <h2 id="ps-status-h" className="ps-status__label" title={statusLabel.title || undefined}>
                  {statusLabel.text || (statusLabel.pending ? '' : 'Status not recorded')}
                </h2>

                {phaseSequence.rows.length > 0 && (
                  <p className="ps__meta">
                    <span title={phaseSequence.title || undefined}>
                      Phases:
                      {phaseSequence.rows.map((phase, index) => (
                        <span key={`${phase.name}-${index}`}>
                          {' '}
                          {phase.current ? (
                            <>
                              <strong>{phase.name}</strong>
                              <span className="visually-hidden"> (current phase)</span>
                            </>
                          ) : (
                            phase.name
                          )}
                          {/* A space on each side of the chevron, as the Angular template has. */}
                          {index < phaseSequence.rows.length - 1 && (
                            <>
                              {' '}
                              <span aria-hidden="true">›</span>
                            </>
                          )}
                        </span>
                      ))}
                    </span>
                  </p>
                )}

                {sections?.status ? (
                  <>
                    <p className="ps-badge-row">{AI_BADGE}</p>
                    {/* Model output as a text node. Nothing generated is ever rendered as markup. */}
                    <p className="ps-status__sentence">{sections.status.sentence}</p>
                    {cites(sections.status.citations)}
                  </>
                ) : (
                  summaryLoading && (
                    <p aria-hidden="true">
                      <span className="skeleton skeleton--text" style={{ width: '100%' }} />
                      <span className="skeleton skeleton--text" style={{ width: '72%' }} />
                    </p>
                  )
                )}
              </div>

              <dl className="ps-status__dates">
                {facts.decisionDate && (
                  <div>
                    <dt>Decision</dt>
                    <dd>{dayMonthYear(facts.decisionDate)}</dd>
                  </div>
                )}
                {latestAmendment && (
                  <div>
                    <dt>Last amended</dt>
                    <dd>{dayMonthYear(latestAmendment)}</dd>
                  </div>
                )}
                {facts.eaCertificate && (
                  <div>
                    <dt>Certificate</dt>
                    <dd>{facts.eaCertificate}</dd>
                  </div>
                )}
              </dl>
            </section>
          </>
        ) : (
          factsQuery.isLoading && (
            <header className="ps__header" aria-busy="true">
              <p className="visually-hidden">Loading the project record…</p>
              <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '14rem' }} />
              <span className="skeleton" aria-hidden="true" style={{ width: '24rem', height: '2.4rem', margin: '0.5rem 0' }} />
              <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '20rem' }} />
            </header>
          )
        )}

        {noSummary && (
          // 404 and `reason: 'disabled'` read the same to a reader: there is no generated summary
          // here. One line, not an error banner — the facts above are the page, and they are
          // complete. Signed out is its own line: staff-only is not the same as broken.
          <p className="ps-note" role="status">
            {summaryReason === 'signin'
              ? 'Sign in to view the generated summary. The project record above is public.'
              : summaryReason === 'error'
                ? 'The generated summary could not be loaded. The project record above is unaffected.'
                : 'No generated summary for this project yet.'}
          </p>
        )}

        {timeline.length > 0 && (
          <section className="ps-section" aria-labelledby="ps-timeline-h">
            <h2 id="ps-timeline-h" className="ps-section__title">
              Timeline
            </h2>
            <ol className="ps-timeline">
              {timeline.map((row) => (
                <li
                  key={row.key}
                  className={`ps-timeline__row${row.kind === 'ai' ? ' ps-timeline__row--ai' : ''}`}
                >
                  <span className="ps-timeline__date">{row.date ? dayMonthYear(row.date) : '—'}</span>
                  <div className="ps-timeline__label" title={row.title || undefined}>
                    {row.label}
                    {row.kind === 'ai' && (
                      <>
                        <span className="pill pill--info ps-timeline__mark">AI-extracted</span>
                        {cites(row.citations)}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {sections?.conditions ? (
          <section className="ps-section" aria-labelledby="ps-conditions-h">
            <h2 id="ps-conditions-h" className="ps-section__title">
              Certificate conditions
            </h2>
            <p className="ps-badge-row">{AI_BADGE}</p>
            <p className="ps-section__lede">
              Conditions from the certificate’s Schedule B, grouped and summarised. Tap a condition for the detail, and
              open the certificate itself for the binding wording.
            </p>
            <div className="ps-cards">{sections.conditions.items.map(conditionCard)}</div>
          </section>
        ) : (
          summaryLoading && (
            <section className="ps-section" aria-busy="true">
              <p className="visually-hidden">Loading the generated conditions…</p>
              <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '12rem', height: '1.4rem' }} />
              <div className="ps-cards" aria-hidden="true">
                {SKELETON_CARDS.map((i) => (
                  <span key={i} className="skeleton" style={{ height: '8rem' }} />
                ))}
              </div>
            </section>
          )
        )}

        {amendmentRows.length > 0 && (
          <section className="ps-section" aria-labelledby="ps-amendments-h">
            <h2 id="ps-amendments-h" className="ps-section__title">
              Amendments
            </h2>
            {/* The rows are facts. The badge speaks for the sentences under them, so it waits for one. */}
            {sections?.amendments && <p className="ps-badge-row">{AI_BADGE}</p>}
            <ul className="ps-list">
              {amendmentRows.map((a) => (
                <li key={a.documentId} className="ps-list__row">
                  <span className="ps-list__date">{a.datePosted ? dayMonthYear(a.datePosted) : '—'}</span>
                  <span>
                    <span className="ps-list__title">{a.displayName}</span>
                    {a.sentence && (
                      <>
                        <span className="ps-list__text">{a.sentence}</span>
                        {cites(a.citations)}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {summary && (
          <section className="ps-section" aria-labelledby="ps-federal-h">
            <h2 id="ps-federal-h" className="ps-section__title">
              Federal decision
            </h2>
            {federal ? (
              <>
                {/* The registry's own facts, which stand whether or not anything was generated. */}
                {federalFacts && (
                  <p className="ps-federal">
                    {federalLine}{' '}
                    ·{' '}
                    <a className="ps-card__link" href={federalFacts.projectUrl} target="_blank" rel="noopener">
                      View on IAAC registry
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                    {federalFacts.decision && (
                      <>
                        {' '}
                        ·{' '}
                        {federalDecisionUrl ? (
                          <a className="ps-card__link" href={federalDecisionUrl} target="_blank" rel="noopener">
                            {federalDecisionLabel}
                            <span className="visually-hidden"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          // Neither a file nor a page to send a reader to: naming it is all that is left.
                          <span>{federalDecisionLabel}</span>
                        )}
                      </>
                    )}
                  </p>
                )}
                {federal.reason === 'federal_decision_unreadable' && (
                  <p className="ps-note">
                    Decision statement found on the IAAC registry but its text could not be read.
                  </p>
                )}
                {/* The decision read and carries no numbered conditions, which the reader is owed in
                    place of an empty list: a comprehensive study under CEAA 2012 is decided that way. */}
                {federal.reason === 'no_conditions' && (
                  <p className="ps-note">The decision statement lists no conditions.</p>
                )}
                {/* No items means no model claim was made here, so the badge and its sources stay away. */}
                {federalItems.length > 0 && (
                  <>
                    <p className="ps-badge-row">{AI_BADGE}</p>
                    <div className="ps-cards">{federalItems.map(conditionCard)}</div>
                  </>
                )}
              </>
            ) : (
              absentNote(
                'federal',
                'No federal decision document for this project is in the registry, so no federal conditions are shown.',
              )
            )}
          </section>
        )}

        {summary && (
          <section className="ps-section" aria-labelledby="ps-nations-h">
            <h2 id="ps-nations-h" className="ps-section__title">
              First Nations consulted
            </h2>
            {/* Nothing generated below this heading unless a name was extracted: a section with no
                names keeping its badge reads as sources for a claim that was never made. */}
            {nationRows.length > 0 ? (
              <>
                <p className="ps-badge-row">{AI_BADGE}</p>
                <p className="ps-section__lede">
                  Names are read from the project’s own certificate and assessment documents. Addresses and websites
                  come from the registry’s organisation records, never from the model.
                </p>

                <div className="ps-cards">
                  {/* The names are already known; only the address and website are still in flight. */}
                  {nationRows
                    .filter((row) => row.pending)
                    .map((row) => (
                      <span key={row.note.name} className="skeleton" aria-hidden="true" style={{ height: '7rem' }} />
                    ))}
                  {nationRows
                    .filter((row) => row.org)
                    .map(({ note, org }) => (
                      <div key={note.name} className="ps-card">
                        <span className="ps-card__title">{org!.name}</span>
                        {address(org!) && <span className="ps-card__text">{address(org!)}</span>}
                        {org!.website && (
                          <a className="ps-card__link" href={org!.website} target="_blank" rel="noopener">
                            Website
                            <span className="visually-hidden"> for {org!.name} (opens in a new tab)</span>
                          </a>
                        )}
                        {cites(note.citations)}
                      </div>
                    ))}
                </div>

                {/* A name the join could not match gets its name and its citation and no card: an
                    address guessed from a near-match would be a contact detail nobody checked. */}
                {nationRows
                  .filter((row) => !row.org && !row.pending)
                  .map(({ note }) => (
                    <div key={note.name} className="ps-unmatched">
                      <span className="ps-unmatched__name">{note.name}</span>
                      <span className="ps-unmatched__note">
                        named in the documents; no organisation record matched
                      </span>
                      {cites(note.citations)}
                    </div>
                  ))}
              </>
            ) : (
              absentNote('nations', 'No nations were read from this project’s documents, so none are listed.')
            )}
          </section>
        )}

        {summary?.facts && (
          <section className="ps-section" aria-labelledby="ps-compliance-h">
            <h2 id="ps-compliance-h" className="ps-section__title">
              Compliance and enforcement
            </h2>
            <div className="ps-card ps-card--wide">
              <dl className="ps-figures">
                <div>
                  <dt>Published inspection records</dt>
                  <dd>{summary.facts.inspections?.count ?? 0}</dd>
                </div>
                <div>
                  <dt>Latest inspection</dt>
                  <dd>
                    {summary.facts.inspections?.latest?.datePosted
                      ? dayMonthYear(summary.facts.inspections.latest.datePosted)
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Published self-reports</dt>
                  <dd>{summary.facts.selfReports?.count ?? 0}</dd>
                </div>
              </dl>

              {sections?.compliance && (
                <>
                  <p className="ps-badge-row">{AI_BADGE}</p>
                  <p className="ps-card__text">{sections.compliance.paragraph}</p>
                  {cites(sections.compliance.citations)}
                </>
              )}

              {epicUrl && (
                <a className="ps-card__link" href={epicUrl} target="_blank" rel="noopener">
                  Compliance and enforcement on EPIC
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              )}
            </div>
          </section>
        )}

        {keyDocuments.length > 0 && (
          <section className="ps-section" aria-labelledby="ps-docs-h">
            <h2 id="ps-docs-h" className="ps-section__title">
              Key documents
            </h2>
            <div className="ps-cards">
              {keyDocuments.map((doc) => (
                <div key={doc.documentId} className="ps-card">
                  <span className="micro-label ps-card__category">{doc.label}</span>
                  <span className="ps-card__title">
                    {doc.displayName}
                    {doc.languageFlag === 'fr' && (
                      <>
                        {' '}
                        <span className="pill pill--neutral">
                          FR<span className="visually-hidden"> — French-language document</span>
                        </span>
                      </>
                    )}
                  </span>
                  <span className="ps-card__text">{doc.note}</span>
                  <button
                    type="button"
                    className="ps-card__link ps-card__link--button"
                    onClick={() => void download.start(doc.documentId, projectId)}
                    disabled={download.busyId === doc.documentId}
                  >
                    {download.busyId === doc.documentId ? 'Preparing…' : 'Open document'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {download.error && (
          <p className="footnote" role="alert">
            {download.error}
          </p>
        )}

        {summary && (
          <footer className="ps-footer">
            <p>
              Generated {dayMonthYearTime(summary.generatedAt)}
              {summary.model && ` by ${summary.model}`}
              {/* A null estimate prints nothing, as Angular's currency pipe does — never CA$0.0000. */}
              {typeof summary.estimatedCostCad === 'number' && `, est. ${cad(summary.estimatedCostCad)}`}. Estimated from
              list rates, not billed amounts. Generated once and stored — this page makes no model call.
            </p>
            {epicUrl && (
              <p>
                <a href={epicUrl} target="_blank" rel="noopener">
                  This project on EPIC<span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </p>
            )}
          </footer>
        )}
      </div>

      <dialog
        ref={dialog}
        className="ps-dialog"
        aria-labelledby="ps-dialog-h"
        onClose={onDialogClose}
      >
        {openCondition && (
          <div className="ps-dialog__sheet">
            <p className="micro-label">{openCondition.category}</p>
            <h2 id="ps-dialog-h" className="ps-dialog__title">
              {openCondition.title}
            </h2>
            <p className="ps-badge-row">{AI_BADGE}</p>
            <ul className="ps-dialog__bullets">
              {(openCondition.bullets || []).map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
            {cites(openCondition.citations)}
            <p className="footnote ps-dialog__footnote">
              AI-generated from Schedule B, see the certificate for binding wording.
            </p>
            <div className="ps-dialog__actions">
              <button type="button" className="ps-button" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

/** What a citation chip offers. A registry page is not a file, so it must not say PDF. */
function citeAction(citation: ProjectSummaryCitation): string {
  return citation.format === 'html' ? 'Open registry page' : 'Open PDF';
}
