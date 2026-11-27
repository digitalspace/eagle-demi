import type { ActYear } from './chart-facts';
import { plural } from './format';
import type { ActRow, RowFacts } from './overview-rows';

/** An alert tag: red for a problem, yellow for a data conflict. */
export interface RowTag {
  text: string;
  /** Screen reader wording. */
  say: string;
  tone: 'red' | 'yellow';
}

/** The row's anchor id, so "Also YYYY Act" links can jump to it. */
export const rowId = (year: number, projectId: string) => `row-${year}-${projectId}`;

/** Every Act the row's project has work under, oldest first; the row's own Act is one of them. */
const yearsOf = (row: ActRow) =>
  [...new Set(row.project.works.map((work) => work.actYear))].filter((y): y is ActYear => y !== null).sort();

function alertsOf(facts: RowFacts, today: string): RowTag[] {
  const tags: RowTag[] = [];
  if (facts.next && facts.next < today) {
    tags.push({ text: 'Decision overdue', say: `Planned decision date passed: ${facts.next}`, tone: 'red' });
  }
  if (facts.faults) {
    tags.push({ text: 'Dates conflict', say: plural(facts.faults, 'phase ends before it starts', 'phases end before they start'), tone: 'yellow' });
  }
  return tags;
}

/** The tags line: the over limit or over plan tag, "Decision overdue", then "Dates conflict". */
export const rowTags = (facts: RowFacts, today: string): RowTag[] => [
  ...(facts.tail ? [{ text: facts.tail, say: facts.tail, tone: 'red' as const }] : []),
  ...alertsOf(facts, today),
];

/** One entry of the Acts line: the row's own Act, or a link to the project's row under another. */
export interface ActEntry {
  year: ActYear;
  current: boolean;
  say: string;
}

/** The Acts line, "Acts: 2002, 2018"; null when the project has work under one Act only. */
export function rowActs(row: ActRow, name: string): { label: string; acts: ActEntry[] } | null {
  const years = yearsOf(row);
  if (years.length < 2) return null;
  return {
    label: `${name} has work under the ${years.join(', ')} Acts`,
    acts: years.map((year) => ({
      year,
      current: year === row.year,
      say: year === row.year ? `This section: ${year} Act` : `Go to ${name} under the ${year} Act`,
    })),
  };
}

/** Line 3 status: the parts line 2 does not already say, then the work count. */
function statusLine(status: readonly string[], l2: string, workCount: number): string {
  const l2low = l2.toLowerCase();
  return status
    .filter((part) => !l2low.includes(part.toLowerCase()))
    .concat([plural(workCount, 'work')])
    .map((part, i) => (i ? part.charAt(0).toLowerCase() + part.slice(1) : part))
    .join(', ');
}

export interface RowAriaParts {
  name: string;
  row: ActRow;
  facts: RowFacts;
  /** Works the row shows. */
  workCount: number;
  /** Phases with no recorded date, from the row's marks. */
  undated: number;
  today: string;
}

/** The row link's accessible name: line 2, the assessment status, the Acts and tags lines, and what only the marks show. */
export function rowAria({ name, row, facts, workCount, undated, today }: RowAriaParts): string {
  // The Acts line already says which Act the work came from.
  const status = statusLine(row.status.filter((part) => !/^From \d{4} Act$/.test(part)), facts.l2, workCount);
  const years = yearsOf(row);
  const said = (years.length > 1 ? [`Has work under the ${years.join(', ')} Acts`] : []).concat(rowTags(facts, today).map((tag) => tag.say));
  if (undated) said.push(plural(undated, 'phase with no recorded date', 'phases with no recorded date'));
  return [`Open ${name}, ID ${row.project.projectId}, ${row.year} Act`, facts.full, status, ...said].join('. ');
}
