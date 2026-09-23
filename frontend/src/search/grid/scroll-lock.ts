/**
 * Holds the page still behind a modal, and hands back the one way to move it anyway.
 *
 * Modality has to be enforced, not only declared: a page that keeps scrolling under an
 * `aria-modal` overlay is telling assistive tech something untrue. `overflow: hidden` stops a
 * wheel or a page-down but not a programmatic scroll, so the position is pinned as well as the
 * box.
 *
 * Which box scrolls is found rather than assumed. This shell scrolls an inner column
 * (`.app__main` carries `overflow-y: auto` in `styles.css`), so locking the document would leave
 * the results scrolling under the overlay.
 *
 * `moveTo` moves the pin, which is how a guided-tour step brings its control into view while the
 * rest of the page stays where it was put. It hands back the position it settled on, so a caller
 * can put the page back there later without keeping its own copy of the clamp.
 */
export class ScrollLock {
  private box: HTMLElement | null = null;
  private priorOverflow = '';
  private priorBodyOverflow = '';
  private pinned = 0;

  /** Capture: a scroll inside any container bubbles nowhere, so the listener has to see it going down. */
  private readonly hold = () => {
    if (this.box && this.box.scrollTop !== this.pinned) this.box.scrollTop = this.pinned;
  };

  /** The scrolling box `near` sits in: the first ancestor that scrolls, else the document. */
  static scrollerOf(near: Element | null): HTMLElement {
    for (let node = near?.parentElement ?? null; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        return node;
      }
    }
    return (document.scrollingElement as HTMLElement) ?? document.documentElement;
  }

  lock(near: Element | null): void {
    if (this.box) return;
    const box = ScrollLock.scrollerOf(near);
    this.box = box;
    this.priorOverflow = box.style.overflow;
    box.style.overflow = 'hidden';
    // The document scrolls through two elements, and which one a browser uses is its own business.
    if (box === document.documentElement || box === document.body) {
      this.priorBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    this.pinned = box.scrollTop;
    document.addEventListener('scroll', this.hold, true);
  }

  /** Where the locked box is held, in its own scroll coordinates. */
  get top(): number {
    return this.pinned;
  }

  /** Moves the pin, and answers with where it settled after the box clamped it. */
  moveTo(top: number): number {
    const box = this.box;
    if (!box) return 0;
    box.scrollTop = Math.max(0, Math.round(top));
    this.pinned = box.scrollTop;
    return this.pinned;
  }

  release(): void {
    const box = this.box;
    if (!box) return;
    document.removeEventListener('scroll', this.hold, true);
    box.style.overflow = this.priorOverflow;
    if (box === document.documentElement || box === document.body) {
      document.body.style.overflow = this.priorBodyOverflow;
    }
    this.box = null;
  }
}
