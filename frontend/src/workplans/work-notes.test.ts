import { describe, expect, it } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { closedNoteOf } from './work-notes';

const WORKS = FIXTURE.works as WorkplanRow[];
const sheetWork = WORKS.find((work) => work.source === 'sheet')!;
const trackWork = WORKS.find((work) => work.source === 'track')!;

describe('closedNoteOf', () => {
  it.each<[string, Partial<WorkplanRow>, string | null]>([
    ['outcome with the certificate kind', { outcome: 'Certificate Issued', certificateKind: 'PAC' }, 'Certificate Issued (PAC)'],
    ['outcome alone when the kind is not sent', { outcome: 'Approved', certificateKind: undefined }, 'Approved'],
    ['a move to a later Act', { outcome: null, workState: 'transitioned', transitionOut: { toActYear: 2002, date: null } }, 'Moved to the 2002 Act'],
    ['an inactive sheet work', { outcome: null, workState: 'inactive' }, 'Inactive'],
    ['nothing for a sheet work still under way', { outcome: null, workState: 'in-progress' }, null],
  ])('gives %s', (_case, change, note) => {
    expect(closedNoteOf({ ...sheetWork, ...change })).toBe(note);
  });

  it('gives nothing for a Track work with no outcome, whatever its state', () => {
    expect(closedNoteOf({ ...trackWork, outcome: null, workState: 'completed' })).toBeNull();
  });
});
