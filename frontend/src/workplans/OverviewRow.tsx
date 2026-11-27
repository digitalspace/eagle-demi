import { memo, useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
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
  const navigate = useNavigate();
  const { cand, drawing } = data;
  const { facts, name } = cand;
  const { projectId } = cand.row.project;
  const id = rowId(year, projectId);

  const text = useMemo(
    () => ({
      tags: rowTags(facts, today),
      label: rowAria({ name, row: cand.row, facts, workCount: cand.works.length, undated: drawing.notes.undated, today }),
    }),
    [cand, facts, name, today, drawing.notes.undated],
  );
  const { tags, label } = text;
  const [open, setOpen] = useState(true);
  // Open, the assessment shares the project's line; the other works follow, one line each.
  const head = open ? data.works.find((line) => line.work.workTypeCode === 'assessment') : undefined;
  const rest = head ? data.works.filter((line) => line !== head) : data.works;
  const shown = head ? head.drawing : drawing;
  const headTags = useMemo(() => (head ? rowTags(head.facts, today) : tags), [head, tags, today]);
  const headStop = useMemo(() => earliest(shown.marks), [shown.marks]);

  const to = { pathname: `/workplans/${encodeURIComponent(projectId)}`, search: `?act=${year}` };
  const state = { from, rowId: id };
  const jumpTo = (event: MouseEvent<HTMLAnchorElement>, other: ActYear) => {
    event.preventDefault();
    goRow(other, projectId);
  };

  // A click anywhere on the row opens the record, as the name link does; controls inside keep their own action.
  const openRow = (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('a, button')) return;
    navigate(to, { state });
  };

  return (
    <div className="wp-ov-rw" id={id}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer shortcut; the name link is the keyboard path */}
      <div className={open ? 'wp-ov-row wp-ov-row--head' : 'wp-ov-row wp-ov-row--head wp-ov-row--shut'} onClick={openRow}>
        <span className="wp-ov-nc">
          <span className="wp-ov-l1">
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
            <Link className="wp-ov-nm" to={to} state={state} aria-label={label} title={name}>
              {name}
            </Link>
            <span className="wp-ov-pid">ID {projectId}</span>
          </span>
          {head ? <HeadState kind="Assessment" facts={head.facts} /> : !open && <HeadState kind={facts.l2w} facts={facts} />}
          {(head || !open) && <Tags tags={headTags} />}
        </span>
        <span className="wp-ov-tr" style={open && !head ? { height: 36 } : { height: shown.notes.h, containIntrinsicSize: `auto ${shown.notes.h ?? 76}px` }}>
          <span className="wp-ov-trp">
            {(head || !open) && shown.marks.map((mark, i) => <MarkEl key={i} mark={mark} tabStop={i === headStop} />)}
            {shown.jumps.map((jump) => {
              const say = `Go to ${name} under the ${jump.year} Act (${jump.dir === 'prev' ? 'earlier' : 'later'})`;
              return (
                <a
                  key={jump.dir}
                  className={`wp-ov-jump wp-ov-jump--${jump.dir}`}
                  href={`#${rowId(jump.year, projectId)}`}
                  style={{ left: `${jump.left}%`, top: open && !head ? 8 : jump.top }}
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
      {open &&
        rest.map((line) => (
          <WorkRow key={line.work.workId} line={line} name={name} today={today} to={to} state={state} onOpen={openRow} />
        ))}
    </div>
  );
});

/** The work's own name: its title without the project name in front, else its type. */
function workName(title: string | null, project: string, type: string | null): string {
  const t = title ?? '';
  const pre = `${project} - `;
  return (t.startsWith(pre) ? t.slice(pre.length) : t).replace(/ - \d{4} Act$/, '') || type || 'Work';
}

/** Line 2 of the head line: the work type in bold, then where it is now. */
function HeadState({ kind, facts }: { kind: string; facts: RowFacts }) {
  if (!kind && !facts.l2) return null;
  return (
    <span className="wp-ov-st wp-ov-ind" title={facts.full}>
      {kind && <span className="wp-ov-wk">{kind}</span>}
      {kind && facts.l2 && (
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
  onOpen: (event: MouseEvent<HTMLElement>) => void;
}

/** One work of the project on its own line: its name as a link to the record, its state and alert tags; its marks on the track. */
const WorkRow = memo(function WorkRow({ line, name, today, to, state, onOpen }: WorkRowProps) {
  const { work, facts, drawing } = line;
  const label = workName(work.title, name, work.workType);
  const tags = useMemo(() => rowTags(facts, today), [facts, today]);
  const first = useMemo(() => earliest(drawing.marks), [drawing.marks]);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer shortcut; the name link is the keyboard path
    <div className="wp-ov-row wp-ov-row--work" onClick={onOpen}>
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
