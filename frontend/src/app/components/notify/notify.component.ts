import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ConfigService } from '../../services/config.service';
import { RegistryStateService } from '../../services/registry-state.service';

/** `GET staff/stats` — eagle-notify api/src/stats.js `summarise()`. */
export interface NotifyStats {
  subscribers: { confirmed: number; unconfirmed: number; unsubscribed: number };
  services: { serviceName: string; confirmed: number }[];
  confirmationsByDay: { day: string; count: number }[];
  bounces: { addresses: number; hard: number };
  sending: { usedThisHour: number; hourlyBudget: number };
  templates: number;
}

/** `GET staff/campaigns` row — eagle-notify api/src/campaigns.js `SUMMARY`. Fields absent from the document are absent here. */
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

const CAMPAIGN_PILL: Record<string, string> = {
  sending: 'pill--info',
  paused: 'pill--warning',
  done: 'pill--success'
};

/** Row from `GET staff/templates` — eagle-notify `api/src/template-store.js` `list()`. */
export interface NotifyTemplate {
  id: string;
  name: string;
  subject: string;
}

@Component({
  selector: 'app-notify',
  standalone: true,
  imports: [],
  templateUrl: './notify.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class NotifyComponent implements OnInit {
  private configService = inject(ConfigService);
  private registry = inject(RegistryStateService);

  stats = signal<NotifyStats | null>(null);
  campaigns = signal<NotifyCampaign[]>([]);
  /** Only the oldest sending campaign is actually moving; the rest are queued behind it. */
  activeId = signal<string | null>(null);

  loading = signal(true);
  error = signal('');
  httpStatus = signal(0);

  testTemplates = signal<NotifyTemplate[] | null>(null);
  selectedTestTemplateId = signal('');
  testSending = signal(false);
  testResult = signal<{ ok: boolean; message: string } | null>(null);

  readonly connection = computed(() => {
    if (this.loading()) return { label: 'Checking…', pill: 'pill--neutral' };
    if (!this.error()) return { label: 'Connected', pill: 'pill--success' };
    if (this.httpStatus() === 401) return { label: "Token's client not allowed on eagle-notify", pill: 'pill--warning' };
    if (this.httpStatus() === 403) return { label: 'No staff role', pill: 'pill--warning' };
    return { label: 'Unreachable', pill: 'pill--warning' };
  });

  /** `${NOTIFY_API_LOCATION}/api` — a proxy path in dev, an absolute origin when deployed. */
  get base(): string {
    return `${String(this.configService.config.NOTIFY_API_LOCATION || '').replace(/\/$/, '')}/api`;
  }

  get endpointHost(): string {
    try {
      const url = new URL(this.base, window.location.origin);
      return url.host + url.pathname;
    } catch {
      return this.base;
    }
  }

  async ngOnInit() {
    await this.registry.authReady;
    await this.load();
  }

  private async load() {
    this.loading.set(true);
    try {
      const [stats, campaigns] = await Promise.all([
        this.get<NotifyStats>('staff/stats'),
        this.get<{ campaigns: NotifyCampaign[]; activeId: string | null }>('staff/campaigns')
      ]);
      this.stats.set(stats);
      this.campaigns.set(campaigns.campaigns || []);
      this.activeId.set(campaigns.activeId ?? null);
      this.error.set('');
      this.httpStatus.set(200);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /** eagle-notify is its own service, so the app's fetch override does not attach the bearer for it. */
  private async get<T>(path: string): Promise<T> {
    const token = this.registry.keycloak?.token;
    const res = await fetch(`${this.base}/${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      this.httpStatus.set(res.status);
      const detail = body && (body.reason || body.error);
      throw new Error(`eagle-notify returned HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return body as T;
  }

  value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  /** Click handler for the header's "Send test email" button — loads the template list on first
   *  use, then sends the only template, or the selected one once a `<select>` has appeared. */
  async sendTestEmail() {
    if (this.testSending()) return;
    this.testResult.set(null);

    let list = this.testTemplates();
    if (list === null) {
      this.testSending.set(true);
      try {
        const res = await this.get<{ templates: NotifyTemplate[] }>('staff/templates');
        list = res.templates || [];
        this.testTemplates.set(list);
        if (list.length) this.selectedTestTemplateId.set(list[0].id);
      } catch (err) {
        this.testResult.set({ ok: false, message: (err as Error).message });
        return;
      } finally {
        this.testSending.set(false);
      }
      // Several templates: show the picker and wait for a deliberate send, rather than mailing
      // whichever one happened to sort first.
      if (list.length > 1) return;
    }

    if (list.length === 0) {
      this.testResult.set({ ok: false, message: 'No template to send' });
      return;
    }

    const id = list.length === 1 ? list[0].id : this.selectedTestTemplateId();
    await this.sendTest(id);
  }

  /** `POST staff/templates/{id}/test` — sends to the caller's own email (`user.email` from the
   *  token). Deliberately does not touch `httpStatus`: a 429/400 here is about this one send, not
   *  about eagle-notify's reachability, and must not flip the Connection pill. */
  private async sendTest(id: string) {
    this.testSending.set(true);
    const token = this.registry.keycloak?.token;
    try {
      const res = await fetch(`${this.base}/staff/templates/${id}/test`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const reason = body && body.error;
        const message =
          reason === 'send_budget_exhausted'
            ? 'Send budget exhausted, try later'
            : reason === 'no_email_claim'
              ? 'Your token has no email claim'
              : reason === 'not_found'
                ? 'Template not found'
                : `eagle-notify returned HTTP ${res.status}`;
        this.testResult.set({ ok: false, message });
        return;
      }
      this.testResult.set({ ok: true, message: `Sent to ${body.to}` });
    } catch (err) {
      this.testResult.set({ ok: false, message: (err as Error).message });
    } finally {
      this.testSending.set(false);
    }
  }

  figure(value: number | null | undefined): string {
    return typeof value === 'number' ? value.toLocaleString('en-CA') : '—';
  }

  when(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : d.toLocaleString('en-CA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  campaignPill(campaign: NotifyCampaign): string {
    return CAMPAIGN_PILL[campaign.status] || 'pill--neutral';
  }

  campaignStatus(campaign: NotifyCampaign): string {
    if (campaign.status !== 'sending') return campaign.status;
    return campaign.id === this.activeId() ? 'Sending' : 'Queued';
  }
}
