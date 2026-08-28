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
