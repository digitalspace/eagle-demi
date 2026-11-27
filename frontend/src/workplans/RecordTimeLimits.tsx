import { count, plural } from './format';
import type { LimitPartView, LimitTableRow } from './record-types';

export interface RecordTimeLimitsProps {
  limits: readonly LimitPartView[];
  /** The record has an assessment: the block shows, with a line saying so, even without changes. */
  hasAssessment: boolean;
  hlId: string | null;
  onHover: (id: string, on: boolean) => void;
}

function countText(limits: readonly LimitPartView[]) {
  const n = limits.reduce((sum, part) => sum + part.rows.length, 0);
  if (!n) return 'No extensions or suspensions recorded for this assessment.';
  return `${plural(n, 'change')} on ${plural(limits.length, 'phase')}. Hover over or focus a row to highlight its mark on the timeline.`;
}

const DayCell = ({ days, barCls, barStyle }: Pick<LimitTableRow, 'barCls' | 'barStyle'> & { days: number }) => (
  <span className="wp-rec-dcell">
    <span className="wp-rec-dnum">{count(days)}</span>
    <span className={`wp-rec-dbar ${barCls}`} style={barStyle} />
  </span>
);

function LimitRow({ x, spans, hlId, onHover }: { x: LimitTableRow; spans: boolean } & Pick<RecordTimeLimitsProps, 'hlId' | 'onHover'>) {
  const lit = !!x.mid && x.mid === hlId;
  const on = () => x.mid && onHover(x.mid, true);
  const off = () => x.mid && onHover(x.mid, false);
  return (
    <tr
      className={lit ? 'wp-rec-lrow hl' : 'wp-rec-lrow'}
      tabIndex={0}
      data-days={x.days}
      data-counted={x.counted}
      onMouseEnter={on}
      onMouseLeave={off}
      onFocus={on}
      onBlur={off}
    >
      <td>
        <span className="wp-rec-kcell">
          <span className="wp-rec-gbox" aria-hidden="true">
            <span className={x.g} />
          </span>
          {x.kind}
          {x.warn && <span className="wp-rec-cwarn">{x.warn}</span>}
          {x.note && <span className="wp-rec-emeta">{x.note}</span>}
        </span>
      </td>
      <td>{x.section}</td>
      <td>{x.from}</td>
      {spans && <td>{x.to}</td>}
      <td>
        <DayCell days={Number(x.days)} barCls={x.barCls} barStyle={x.barStyle} />
      </td>
    </tr>
  );
}

function LimitPart({ part, hlId, onHover }: { part: LimitPartView } & Pick<RecordTimeLimitsProps, 'hlId' | 'onHover'>) {
  return (
    <div className="wp-rec-lstep" id={part.partId} data-work={part.work} data-phase={part.phase} data-ext={part.extDays} data-total={part.total}>
      <div className="wp-rec-lhead">
        <h3 className="wp-rec-sthead" id={part.id} tabIndex={-1}>
          <span className="wp-rec-sw" style={part.sw} />
          {part.name}
        </h3>
        <span className="wp-rec-sbar" aria-hidden="true">
          {part.bar.map((b, i) => (
            <span key={i} className={b.cls} style={b.style} />
          ))}
        </span>
        <dl className="wp-rec-lsum">
          {part.sum.map((s) => (
            <div key={s.k}>
              <dt>
                <span className={`wp-rec-kg ${s.kg}`} style={s.kgStyle} aria-hidden="true" />
                {s.k}
              </dt>
              <dd className={s.cls || undefined}>{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {part.noDatesText && <p className="wp-rec-emeta wp-rec-lnodates">{part.noDatesText}</p>}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region needs a keyboard stop */}
      <div className="wp-rec-ltwrap" tabIndex={0} role="region" aria-labelledby={part.id}>
        <table className="wp-rec-lt" aria-labelledby={part.id}>
          <thead>
            <tr>
              <th scope="col" className="wp-rec-lt__change">
                Change
              </th>
              <th scope="col" className="wp-rec-lt__section">
                Section
              </th>
              <th scope="col" className="wp-rec-lt__date">
                {part.spans ? 'From' : 'Date'}
              </th>
              {part.spans && (
                <th scope="col" className="wp-rec-lt__date">
                  To
                </th>
              )}
              <th scope="col">{part.onlyExt ? 'Days extended' : 'Days'}</th>
            </tr>
          </thead>
          <tbody>
            {part.rows.map((x, i) => (
              <LimitRow key={`${x.mid}|${i}`} x={x} spans={part.spans} hlId={hlId} onHover={onHover} />
            ))}
          </tbody>
          <tfoot>
            {part.totals.map((t) => (
              <tr key={t.k}>
                <th scope="row" colSpan={part.spans ? 4 : 3}>
                  {t.k}
                </th>
                <td>
                  <DayCell days={t.n} barCls={t.barCls} barStyle={t.barStyle} />
                </td>
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** "Time limit changes": one part per phase with extensions or suspensions; the chart's "N changes" links jump here. */
export function RecordTimeLimits({ limits, hasAssessment, hlId, onHover }: RecordTimeLimitsProps) {
  if (!hasAssessment && !limits.length) return null;
  return (
    <section className="wp-rec-blk" aria-labelledby="tlc-title">
      <div className="wp-rec-bhead">
        <h2 id="tlc-title">Time limit changes</h2>
        <span className="wp-rec-emeta">{countText(limits)}</span>
      </div>
      {limits.map((part) => (
        <LimitPart key={part.partId} part={part} hlId={hlId} onHover={onHover} />
      ))}
    </section>
  );
}
