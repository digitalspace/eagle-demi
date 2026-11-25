/** The label column plus its gap, before the chart is measured. */
export const LABEL_PX = 276;
export const LABEL_GAP_PX = 16;
/** Narrowest track window the chart lays out for. */
const MIN_VIEW_PX = 240;
/** A mark this close to either edge of the window counts as out of view. */
const EDGE_PX = 24;

/** The scroller's track window: its width less the label column. */
export function trackWindow(el: HTMLElement) {
  const label = el.querySelector<HTMLElement>('.wp-rec-clabel');
  const labelPx = (label ? label.offsetWidth : LABEL_PX - LABEL_GAP_PX) + LABEL_GAP_PX;
  return { labelPx, viewPx: Math.max(MIN_VIEW_PX, el.clientWidth - labelPx) };
}

export function setScroll(el: HTMLElement, axis: HTMLElement | null, x: number) {
  el.scrollLeft = Math.max(0, Math.round(x));
  if (axis) axis.scrollLeft = el.scrollLeft;
}

/** Centres a mark in the time window when it is outside it, then scrolls it into view and focuses it; false when not drawn. */
export function scrollToMark(from: Element, id: string): boolean {
  const root = from.closest('.wp-rec');
  const el = root?.querySelector<HTMLElement>('.wp-rec-dscroll');
  const mark = root?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
  if (!el || !mark) return false;
  const x = mark.offsetLeft + mark.offsetWidth / 2;
  const { viewPx } = trackWindow(el);
  if (x < el.scrollLeft + EDGE_PX || x > el.scrollLeft + viewPx - EDGE_PX) {
    setScroll(el, root?.querySelector<HTMLElement>('.wp-rec-axclip') ?? null, x - viewPx / 2);
  }
  mark.scrollIntoView({ block: 'center', inline: 'nearest' });
  mark.focus({ preventScroll: true });
  return true;
}
