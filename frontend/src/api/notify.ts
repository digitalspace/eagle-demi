import { useQuery } from '@tanstack/react-query';
import { ApiError, api, notifyBase, type ApiInit } from './client';

/** `GET staff/stats` — eagle-notify api/src/stats.js `summarise()`. */
export interface NotifyStats {
  subscribers: { confirmed: number; unconfirmed: number; unsubscribed: number };
  services: { serviceName: string; confirmed: number }[];
  confirmationsByDay: { day: string; count: number }[];
  bounces: { addresses: number; hard: number };
  sending: { usedThisHour: number; hourlyBudget: number };
  templates: number;
}

/** `GET staff/campaigns` row — eagle-notify api/src/campaigns.js `SUMMARY`. Absent fields stay absent. */
export interface NotifyCampaign {
  id: string;
  status: string;
  serviceName?: string;
  serviceLabel?: string;
  templateName?: string;
  templateVersion?: number;
  audience?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
  startedAt?: string;
  createdAt?: string;
  createdBy?: string;
  lastSliceAt?: string;
  completedAt?: string;
  pausedBy?: string;
  pausedAt?: string;
}

/** Row from `GET staff/templates` — eagle-notify `api/src/template-store.js` `list()`. */
export interface NotifyTemplate {
  id: string;
  name: string;
  subject: string;
}

export interface NotifyOverview {
  stats: NotifyStats;
  campaigns: NotifyCampaign[];
  /** Only the oldest sending campaign is moving; the rest are queued behind it. */
  activeId: string | null;
}

export const NOTIFY_QUERY = ['notify', 'overview'];

/** `${NOTIFY_API_LOCATION}/api`, or null when no base this app will call is configured. */
export function notifyApiBase(): string | null {
  const base = notifyBase();
  return base && `${base}/api`;
}

/** The base as a host and path for the Connection panel, or '' when there is none. */
export function notifyEndpointHost(): string {
  const base = notifyApiBase();
  if (!base) return '';
  const url = new URL(base);
  return url.host + url.pathname;
}

/** eagle-notify's own `error` code, as the Angular app's notify screen (0038d3e) read it. */
function reasonOf(body: string): string {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' ? error : '';
  } catch {
    return '';
  }
}

/** Reasons this screen has wording for. Anything else shows the status alone. */
const NOTIFY_REASON: Record<string, string> = {
  send_budget_exhausted: 'Send budget exhausted, try later',
  no_email_claim: 'Your token has no email claim',
  not_found: 'Template not found',
};

/**
 * A known reason in this app's own words, or the bare status: eagle-notify's free text is another
 * service's output and never reaches the page.
 */
export function notifyMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  return NOTIFY_REASON[reasonOf(err.body)] ?? `eagle-notify returned HTTP ${err.status}`;
}

/** 0 when the request never reached eagle-notify, which reads as unreachable rather than refused. */
export function notifyStatus(err: unknown): number {
  return err instanceof ApiError ? err.status : 0;
}

/**
 * eagle-notify is a different host, so the token is attached by opt-in against that base rather
 * than by the client's own origin rule. Nothing else on this screen sends a bearer anywhere else.
 */
function notifyCall<T>(path: string, init: ApiInit = {}): Promise<T> {
  const base = notifyApiBase();
  if (!base) return Promise.reject(new Error('eagle-notify is not configured.'));
  return api<T>(`${base}/${path}`, { ...init, bearerFor: base });
}

/** Stats and campaigns arrive together, as one loading state and one error, as in the Angular app (0038d3e). */
export function useNotifyOverview() {
  return useQuery({
    queryKey: NOTIFY_QUERY,
    enabled: notifyApiBase() !== null,
    queryFn: async (): Promise<NotifyOverview> => {
      const [stats, campaigns] = await Promise.all([
        notifyCall<NotifyStats>('staff/stats'),
        notifyCall<{ campaigns: NotifyCampaign[]; activeId: string | null }>('staff/campaigns'),
      ]);
      return { stats, campaigns: campaigns.campaigns || [], activeId: campaigns.activeId ?? null };
    },
  });
}

export function listNotifyTemplates(): Promise<NotifyTemplate[]> {
  return notifyCall<{ templates: NotifyTemplate[] }>('staff/templates').then((res) => res.templates || []);
}

/** `POST staff/templates/{id}/test` — sends to the caller's own email (`user.email` from the token). */
export function sendTestEmail(id: string): Promise<{ to: string }> {
  return notifyCall<{ to: string }>(`staff/templates/${encodeURIComponent(id)}/test`, { method: 'POST' });
}
