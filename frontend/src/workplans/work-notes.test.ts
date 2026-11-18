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

  it.each([
    ['WITHDRAWN', 'Withdrawn'],
    ['TERMINATED', 'Terminated'],
    ['COMPLETED', null],
    ['CLOSED', null],
  ])('gives a Track work in state %s with no outcome %s', (workState, note) => {
    expect(closedNoteOf({ ...trackWork, outcome: null, workState })).toBe(note);
  });
});
