import type { WorkRow } from './derive';

/** `open` ("In progress"): neither closed nor inactive. */
export type WorkState = 'open' | 'inactive' | 'closed';

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  open: 'In progress',
  inactive: 'Inactive',
  closed: 'Closed',
};

export function workStateOf(row: Pick<WorkRow, 'status'>): WorkState {
  if (row.status === 'closed' || row.status === 'inactive') return row.status;
  return 'open';
}
