import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { rowId } from './overview-chips';
import { rangeAt, recordAxis, todayIn, zoomIndex } from './record-axis';
import {
  actFor,
  neighboursOf,
  recordList,
  recordParts,
  recordPath,
  recordSummary,
  type PathStep,
  type RecordNote,
  type RecordPick,
  type RecordProject,
} from './record-header';
import { Chevron, RecordChart, TagView } from './RecordChart';
import { scrollToMark } from './record-scroll';
import { RecordEvents } from './RecordEvents';
import { RecordPicker } from './RecordPicker';
import { RecordTimeLimits } from './RecordTimeLimits';
import { TimeScale } from './TimeScale';
import type { Zoom } from './time-scale';
import { useRecordHighlight, useRecordModel } from './use-record-model';
import './chart-controls.css';
import './record.css';

/** What the Overview row link puts in router state; `from` is its search string. */
interface FromOverview {
  from: string;
  rowId: string | null;
}

function fromOverview(state: unknown): FromOverview | null {
  const s = state as { from?: unknown; rowId?: unknown } | null;
  if (!s || typeof s.from !== 'string') return null;
  return { from: s.from, rowId: typeof s.rowId === 'string' ? s.rowId : null };
}

const searchOf = (from: string) => (!from || from.startsWith('?') ? from : `?${from}`);

const NOTE_CLASS: Record<RecordNote['tone'], string> = {
  warn: 'wp-rec-note wp-rec-note--warn',
  pass: 'wp-rec-note wp-rec-note--pass',
  info: 'wp-rec-note',
};

/** The Acts this project has works under; the current one is a plain step. */
function ActStepper({ steps, recordKey, onPick }: { steps: readonly PathStep[]; recordKey: string; onPick: (act: number) => void }) {
  const currentRef = useRef<HTMLSpanElement>(null);
  const picked = useRef(false);
  // The picked button becomes the plain current step, so focus moves onto that step.
  useEffect(() => {
    if (!picked.current) return;
    picked.current = false;
    currentRef.current?.focus();
  }, [recordKey]);
  const body = (step: PathStep) => (
    <>
      <strong>{step.label}</strong>
      <span className="wp-rec-step__sub">{step.sub}</span>
    </>
  );
  return (
    <nav aria-label="Acts this project has works under">
      <ol className="wp-rec-stepper">
        {steps.map((step) => (
          <li key={step.act} className="wp-rec-step">
            {step.hasConn && <Chevron d="M6 3l5 5-5 5" />}
            {step.current ? (
              <span ref={currentRef} className="wp-rec-step__current" aria-current="step" tabIndex={-1}>
                {body(step)}
              </span>
            ) : (
              <button
                type="button"
                className="wp-rec-step__button"
                onClick={() => {
                  picked.current = true;
                  onPick(step.act);
                }}
              >
                {body(step)}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** One project's works under one Act: header, timeline, time limit changes, events and notes. */
export function RecordView({ projects, pick, today }: { projects: readonly RecordProject[]; pick: RecordPick; today: string }) {
  const { project, act } = pick;
  const navigate = useNavigate();
  const location = useLocation();
  const from = fromOverview(location.state);
  const [zoom, setZoom] = useState<Zoom>('whole');
  const [todayRequest, setTodayRequest] = useState(0);
  const recordKey = `${project.projectId}|${act}`;
  const [range, setRange] = useState<{ key: string; text: string } | null>(null);

  const list = useMemo(() => recordList(projects), [projects]);
  const near = neighboursOf(list, pick);
  const parts = useMemo(() => recordParts(project, act, today), [project, act, today]);
  const axis = useMemo(
    () =>
      recordAxis(
        {
          assessment: parts.assessment,
          nextAssessment: parts.nextAssessment,
          later: parts.later,
          certDay: parts.cert?.day ?? null,
        },
        today,
      ),
    [parts, today],
  );
  const zoomAt = zoomIndex(zoom);
  const { geo, model, first, onViewPx, onToggle } = useRecordModel(project, act, parts, today, axis, zoomAt);
  const hl = useRecordHighlight(recordKey, scrollToMark);
  const onRange = useCallback(
    (text: string) => setRange((was) => (was?.key === recordKey && was.text === text ? was : { key: recordKey, text })),
    [recordKey],
  );
  // Until the chart reports its scroll, the range is read at the left edge with the default width.
  const rangeText = range?.key === recordKey ? range.text : rangeAt(geo, 0);
  const { summary, tag } = recordSummary(project, act, parts.assessment, model.totals);
  const path = recordPath(project, parts.partActs, act);
  const notes = model.notes;

  const go = (projectId: string, year: number) =>
    navigate({ pathname: `/workplans/${encodeURIComponent(projectId)}`, search: `?act=${year}` }, { state: location.state });
  const onPick = (projectId: string) => {
    const next = projects.find((p) => p.projectId === projectId);
    if (next) go(projectId, actFor(next, act));
  };

  return (
    <div className="wp-rec">
      <header className="wp-rec-head">
        <div className="wp-rec-head__bar">
          <Link
            className="wp-rec-back"
            to={{ pathname: '/workplans', search: searchOf(from?.from ?? '') }}
            state={{ rowId: from?.rowId ?? rowId(act, project.projectId) }}
          >
            <Chevron d="M10 3L5 8l5 5" />
            Back to all works
          </Link>
          <div className="wp-rec-head__nav">
            <RecordPicker projects={projects} currentId={project.projectId} onPick={onPick} />
            {near && (
              <div className="wp-rec-head__pager">
                <button type="button" className="wp-btn wp-btn--secondary" onClick={() => go(near.prev.projectId, near.prev.act)}>
                  {near.prevText}
                </button>
                <button type="button" className="wp-btn wp-btn--secondary" onClick={() => go(near.next.projectId, near.next.act)}>
                  {near.nextText}
                </button>
              </div>
            )}
          </div>
        </div>
        <h1 className="wp-rec-title">{project.projectName}</h1>
        <p className="wp-rec-sum">
          {tag && <TagView tag={tag} />}
          <span>{summary}</span>
        </p>
        <div className="wp-rec-head__path">
          <ActStepper steps={path} recordKey={recordKey} onPick={(year) => go(project.projectId, year)} />
          {act === 1996 && (
            <p className="wp-rec-meta">Phases use the 2002 names; the 1996 committee, report and hearing phases are not in the data.</p>
          )}
        </div>
      </header>

      <section className="wp-rec-blk" aria-labelledby="tl-title">
        <div className="wp-rec-ctl">
          <h2 id="tl-title" className="wp-rec-ctl__title">
            Timeline
          </h2>
          <TimeScale
            layout="inline"
            zoom={zoom}
            onZoom={setZoom}
            onToday={() => setTodayRequest((n) => n + 1)}
            todayDisabled={!todayIn(axis, today)}
            range={rangeText}
          />
        </div>
        <RecordChart
          model={model}
          geo={geo}
          recordKey={recordKey}
          today={today}
          first={first}
          todayRequest={todayRequest}
          onRange={onRange}
          onViewPx={onViewPx}
          hl={hl}
          onToggle={onToggle}
          onJump={go}
        />
      </section>

      <RecordTimeLimits limits={model.limits} hasAssessment={model.events.hasAssessment} hlId={hl.hlId} onHover={hl.onHover} />
      <RecordEvents events={model.events} recordKey={recordKey} hl={hl} />

      {notes.length > 0 && (
        <section className="wp-rec-blk" aria-labelledby="notes-title">
          <div className="wp-rec-bhead">
            <h2 id="notes-title">Notes on this record</h2>
          </div>
          <ul className="wp-rec-notes">
            {notes.map((note) => (
              <li key={note.text} className={NOTE_CLASS[note.tone]}>
                {note.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="wp-rec-meta">Day counts are calendar days.</p>
    </div>
  );
}
