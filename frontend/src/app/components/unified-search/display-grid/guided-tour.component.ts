import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import { ScrollLock } from './scroll-lock';
import { TOUR_STEPS, stepsOnPage, targetOf, type TourStep } from './tour-steps';

/** Where a step's control sits, read against the viewport the card is placed in. */
interface Spot {
  top: number;
  left: number;
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
}

/** Everything the overlay draws for one step, in viewport pixels. */
interface TourGeometry {
  panelTopHeight: number;
  panelSideTop: number;
  panelSideHeight: number;
  panelLeftWidth: number;
  panelRightLeft: number;
  panelBottomTop: number;
  ringTop: number;
  ringLeft: number;
  ringWidth: number;
  ringHeight: number;
  cardWidth: number;
  cardLeft: number;
  /** One of the two is null: the card hangs below the control, or above it. */
  cardTop: number | null;
  cardBottom: number | null;
}

/** The gap between the spotlighted control and the ring drawn round it. */
const PAD = 6;
/** How close to a viewport edge a control may sit before the step scrolls it into view. */
const MARGIN = 140;
const CARD_WIDTH = 380;
/** Below this much room under the control, the card is hung above it instead. */
const CARD_ROOM = 200;

/**
 * Where the walk lands when the control it was on has gone: the first control after it that is
 * still on the page, so the gone control hands its slot on rather than the walk starting over.
 */
function landingAfter(was: readonly TourStep[], gone: string | null, left: TourStep[]): number {
  const goneAt = was.findIndex((one) => one.target === gone);
  for (let at = goneAt + 1; at < was.length; at += 1) {
    const found = left.findIndex((one) => one.target === was[at].target);
    if (found >= 0) return found;
  }
  return left.length - 1;
}

/**
 * The guided tour: one control at a time, lit by a gold ring and described by a card.
 *
 * Four dim panels around the target rather than one big ring shadow, because a shadow cannot
 * capture a click: the page behind would stay interactive under a dim that said otherwise. The
 * spotlighted control is the hole, and stays usable.
 *
 * Unencapsulated: the ring and the panels are placed over controls that live outside this
 * component's template, and the card is measured against them.
 */
@Component({
  selector: 'app-guided-tour',
  standalone: true,
  imports: [],
  templateUrl: './guided-tour.component.html',
  styleUrls: ['./guided-tour.css'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GuidedTourComponent implements OnDestroy {
  private cardRef = viewChild<ElementRef<HTMLDivElement>>('card');
  private rootRef = viewChild<ElementRef<HTMLDivElement>>('root');

  private readonly lock = new ScrollLock();
  /** Where focus goes when the tour ends: whatever opened it. */
  private opener: HTMLElement | null = null;
  /** The elements this tour made inert, so the ones already inert are left as they were. */
  private inerted: Element[] = [];
  private observer: ResizeObserver | null = null;
  /** The control the walk is on, by `data-tour` id, so a changed step list cannot shift the walk. */
  private showing: string | null = null;

  private readonly onKey = (event: KeyboardEvent) => this.handleKey(event);
  private readonly onResize = () => this.remeasure();

  open = signal(false);
  steps = signal<TourStep[]>([]);
  index = signal(0);
  spot = signal<Spot | null>(null);

  step = computed<TourStep | null>(() => this.steps()[this.index()] ?? null);
  onLastStep = computed(() => this.index() === this.steps().length - 1);

  geometry = computed<TourGeometry | null>(() => {
    const spot = this.spot();
    if (!spot) return null;
    const below = spot.top + spot.height + 12;
    // Every number comes off the measurement, never off a fresh `window` read: the card and the
    // ring have to be placed against the same viewport or they part company mid-render.
    const room = spot.viewHeight - below;
    const width = Math.min(CARD_WIDTH, spot.viewWidth - 32);
    return {
      panelTopHeight: Math.max(0, Math.round(spot.top - PAD)),
      panelSideTop: Math.round(spot.top - PAD),
      panelSideHeight: Math.round(spot.height + PAD * 2),
      panelLeftWidth: Math.max(0, Math.round(spot.left - PAD)),
      panelRightLeft: Math.round(spot.left + spot.width + PAD),
      panelBottomTop: Math.round(spot.top + spot.height + PAD),
      ringTop: Math.round(spot.top - PAD),
      ringLeft: Math.round(spot.left - PAD),
      ringWidth: Math.round(spot.width + PAD * 2),
      ringHeight: Math.round(spot.height + PAD * 2),
      cardWidth: Math.round(width),
      cardLeft: Math.round(Math.min(Math.max(12, spot.left), spot.viewWidth - width - 12)),
      cardTop: room > CARD_ROOM ? Math.round(below) : null,
      cardBottom: room > CARD_ROOM ? null : Math.round(spot.viewHeight - spot.top + 12),
    };
  });

  constructor() {
    // The card is the only thing a reader can reach while the tour runs, and a move keeps focus
    // there rather than letting it fall back to the page behind.
    effect(() => {
      const card = this.cardRef();
      this.index();
      card?.nativeElement.focus();
    });
    // Everything outside the tour goes inert on every step, because which control is lit — and so
    // which one stays pressable — changes with the step.
    effect(() => {
      const root = this.rootRef();
      const step = this.step();
      if (!this.open() || !root) return;
      this.applyInert(root.nativeElement, step);
    });
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  /** Starts the walk. `opener` is where focus returns when it ends. */
  start(opener?: HTMLElement): void {
    if (this.open()) return;
    const present = stepsOnPage(TOUR_STEPS);
    this.opener = opener ?? (document.activeElement as HTMLElement | null);
    if (!present.length) {
      // Nothing on this page to point at: ending here leaves focus where it was.
      this.opener = null;
      return;
    }
    this.open.set(true);
    this.steps.set(present);
    this.index.set(0);
    this.showing = present[0].target;
    this.lock.lock(targetOf(present[0]));
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    this.measure(true);
  }

  /** Moves the walk, re-reading the page first so a control that has since arrived is counted. */
  move(delta: number): void {
    const present = stepsOnPage(TOUR_STEPS);
    if (!present.length) {
      this.end();
      return;
    }
    const at = present.findIndex((one) => one.target === this.showing);
    // A control missing when Next is pressed is skipped there and then: the reader has asked to
    // move on, so there is nothing left to wait for.
    const next = (at >= 0 ? at : landingAfter(this.steps(), this.showing, present)) + delta;
    if (next < 0) return;
    if (next >= present.length) {
      this.end();
      return;
    }
    this.showing = present[next].target;
    this.steps.set(present);
    this.index.set(next);
    this.measure(true);
  }

  end(): void {
    if (!this.open()) return;
    const back = this.opener;
    this.teardown();
    this.open.set(false);
    this.spot.set(null);
    this.steps.set([]);
    this.index.set(0);
    this.showing = null;
    this.opener = null;
    // After the inert attributes are off: a browser refuses focus on an element still inside an
    // inert subtree, and the opener sits in one until `teardown` has run.
    if (back?.isConnected) back.focus();
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.end();
      return;
    }
    if (event.key !== 'Tab') return;
    // `aria-modal` has to hold in fact as well as in the attribute: Tab stays inside the card.
    const card = this.cardRef()?.nativeElement;
    if (!card) return;
    const reachable = [...card.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    if (!reachable.length) return;
    const first = reachable[0];
    const last = reachable[reachable.length - 1];
    const active = document.activeElement;
    if (!card.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Reads the box the step points at. `bring` also scrolls it into view, which the lock permits
   * because it pins a position rather than freezing one; a remeasure never moves the page.
   */
  private measure(bring: boolean): void {
    const step = this.step();
    if (!step) {
      this.end();
      return;
    }
    const element = targetOf(step);
    if (!element) {
      this.skipGone();
      return;
    }
    if (bring) {
      const before = element.getBoundingClientRect();
      if (before.top < MARGIN || before.bottom > window.innerHeight - MARGIN) {
        this.lock.moveTo(this.lock.top + before.top - MARGIN);
      }
    }
    const at = element.getBoundingClientRect();
    this.spot.set({
      top: at.top,
      left: at.left,
      width: at.width,
      height: at.height,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight,
    });
    this.watch(element);
  }

  /** A resize moves the controls, and a breakpoint can take one away entirely. */
  private remeasure(): void {
    if (!this.open()) return;
    this.measure(false);
  }

  /** The step's control has gone: hand the slot to the next one still on the page. */
  private skipGone(): void {
    const present = stepsOnPage(TOUR_STEPS);
    if (!present.length) {
      this.end();
      return;
    }
    const landed = landingAfter(this.steps(), this.showing, present);
    this.showing = present[landed].target;
    this.steps.set(present);
    this.index.set(landed);
    this.measure(false);
  }

  private watch(element: HTMLElement): void {
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.remeasure());
    this.observer.observe(element);
  }

  /**
   * `aria-modal` on the card only claims the page behind is out of play; `inert` makes it so.
   * Everything outside the tour is inert bar the lit control, which the four dim panels leave
   * pressable on purpose, so the reader can try the thing the step is describing.
   */
  private applyInert(root: HTMLElement, step: TourStep | null): void {
    this.clearInert();
    // The tour and the lit control are where the walk stops; the ancestors above them have to be
    // stepped through, because it is their other children that go inert.
    const keep = new Set<Element>([root]);
    const target = step ? targetOf(step) : null;
    if (target) keep.add(target);
    const ancestors = new Set<Element>();
    for (const branch of keep) {
      for (let node = branch.parentElement; node && node !== document.body; node = node.parentElement) {
        ancestors.add(node);
      }
    }
    const walk = (parent: Element) => {
      for (const child of parent.children) {
        if (keep.has(child)) continue;
        if (ancestors.has(child)) {
          walk(child);
        } else if (!child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          this.inerted.push(child);
        }
        // Anything already inert for its own reasons — a collapsed filter panel — is left alone,
        // so the end of the tour does not hand it back.
      }
    };
    walk(document.body);
  }

  private clearInert(): void {
    for (const child of this.inerted) child.removeAttribute('inert');
    this.inerted = [];
  }

  private teardown(): void {
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.observer?.disconnect();
    this.observer = null;
    this.clearInert();
    this.lock.release();
  }
}
