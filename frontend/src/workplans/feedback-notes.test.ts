import { describe, expect, it } from 'vitest';
import { workOf } from './__tests__/works';
import { workStateText } from './record-header';
import { candidatesOf, projectsOf } from './overview-rows';
import { eventList } from './record-event-list';
import type { RecordEvent } from './record-events';

const TODAY = '2026-11-17';

describe('search by work name', () => {
  const works = [
    workOf([], { workId: 'a', projectId: '1', projectName: 'Eskay Creek', title: 'Eskay Creek - Assessment', workTypeCode: 'assessment', workType: 'Assessment', actYear: 2018 }),
    workOf([], { workId: 'b', projectId: '1', projectName: 'Eskay Creek', title: 'Eskay Creek - Tailings Amendment', workTypeCode: 'amendment', workType: 'Amendment', actYear: 2018 }),
  ];
  const rows = projectsOf(works).map((project) => ({ project, all: project.works }));

  it('keeps every work of a project found by its name', () => {
    const found = candidatesOf(rows as never, 'eskay', new Set(), TODAY);
    expect(found[0].works).toHaveLength(2);
  });

  it('keeps only the matching works of a project found by a work name', () => {
    const found = candidatesOf(rows as never, 'tailings', new Set(), TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].works.map((w) => w.workId)).toEqual(['b']);
  });

  it('finds nothing for text in no project or work', () => {
    expect(candidatesOf(rows as never, 'zzz', new Set(), TODAY)).toHaveLength(0);
  });

  it('finds a work by its type when its name does not say it', () => {
    const dam = workOf([], { workId: 'c', projectId: '2', projectName: 'Red Chris', title: 'Red Chris - Tailings Dam', workTypeCode: 'amendment', workType: 'Amendment', actYear: 2018 });
    const typed = projectsOf([dam]).map((project) => ({ project, all: project.works }));
    expect(candidatesOf(typed as never, 'amendment', new Set(), TODAY).map((c) => c.name)).toEqual(['Red Chris']);
  });
});

describe('labels from the feedback', () => {
  it('says the work state, and active or inactive only for an open Track work', () => {
    expect(workStateText(workOf([], { source: 'track', workState: 'IN_PROGRESS', isActive: true }))).toBe('In progress, active');
    expect(workStateText(workOf([], { source: 'track', workState: 'IN_PROGRESS', isActive: false }))).toBe('In progress, inactive');
    expect(workStateText(workOf([], { source: 'track', workState: 'COMPLETED', isActive: false }))).toBe('Completed');
    expect(workStateText(workOf([], { source: 'sheet', workState: 'suspended', isActive: true }))).toBe('Suspended');
  });
});

describe('events as one list', () => {
  const ev = (over: Partial<RecordEvent>): RecordEvent =>
    ({ d: 10, e: null, c: 'ms', name: 'Event', date: '2020-01-01', count: 1, id: 'x', g: 'g dia', hasMark: true, step: null, len: '', kind: 'Milestone', ...over }) as RecordEvent;
  const step = { id: 's1', name: 'Early Engagement', sw: {}, glyph: '' } as never;
  const events = {
    items: [
      ev({ id: 'b', d: 30, name: 'Later', step }),
      ev({ id: 'a', d: 20, name: 'Earlier', date: '2020-01-01, planned, date passed', step }),
      ev({ id: 'c', d: null, name: 'Undated' }),
      ev({ id: 'd', d: 25, c: 'dec', name: 'A decision' }),
    ],
    later: [],
    hasAssessment: true,
    laterWorks: 0,
    hasCert: false,
  };

  it('lists the entries in date order with undated last, whatever their phase', () => {
    const view = eventList(events, ['dec', 'cp', 'sub', 'ms', 'oth'], false);
    expect(view.rows.map((r) => r.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(view.after).toBeNull();
  });

  it('names the phase on the row and turns a passed planned date into a tag', () => {
    const [first] = eventList(events, ['ms'], false).rows;
    expect(first.phase?.name).toBe('Early Engagement');
    expect(first.date).toBe('2020-01-01');
    expect(first.tag).toBe('Date passed');
  });

  it('names no phase for a comment period, even one inside a phase', () => {
    const cp = { ...events, items: [ev({ id: 'p', c: 'cp', name: 'Public comment', step })] };
    expect(eventList(cp, ['cp'], false).rows.map((r) => r.phase)).toEqual([null]);
  });

  it('drops filtered entries without leaving a placeholder', () => {
    expect(eventList(events, ['dec'], false).rows.map((r) => r.id)).toEqual(['d']);
  });
});
