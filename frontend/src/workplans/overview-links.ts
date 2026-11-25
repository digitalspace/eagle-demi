import { config } from '../config';
import type { DocKind } from './chart-types';
import { plusDays } from './phase-bounds';

/** Days after a decision or extension day that its documents are looked for. */
const AFTER_DAYS = 30;

/** Words of a mark's popup link; `external` opens eagle-admin in a new tab. A kind not listed gets no link. */
export const DOC_LINKS: Partial<Record<DocKind, { text: string; external: boolean }>> = {
  workplan: { text: 'View workplan', external: false },
  'phase document': { text: 'Find phase documents', external: true },
  'decision document': { text: 'Find decision documents', external: true },
  'extension order': { text: 'Find extension documents', external: true },
};

export interface DocLinkInput {
  kind: DocKind;
  /** Phase start, decision day or extension day. */
  start: string | null | undefined;
  /** Phase end, null while the phase is open; not read for a decision or an extension. */
  end?: string | null;
  act: number | null | undefined;
  projectId: string;
  eagleId: string | null | undefined;
  /** eagle-admin's base from `eagleAdminBase`; null means no eagle-admin link. */
  adminBase: string | null;
  today: string;
}

/**
 * Where a mark's popup link goes: the project's workplan record, or eagle-admin's document list filtered to the entry's
 * dates. Eagle documents carry no work or phase id, so the date window is the only filter. Null when there is no link.
 */
export function docHref({ kind, start, end = null, act, projectId, eagleId, adminBase, today }: DocLinkInput): string | null {
  if (kind === 'workplan') return act ? `/workplans/${encodeURIComponent(projectId)}?act=${act}` : null;
  // A window starting after today can match no document yet.
  if (!DOC_LINKS[kind] || !adminBase || !eagleId || !start || start > today) return null;
  const phase = kind === 'phase document';
  if (phase && end && end < start) return null;
  const to = phase ? end : plusDays(start, AFTER_DAYS);
  const dates = `;datePostedStart=${start}${to ? `;datePostedEnd=${to}` : ''}`;
  return `${adminBase}/p/${encodeURIComponent(eagleId)}/project-documents${dates}`;
}

/** `EAGLE_ADMIN_URL` without spaces or a trailing slash; null when it is empty or unset. */
export function eagleAdminBase(): string | null {
  const base = (config().EAGLE_ADMIN_URL ?? '').trim().replace(/\/+$/, '');
  return base || null;
}
