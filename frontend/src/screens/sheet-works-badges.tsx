import { useMemo, useState, type ReactNode } from 'react';
import { useSheetWorksSummary, type SheetWorksSummary } from '../api/sheet-works';
import type { Project } from '../api/types';

/** One pill after a project's name in the picker. */
export interface Badge {
  key: string;
  tone: 'info' | 'warning';
  content: ReactNode;
}

type Summary = SheetWorksSummary | undefined;

/** Works the public read would hide, swap in for a Track work, or show only until Track has one. */
const switchCases = (summary: Summary) =>
  summary ? summary.hidden + summary.replaces + summary.untilTrack : 0;

const SHOW_OPTIONS: { key: string; label: string; keep: (summary: Summary) => boolean }[] = [
  { key: 'all', label: 'All projects', keep: () => true },
  { key: 'any', label: 'With sheet works', keep: (summary) => sheetWorksBadges(summary).length > 0 },
  { key: '1996', label: '1996 Act works', keep: (summary) => Boolean(summary?.act1996) },
  { key: '2002', label: '2002 Act works', keep: (summary) => Boolean(summary?.act2002) },
  { key: 'switch', label: 'Switch cases', keep: (summary) => switchCases(summary) > 0 },
];

function breakdown({ hidden, replaces, untilTrack }: SheetWorksSummary): string {
  return [
    hidden && `${hidden} hidden when the public site shows sheet works`,
    replaces && (replaces === 1 ? '1 replaces a Track work' : `${replaces} replace Track works`),
    untilTrack && `${untilTrack} shown until Track has it`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Act pills, then one marker whose count matches the pills on the project's details page. */
function sheetWorksBadges(summary: Summary): Badge[] {
  if (!summary) return [];
  const badges: Badge[] = [];
  if (summary.act1996) badges.push({ key: 'act1996', tone: 'info', content: `1996 Act (${summary.act1996})` });
  if (summary.act2002) badges.push({ key: 'act2002', tone: 'info', content: `2002 Act (${summary.act2002})` });
  const cases = switchCases(summary);
  if (cases) {
    badges.push({
      key: 'switch',
      tone: 'warning',
      content: (
        <>
          Switch cases ({cases})<span className="visually-hidden">: {breakdown(summary)}</span>
        </>
      ),
    });
  }
  return badges;
}

/**
 * Sheet work badges and the "Show" filter for the Project details picker. Until the summary loads,
 * and whenever it fails, there are no badges and no control.
 */
export function useSheetWorksView() {
  const summary = useSheetWorksSummary();
  const [show, setShow] = useState('all');

  return useMemo(() => {
    const of = (row: Project) => summary.get(String(row.id));
    const option = SHOW_OPTIONS.find((candidate) => candidate.key === show)!;
    const ready = summary.size > 0;
    return {
      badgesFor: (row: Project) => sheetWorksBadges(of(row)),
      keep: ready && show !== 'all' ? (row: Project) => option.keep(of(row)) : undefined,
      control: ready ? (
        <div style={{ marginTop: 'var(--layout-margin-small)' }}>
          <label htmlFor="pp-show" className="micro-label" style={{ marginRight: 'var(--layout-margin-xsmall)' }}>
            Show
          </label>
          <select id="pp-show" value={show} onChange={(event) => setShow(event.target.value)}>
            {SHOW_OPTIONS.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
      ) : null,
    };
  }, [summary, show]);
}
