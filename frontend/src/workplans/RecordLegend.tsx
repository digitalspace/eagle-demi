import { useCallback, useId, useState } from 'react';
import { AllMarksButton, AllMarksPanel, type MarkKeyGroup } from './AllMarks';
import type { SwatchPart } from './chart-kinds';
import { RECORD_ALL_MARKS } from './record-kinds';
import type { RecordModel } from './record-model';

/** A key swatch: the mark drawn small with the classes of the real one. */
const KindDraw = ({ parts }: { parts: readonly SwatchPart[] }) => (
  <span className="wp-rec-kdraw" aria-hidden="true">
    {parts.map((p, i) => (
      <span key={i} className={p.cls} style={p.style} />
    ))}
  </span>
);

const ALL_MARKS: MarkKeyGroup[] = RECORD_ALL_MARKS.map((g) => ({
  title: g.title,
  items: g.items.map((k) => ({ label: k.label, swatch: <KindDraw parts={k.parts} /> })),
}));

/** The record's mark key, with the All marks button after its last item. */
export function RecordLegend({ model }: { model: RecordModel }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const button = <AllMarksButton id={id} open={open} onToggle={() => setOpen((was) => !was)} />;
  const last = model.legend.length - 1;
  return (
    <>
      <div className="wp-rec-legendrow">
        {last >= 0 ? (
          <ul className="wp-rec-legend" aria-label="Marks on this record">
            {model.legend.map((k, i) => (
              <li key={k.label} className="wp-rec-lg">
                <KindDraw parts={k.parts} />
                {k.label}
                {i === last && button}
              </li>
            ))}
          </ul>
        ) : (
          button
        )}
      </div>
      <AllMarksPanel id={id} open={open} onClose={close} groups={ALL_MARKS} variant="inline" label="All marks this record view can draw" />
    </>
  );
}
