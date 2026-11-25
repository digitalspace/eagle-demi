import { Fragment, memo, useMemo, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ActYear } from './chart-facts';
import { tipText, type Mark } from './chart-types';
import { DOC_LINKS } from './overview-links';
import { rowActs, rowAria, rowId, rowTags } from './overview-chips';
import type { OverviewRowData } from './use-overview-acts';

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
      acts: rowActs(cand.row, name),
      label: rowAria({ name, row: cand.row, facts, workCount: cand.works.length, undated: drawing.notes.undated, today }),
    }),
    [cand, facts, name, today, drawing.notes.undated],
  );
  const { tags, acts, label } = text;
  const tabStop = useMemo(() => earliest(drawing.marks), [drawing.marks]);

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
      <div className="wp-ov-row" onClick={openRow}>
        <span className="wp-ov-nc">
          <span className="wp-ov-l1">
            <Link className="wp-ov-nm" to={to} state={state} aria-label={label} title={name}>
              {name}
            </Link>
            <span className="wp-ov-pid">ID {projectId}</span>
          </span>
          {(facts.l2w || facts.l2) && (
            <span className="wp-ov-st" title={facts.full}>
              <span className="wp-ov-stx">
                {facts.l2w && <span className="wp-ov-wk">{facts.l2w}</span>}
                {facts.l2w && facts.l2 && (
                  <span className="wp-ov-sep" aria-hidden="true">
                    {' · '}
                  </span>
                )}
                {facts.l2}
              </span>
            </span>
          )}
          {acts && (
            <span className="wp-ov-acts" role="group" aria-label={acts.label}>
              <span className="wp-ov-actsl">Acts: </span>
              {acts.acts.map((act, i) => (
                <Fragment key={act.year}>
                  {i > 0 && <span className="wp-ov-sep">, </span>}
                  {act.current ? (
                    <span className="wp-ov-actn wp-ov-actn--on" aria-current="true" title={act.say}>
                      {act.year}
                    </span>
                  ) : (
                    <a className="wp-ov-actn" href={`#${rowId(act.year, projectId)}`} aria-label={act.say} title={act.say} onClick={(event) => jumpTo(event, act.year)}>
                      {act.year}
                    </a>
                  )}
                </Fragment>
              ))}
            </span>
          )}
          {tags.length > 0 && (
            <span className="wp-ov-chips">
              {tags.map((tag) => (
                <span key={tag.text} className={`wp-ov-chip wp-ov-chip--${tag.tone === 'yellow' ? 'warn' : 'err'}`} title={tag.say}>
                  {tag.text}
                </span>
              ))}
            </span>
          )}
          <span className="wp-ov-fulln" aria-hidden="true">
            <b>{name}</b>
            {facts.full}
          </span>
        </span>
        <span className="wp-ov-tr" style={{ height: drawing.notes.h, containIntrinsicSize: `auto ${drawing.notes.h ?? 76}px` }}>
          <span className="wp-ov-trp">
            {drawing.marks.map((mark, i) => (
              <MarkEl key={i} mark={mark} tabStop={i === tabStop} />
            ))}
            {drawing.jumps.map((jump) => {
              const say = `Go to ${name} under the ${jump.year} Act (${jump.dir === 'prev' ? 'earlier' : 'later'})`;
              return (
                <a
                  key={jump.dir}
                  className={`wp-ov-jump wp-ov-jump--${jump.dir}`}
                  href={`#${rowId(jump.year, projectId)}`}
                  style={{ left: `${jump.left}%`, top: jump.top }}
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
    </div>
  );
});
