import { describe, expect, it } from 'vitest';
import { docHref, type DocLinkInput } from './overview-links';

const BASE: DocLinkInput = {
  kind: 'phase document',
  start: '2026-01-01',
  end: '2026-03-01',
  act: 2018,
  projectId: '950',
  eagleId: 'e950',
  adminBase: 'https://admin.example.invalid/admin',
  today: '2026-11-17',
};

describe('docHref', () => {
  it('opens the project record under its Act for a workplan mark, and nothing without an Act', () => {
    expect(docHref({ ...BASE, kind: 'workplan' })).toBe('/workplans/950?act=2018');
    expect(docHref({ ...BASE, kind: 'workplan', act: null })).toBeNull();
  });

  it('searches eagle-admin documents posted inside a phase', () => {
    expect(docHref(BASE)).toBe('https://admin.example.invalid/admin/p/e950/project-documents;datePostedStart=2026-01-01;datePostedEnd=2026-03-01');
  });

  it('searches an open phase from its start only', () => {
    expect(docHref({ ...BASE, end: null })).toBe('https://admin.example.invalid/admin/p/e950/project-documents;datePostedStart=2026-01-01');
  });

  it('searches the 30 days after a decision', () => {
    expect(docHref({ ...BASE, kind: 'decision document', start: '2026-01-15', end: undefined })).toBe(
      'https://admin.example.invalid/admin/p/e950/project-documents;datePostedStart=2026-01-15;datePostedEnd=2026-02-14',
    );
  });

  it('gives no eagle-admin link without an Eagle id, without a base, or for a window that starts after today', () => {
    expect(docHref({ ...BASE, eagleId: null })).toBeNull();
    expect(docHref({ ...BASE, adminBase: null })).toBeNull();
    expect(docHref({ ...BASE, start: '2026-11-18', end: null })).toBeNull();
  });

  it('gives no link for a kind without one', () => {
    expect(docHref({ ...BASE, kind: 'source record' })).toBeNull();
  });
});
