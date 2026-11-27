import { memo, useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { ActYear } from './chart-facts';
import { tipText, type Mark } from './chart-types';
import { DOC_LINKS } from './overview-links';
import { rowAria, rowId, rowTags, type RowTag } from './overview-chips';
import type { RowFacts } from './overview-rows';
import type { OverviewRowData, WorkLine } from './use-overview-acts';

export interface OverviewRowProps {
  year: ActYear;
  data: OverviewRowData;
  today: string;
  /** The Overview's search string, for the record page's way back. */
  from: string;
  goRow: (year: ActYear, projectId: string) => void;
}

/** The mark button's accessible name: "Type: Title. Label value.", then the popup's link text when it draws one. */
function sayOf(mark: Mark): string {
  const parts = mark.tip ? [`${mark.type}: ${mark.tip.title}`, ...mark.tip.rows.map((row) => `${row.label} ${row.value}`)] : [mark.type];
  const link = mark.doc ? DOC_LINKS[mark.docKind] : undefined;
  if (link) parts.push(`Select for the link "${link.text}"`);
  return `${parts.join('. ')}.`;
}

/** The page tooltip's root listeners handle focus, pinning and the arrow keys; only the row's earliest mark is a tab stop. */
const MarkEl = memo(function MarkEl({ mark, tabStop }: { mark: Mark; tabStop: boolean }) {
  return (
    <button
      type="button"
      className={`wp-ov-mk ${mark.cls}`}
      style={mark.style}
      tabIndex={tabStop ? 0 : -1}
      aria-label={sayOf(mark)}
      data-tip={mark.tip ? tipText(mark.tip) : mark.type}
      data-tip-type={mark.type}
      data-tip-kind={mark.docKind}
      data-tip-doc={mark.doc || undefined}
    />
  );
});

/** Index of the mark placed earliest on the axis, else the first mark. */
function earliest(marks: readonly Mark[]): number {
  let best = -1;
  marks.forEach((mark, i) => {
    if (mark.x0 !== null && (best < 0 || mark.x0 < (marks[best].x0 ?? Infinity))) best = i;
  });
  return Math.max(best, 0);
}

/** One project under one Act: the sticky name cell with its lines, then the track with every mark and jump link. */
export const OverviewRow = memo(function OverviewRow({ year, data, today, from, goRow }: OverviewRowProps) {
  const { cand, drawing } = data;
  const { facts, name } = cand;
  const { projectId } = cand.row.project;
  const id = rowId(year, projectId);

  const label = useMemo(
    () => rowAria({ name, row: cand.row, facts, workCount: cand.works.length, undated: drawing.notes.undated, today }),
    [cand, facts, name, today, drawing.notes.undated],
  );
  // The assessment shares the project's line, open or minimized; the other works follow, one line each, while open.
  const head = data.works.find((line) => line.work.workTypeCode === 'assessment');
  const rest = head ? data.works.filter((line) => line !== head) : data.works;
  const hasMore = rest.length > 0;
  const [open, setOpen] = useState(false);
  const shown = head ? head.drawing : drawing;
  const headTags = useMemo(() => (head ? rowTags(head.facts, today) : []), [head, today]);
  const headStop = useMemo(() => earliest(shown.marks), [shown.marks]);

  const to = { pathname: `/workplans/${encodeURIComponent(projectId)}`, search: `?act=${year}` };
  const state = { from, rowId: id };
  const jumpTo = (event: MouseEvent<HTMLAnchorElement>, other: ActYear) => {
    event.preventDefault();
    goRow(other, projectId);
  };

  return (
    <div className="wp-ov-rw" id={id}>
      <div className="wp-ov-row">
        <span className="wp-ov-nc">
          <span className="wp-ov-l1">
            {hasMore ? (
              <button
                type="button"
                className="wp-ov-exp"
                aria-expanded={open}
                aria-label={`${open ? 'Minimize' : 'Show the works of'} ${name}`}
                title={open ? 'Minimize to one line' : 'Show each work on its own line'}
                onClick={() => setOpen(!open)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
            ) : (
              <span className="wp-ov-exp wp-ov-exp--none" aria-hidden="true" />
            )}
            <span className="wp-ov-l1t">
              <Link className="wp-ov-nm" to={to} state={state} aria-label={label} title={name}>
                {name}
              </Link>
              <span className="wp-ov-pid">ID {projectId}</span>
            </span>
          </span>
          {head && <HeadState facts={head.facts} />}
          <Tags tags={headTags} />
        </span>
        <span className="wp-ov-tr" style={head ? { height: shown.notes.h, containIntrinsicSize: `auto ${shown.notes.h ?? 76}px` } : { height: 36 }}>
          <span className="wp-ov-trp">
            {head && shown.marks.map((mark, i) => <MarkEl key={i} mark={mark} tabStop={i === headStop} />)}
            {shown.jumps.map((jump) => {
              const say = `Go to ${name} under the ${jump.year} Act (${jump.dir === 'prev' ? 'earlier' : 'later'})`;
              return (
                <a
                  key={jump.dir}
                  className={`wp-ov-jump wp-ov-jump--${jump.dir}`}
                  href={`#${rowId(jump.year, projectId)}`}
                  style={{ left: `${jump.left}%`, top: head ? jump.top : 8 }}
                  aria-label={say}
                  title={say}
                  onClick={(event) => jumpTo(event, jump.year)}
                >
                  {jump.dir === 'prev' ? `‹ ${jump.year} Act` : `${jump.year} Act ›`}
                </a>
              );
            })}
          </span>
        </span>
      </div>
      {hasMore && open && (
        <div className="wp-ov-fold">
          {rest.map((line) => (
            <WorkRow key={line.work.workId} line={line} name={name} today={today} to={to} state={state} />
          ))}
        </div>
      )}
    </div>
  );
});

/** The work's own name: its title without the project name in front, else its type. */
function workName(title: string | null, project: string, type: string | null): string {
  const t = title ?? '';
  const pre = `${project} - `;
  return (t.startsWith(pre) ? t.slice(pre.length) : t).replace(/ - \d{4} Act$/, '') || type || 'Work';
}

/** Line 2 of the head line: "Assessment" in bold, then where it is now. */
function HeadState({ facts }: { facts: RowFacts }) {
  return (
    <span className="wp-ov-st wp-ov-ind" title={facts.full}>
      <span className="wp-ov-wk">Assessment</span>
      {facts.l2 && (
        <span className="wp-ov-sep" aria-hidden="true">
          {' · '}
        </span>
      )}
      {facts.l2}
    </span>
  );
}

/** The alert tags under a name. */
function Tags({ tags }: { tags: readonly RowTag[] }) {
  if (!tags.length) return null;
  return (
    <span className="wp-ov-chips wp-ov-ind">
      {tags.map((tag) => (
        <span key={tag.text} className={`wp-ov-chip wp-ov-chip--${tag.tone === 'yellow' ? 'warn' : 'err'}`} title={tag.say}>
          {tag.text}
        </span>
      ))}
    </span>
  );
}

interface WorkRowProps {
  line: WorkLine;
  name: string;
  today: string;
  to: { pathname: string; search: string };
  state: { from: string; rowId: string };
}

/** One work of the project on its own line: its name as a link to the record, its state and alert tags; its marks on the track. */
const WorkRow = memo(function WorkRow({ line, name, today, to, state }: WorkRowProps) {
  const { work, facts, drawing } = line;
  const label = workName(work.title, name, work.workType);
  const tags = useMemo(() => rowTags(facts, today), [facts, today]);
  const first = useMemo(() => earliest(drawing.marks), [drawing.marks]);
  return (
    <div className="wp-ov-row wp-ov-row--work">
      <span className="wp-ov-nc">
        <Link className="wp-ov-wname" to={to} state={state} aria-label={`${label}, ${name}: open the record`}>
          {label}
        </Link>
        {facts.l2 && (
          <span className="wp-ov-st" title={facts.full}>
            {facts.l2}
          </span>
        )}
        <Tags tags={tags} />
      </span>
      <span className="wp-ov-tr" style={{ height: drawing.notes.h, containIntrinsicSize: `auto ${drawing.notes.h ?? 76}px` }}>
        <span className="wp-ov-trp">
          {drawing.marks.map((mark, i) => (
            <MarkEl key={i} mark={mark} tabStop={i === first} />
          ))}
        </span>
      </span>
    </div>
  );
});
