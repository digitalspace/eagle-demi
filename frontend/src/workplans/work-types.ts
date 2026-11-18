import type { WorkRow } from './derive';

export interface WorkType {
  /** At most 4 characters, for badges; "—" for a code not in the table. */
  code: string;
  name: string;
}

/** Every backend `workTypeCode` (`src/domain/work-override.js`), in the order type groups appear. */
const WORK_TYPES = new Map<string, WorkType>([
  ['assessment', { code: 'EA', name: 'Assessment' }],
  ['amendment', { code: 'AMD', name: 'Amendment' }],
  ['substantial-start', { code: 'SS', name: 'Substantial start' }],
  ['eac-extension', { code: 'EXT', name: 'EAC extension' }],
  ['project-notification', { code: 'PN', name: 'Project notification' }],
  ['minister-designation', { code: 'MIN', name: 'Minister designation' }],
  ['ceao-designation', { code: 'CEAO', name: 'CEAO designation' }],
  ['exemption-order', { code: 'EXO', name: 'Exemption order' }],
  ['transfer', { code: 'TRF', name: 'Transfer' }],
  ['material-alteration', { code: 'MA', name: 'Material alteration' }],
]);

export const WORK_TYPE_ORDER: readonly string[] = [...WORK_TYPES.keys()];

const NOT_KNOWN = 'Work type not known';

/** The full name; a code not in the table is turned into words ("new-kind" reads "New kind"). */
export function workTypeName(code: string | null): string {
  const known = code ? WORK_TYPES.get(code) : undefined;
  if (known) return known.name;
  const words = (code ?? '').replace(/[-_\s]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : NOT_KNOWN;
}

export function workTypeOf(row: WorkRow): WorkType {
  const code = row.work.workTypeCode;
  return (code ? WORK_TYPES.get(code) : undefined) ?? { code: '—', name: workTypeName(code) };
}
