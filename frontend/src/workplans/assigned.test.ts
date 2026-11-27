import { afterEach, describe, expect, it } from 'vitest';
import type { WorkplanRow } from '../api/sheet-works';
import { assignedOk, ME, peopleOf, rolesOf } from './assigned';

const work = (over: Partial<WorkplanRow>): WorkplanRow => ({ workId: 'w', staff: [], team: null, ...over }) as WorkplanRow;
const lead = work({ workId: 'a', team: 'Infrastructure', staff: [{ name: 'Staff One', role: 'Work lead' }, { name: 'Staff Two', role: 'Responsible EPD' }] });
const sheet = work({ workId: 's', source: 'sheet' });

afterEach(() => {
  delete (window as { demiMe?: string }).demiMe;
});

describe('assignedOk', () => {
  it('passes everything with no filter', () => {
    expect(assignedOk(sheet, '', '')).toBe(true);
  });
  it('matches the lead, the EPD and team members, as My Workplans does', () => {
    expect(assignedOk(lead, 'Staff One', '')).toBe(true);
    expect(assignedOk(lead, 'Staff Two', '')).toBe(true);
    expect(assignedOk(lead, 'Staff Three', '')).toBe(false);
  });
  it('hides works with no one on them while a person is picked', () => {
    expect(assignedOk(sheet, 'Staff One', '')).toBe(false);
  });
  it('filters by team', () => {
    expect(assignedOk(lead, '', 'Infrastructure')).toBe(true);
    expect(assignedOk(lead, '', 'Mining and Energy')).toBe(false);
  });
  it('reads Me as the signed-in reader, and matches nothing when unknown', () => {
    expect(assignedOk(lead, ME, '')).toBe(false);
    (window as { demiMe?: string }).demiMe = 'Staff One';
    expect(assignedOk(lead, ME, '')).toBe(true);
  });
});

describe('peopleOf and rolesOf', () => {
  it('lists names and teams, and counts works with no one', () => {
    expect(peopleOf([lead, sheet])).toEqual({ names: ['Staff One', 'Staff Two'], teams: ['Infrastructure'], unassigned: 1 });
    expect(rolesOf(lead, 'Staff Two')).toEqual(['Responsible EPD']);
  });
});
