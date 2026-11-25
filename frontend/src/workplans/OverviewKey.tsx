import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { AllMarksButton, AllMarksPanel, type MarkKeyGroup } from './AllMarks';
import type { MarkStyle } from './chart-types';
import { OVERVIEW_LEGEND, type LegendPart } from './overview-legend';
import './overview-marks.css';

// The parts sit in the panel's 44 x 24 swatch box, which is their containing block.
const Swatch = ({ parts }: { parts: readonly LegendPart[] }) =>
  parts.map((p, i) => (
    <span key={i} className={p.cls} style={p.style}>
      {p.text}
    </span>
  ));

const COLUMNS: MarkKeyGroup[][] = OVERVIEW_LEGEND.map((column) =>
  column.map((g) => ({
    title: g.title,
    note: g.note,
    items: g.items.map(({ label, parts }) => ({ label, swatch: <Swatch parts={parts} /> })),
  })),
);

/** How far the shell footer reaches up into the viewport, in px; 0 while it is off screen. */
function useFooterLift(): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const footer = document.querySelector('.app-footer');
    if (!footer) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setLift(Math.max(0, Math.round(window.innerHeight - footer.getBoundingClientRect().top)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture catches the scroll of main as well as the window's.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(footer);
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return lift;
}

/** The Overview's one key: a round button fixed at the viewport's bottom right that opens every colour and mark it draws. */
export function OverviewKey() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const lift: MarkStyle = { '--wp-key-lift': `${useFooterLift()}px` };
  // On body, so no ancestor's containment or stacking context can pin it to the page box.
  return createPortal(
    <div className="wp-ov-key" style={lift}>
      <AllMarksButton id={id} open={open} onToggle={() => setOpen((was) => !was)} floating />
      <AllMarksPanel id={id} open={open} onClose={close} columns={COLUMNS} variant="floating" heading="Legend" />
    </div>,
    document.body,
  );
}
