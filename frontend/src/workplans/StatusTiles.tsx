import type { WorkRow, WorkStatus } from './derive';
import { count } from './format';

export type TileStatus = 'overdue' | 'next-30' | 'on-track' | 'not-started';

const TILE_LABEL: Record<TileStatus, string> = {
  overdue: 'Overdue in current phase',
  'next-30': 'Next milestone ≤ 30 days',
  'on-track': 'On track',
  'not-started': 'Not started',
};
const TILES = Object.keys(TILE_LABEL) as TileStatus[];

/** Status unknown and inactive works have no tile; the Work state filter covers inactive. */
export function StatusTiles({
  rows,
  pressed,
  onPress,
}: {
  rows: WorkRow[];
  pressed: TileStatus | null;
  onPress: (status: TileStatus) => void;
}) {
  const counts = new Map<WorkStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return (
    <div className="sl-tiles" role="group" aria-label="Show works by status">
      {TILES.map((status) => (
        <button
          key={status}
          type="button"
          className={`sl-tile sl-tile--${status}`}
          aria-pressed={pressed === status}
          onClick={() => onPress(status)}
        >
          <span className="sl-tile__count">{count(counts.get(status) ?? 0)}</span>
          <span className="sl-tile__label">{TILE_LABEL[status]}</span>
        </button>
      ))}
    </div>
  );
}
