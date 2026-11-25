import type { CSSProperties } from 'react';

export interface TipRow {
  label: string;
  value: string;
}

/** What a mark's tooltip shows: a title and at most `MAX_TIP_ROWS` label and value rows. */
export interface Tip {
  title: string;
  rows: TipRow[];
}

export const MAX_TIP_ROWS = 4;

/** A tooltip row as callers build it; a falsy entry or an empty value is left out. */
export type TipRowInput = readonly [label: string, value: string | number | null | undefined] | null | undefined | false;

export function tipOf(title: string, rows: readonly TipRowInput[]): Tip {
  const kept = rows.flatMap((row) =>
    row && row[1] != null && row[1] !== '' ? [{ label: row[0], value: String(row[1]) }] : [],
  );
  return { title, rows: kept.slice(0, MAX_TIP_ROWS) };
}

/** "Title; Label: value; Label: value", the text form both pages use for `aria-label` and checks. */
export const tipText = (tip: Tip) => [tip.title, ...tip.rows.map((row) => `${row.label}: ${row.value}`)].join('; ');

/** Inline style of a mark, with custom properties such as `--pc` for its phase colour. */
export type MarkStyle = CSSProperties & Record<`--${string}`, string | number | undefined>;

/** The record behind an Overview mark; `DOC_LINKS` in overview-links.ts names the kinds that get a popup link. */
export type DocKind =
  | 'phase document'
  | 'decision document'
  | 'workplan'
  | 'extension order'
  | 'transition document'
  | 'source record'
  | 'work document';

/** One drawn mark on an Overview row; x positions are axis units, null for a mark not placed on the axis. */
export interface Mark {
  /** Space-separated classes; the mark-kind table matches on them. */
  cls: string;
  style: MarkStyle;
  tip: Tip | null;
  /** The popup's type line, in the legend's words. */
  type: string;
  docKind: DocKind;
  /** The popup link's address: a workplan record path or an eagle-admin document search; null for no link. */
  doc: string | null;
  x0: number | null;
  x1: number | null;
}

/** A bar waiting for its lane: `pri` and `s` order the placement, `x0`/`x1` in axis units, `draw` makes it at a lane top. */
export interface MarkUnit {
  pri: number;
  s: string;
  x0: number;
  x1: number;
  draw: (top: number) => Mark[];
}

/** What one row's marks found, counted while they are built; line 3 and the row's accessible name read it. */
export interface MarkNotes {
  undated: number;
  open: number;
  intr: number;
  faults: number;
  passed: number;
  hidden: number;
  oneDay: number;
  planned: boolean;
  moved: boolean;
  /** Screen px per axis unit at the drawn time scale, for lane fit at drawn size; 1 when not set. */
  kpx?: number;
  /** Bars not yet placed: `assessMarks` adds its phases, `laterMarks` adds its own and places them all. */
  units?: MarkUnit[];
  /** Track height in px once the bars are placed. */
  h?: number;
}
