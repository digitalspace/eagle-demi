import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ScrollLock } from './scroll-lock';
import { TOUR_STEPS, stepsOnPage, targetOf, type TourStep } from './tour-steps';
import { landingAfter } from './tour-walk';
import './guided-tour.css';

/** Where a step's control sits, read against the viewport the card is placed in. */
interface Spot {
  top: number;
  left: number;
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
}

/** The gap between the spotlighted control and the ring drawn round it. */
const PAD = 6;
/** How close to a viewport edge a control may sit before the step scrolls it into view. */
const MARGIN = 140;
const CARD_WIDTH = 380;
/** Below this much room under the control, the card is hung above it instead. */
const CARD_ROOM = 200;

interface Walk {
  steps: TourStep[];
  index: number;
}

/**
 * The guided tour: one control at a time, lit by a gold ring and described by a card. Mounted per
 * run; a page with nothing to point at ends it at once.
 *
 * Four dim panels around the target rather than one ring shadow, because a shadow cannot capture
 * a click: the spotlighted control is the hole, and stays usable.
 */
export function GuidedTour({ opener, onEnd }: { opener: RefObject<HTMLElement | null>; onEnd: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [walk, setWalk] = useState<Walk>(() => ({ steps: stepsOnPage(TOUR_STEPS), index: 0 }));
  const [spot, setSpot] = useState<Spot | null>(null);
  // Bumped by a resize, so the lit control is measured again.
  const [tick, setTick] = useState(0);
  const [lock] = useState(() => new ScrollLock());
  // The control the walk is on, by `data-tour` id, so a changed step list cannot shift the walk.
  const showing = useRef<string | null>(walk.steps[0]?.target ?? null);
  const broughtFor = useRef<string | null>(null);
  const ending = useRef(onEnd);
  useEffect(() => {
    ending.current = onEnd;
  }, [onEnd]);
  const end = useCallback(() => ending.current(), []);

  const step = walk.steps[walk.index] ?? null;
  const shown = spot !== null;

  /** Moves the walk, re-reading the page first so a control that has since arrived is counted. */
  const move = useCallback(
    (delta: number) => {
      const present = stepsOnPage(TOUR_STEPS);
      if (!present.length) return end();
      const at = present.findIndex((one) => one.target === showing.current);
      // A control missing when Next is pressed is skipped there and then.
      const next = (at >= 0 ? at : landingAfter(walk.steps, showing.current, present)) + delta;
      if (next < 0) return;
      if (next >= present.length) return end();
      showing.current = present[next].target;
      setWalk({ steps: present, index: next });
    },
    [end, walk.steps],
  );

  useEffect(() => {
    if (!walk.steps.length) end();
  }, [walk.steps.length, end]);

  // Reads the box the step points at, scrolling it into view once per step; a resize only remeasures.
  useLayoutEffect(() => {
    if (!step) return;
    const element = targetOf(step);
    if (!element) {
      const present = stepsOnPage(TOUR_STEPS);
      if (!present.length) return end();
      const landed = landingAfter(walk.steps, showing.current, present);
      showing.current = present[landed].target;
      setWalk({ steps: present, index: landed });
      return;
    }
    lock.lock(element);
    if (broughtFor.current !== step.target) {
      broughtFor.current = step.target;
      const before = element.getBoundingClientRect();
      if (before.top < MARGIN || before.bottom > window.innerHeight - MARGIN) {
        lock.moveTo(lock.top + before.top - MARGIN);
      }
    }
    const at = element.getBoundingClientRect();
    setSpot({
      top: at.top,
      left: at.left,
      width: at.width,
      height: at.height,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight,
    });
  }, [step, tick, walk.steps, end, lock]);

  // The card is the only thing a reader can reach while the tour runs, and a move keeps focus there.
  useLayoutEffect(() => {
    if (spot) card.current?.focus();
  }, [spot, walk.index]);

  useEffect(() => {
    const element = step ? targetOf(step) : null;
    const remeasure = () => setTick((was) => was + 1);
    const observer = new ResizeObserver(remeasure);
    if (element) observer.observe(element);
    window.addEventListener('resize', remeasure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', remeasure);
    };
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        end();
        return;
      }
      if (event.key !== 'Tab') return;
      // `aria-modal` has to hold in fact as well as in the attribute: Tab stays inside the card.
      const dialog = card.current;
      if (!dialog) return;
      const reachable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      if (!reachable.length) return;
      const first = reachable[0];
      const last = reachable[reachable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [end]);

  /**
   * `aria-modal` on the card only claims the page behind is out of play; `inert` makes it so.
   * Everything outside the tour goes inert bar the lit control, so the reader can try it.
   */
  useEffect(() => {
    const tour = root.current;
    if (!tour) return;
    const keep = new Set<Element>([tour]);
    const target = step ? targetOf(step) : null;
    if (target) keep.add(target);
    const ancestors = new Set<Element>();
    for (const branch of keep) {
      for (let node = branch.parentElement; node && node !== document.body; node = node.parentElement) {
        ancestors.add(node);
      }
    }
    const made: Element[] = [];
    const visit = (parent: Element) => {
      for (const child of parent.children) {
        if (keep.has(child)) continue;
        if (ancestors.has(child)) visit(child);
        // Anything already inert for its own reasons is left alone, so the end does not hand it back.
        else if (!child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          made.push(child);
        }
      }
    };
    visit(document.body);
    return () => {
      for (const child of made) child.removeAttribute('inert');
    };
  }, [step, shown]);

  // Declared after the inert effect so its cleanup runs later: a browser refuses focus inside an
  // inert subtree, and the opener sits in one until that cleanup has run.
  useEffect(() => {
    const scroll = lock;
    const back = opener;
    return () => {
      scroll.release();
      if (back.current?.isConnected) back.current.focus();
    };
  }, [opener, lock]);

  if (!step || !spot) return null;

  const onLastStep = walk.index === walk.steps.length - 1;
  const below = spot.top + spot.height + 12;
  const room = spot.viewHeight - below;
  const width = Math.min(CARD_WIDTH, spot.viewWidth - 32);
  const left = Math.min(Math.max(12, spot.left), spot.viewWidth - width - 12);
  const count = `Step ${walk.index + 1} of ${walk.steps.length}`;

  return (
    <div ref={root} className="display-grid__overlay display-grid__tour">
      <div
        aria-hidden="true"
        className="display-grid__tour-panel"
        style={{ top: 0, left: 0, right: 0, height: Math.max(0, Math.round(spot.top - PAD)) }}
      />
      <div
        aria-hidden="true"
        className="display-grid__tour-panel"
        style={{
          top: Math.round(spot.top - PAD),
          left: 0,
          width: Math.max(0, Math.round(spot.left - PAD)),
          height: Math.round(spot.height + PAD * 2),
        }}
      />
      <div
        aria-hidden="true"
        className="display-grid__tour-panel"
        style={{
          top: Math.round(spot.top - PAD),
          left: Math.round(spot.left + spot.width + PAD),
          right: 0,
          height: Math.round(spot.height + PAD * 2),
        }}
      />
      <div
        aria-hidden="true"
        className="display-grid__tour-panel"
        style={{ top: Math.round(spot.top + spot.height + PAD), left: 0, right: 0, bottom: 0 }}
      />

      <div
        aria-hidden="true"
        className="display-grid__tour-ring"
        style={{
          top: Math.round(spot.top - PAD),
          left: Math.round(spot.left - PAD),
          width: Math.round(spot.width + PAD * 2),
          height: Math.round(spot.height + PAD * 2),
        }}
      />

      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={step.title}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="display-grid__tour-card"
        style={{
          width: Math.round(width),
          left: Math.round(left),
          ...(room > CARD_ROOM ? { top: Math.round(below) } : { bottom: Math.round(spot.viewHeight - spot.top + 12) }),
        }}
      >
        {/* A move keeps focus on the card, and refocusing it fires nothing a reader would hear. */}
        <p aria-live="polite" className="display-grid__visually-hidden">
          {`${count}. ${step.title}`}
        </p>
        <p className="display-grid__tour-count">{count}</p>
        <h2 className="display-grid__tour-title">{step.title}</h2>
        <p id={bodyId} className="display-grid__tour-body">
          {step.body}
        </p>
        <div className="display-grid__tour-actions">
          <button type="button" className="display-grid__tour-skip" onClick={end}>
            Skip tour
          </button>
          <span className="display-grid__tour-walk">
            <button type="button" className="display-grid__tour-back" disabled={walk.index === 0} onClick={() => move(-1)}>
              Back
            </button>
            {/* Always `move`: it re-reads the page, so a step that has appeared since is walked to. */}
            <button type="button" className="display-grid__tour-next" onClick={() => move(1)}>
              {onLastStep ? 'Done' : 'Next'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
