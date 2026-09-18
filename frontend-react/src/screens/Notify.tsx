import { useState, type CSSProperties } from 'react';
import {
  listNotifyTemplates,
  notifyApiBase,
  notifyEndpointHost,
  notifyMessage,
  notifyStatus,
  sendTestEmail,
  useNotifyOverview,
  type NotifyCampaign,
  type NotifyTemplate,
} from '../api/notify';

const CAMPAIGN_PILL: Record<string, string> = {
  sending: 'pill--info',
  paused: 'pill--warning',
  done: 'pill--success',
};

const SKELETON_ROWS = [1, 2, 3, 4];

const titleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--layout-margin-small)',
  flexWrap: 'wrap',
};

const titleActions: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--layout-margin-small)',
  flexWrap: 'wrap',
};

const templateSelect: CSSProperties = {
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  font: 'var(--typography-regular-small-body)',
  padding: '0.35rem 0.6rem',
  background: 'var(--surface-color-background-white)',
};

const sendButton: CSSProperties = {
  background: 'var(--surface-color-primary-default)',
  color: 'var(--surface-color-background-white)',
  border: 'none',
  borderRadius: 'var(--layout-border-radius-small)',
  padding: '0.4rem 0.9rem',
  font: 'var(--typography-bold-small-body)',
  cursor: 'pointer',
};

function figure(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en-CA') : '—';
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-CA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Skeleton({ width }: { width: string }) {
  return <span className="skeleton skeleton--text" style={{ width }} aria-hidden="true" />;
}

const HEADER = (
  <div className="screen-header">
    <div className="screen-header__text">
      <h1>eagle-notify</h1>
      <p>
        EPIC&apos;s subscription and notification service — consent, digests and campaigns — sending over Azure
        Communication Services Email.
      </p>
    </div>
  </div>
);

export function Notify() {
  const query = useNotifyOverview();
  const loading = query.isPending;
  const error = query.error ? notifyMessage(query.error) : '';
  const httpStatus = query.error ? notifyStatus(query.error) : 200;

  const stats = query.data?.stats;
  const campaigns = query.data?.campaigns ?? [];
  const activeId = query.data?.activeId ?? null;

  /** null until the list has been asked for once, which is what the first click does. */
  const [templates, setTemplates] = useState<NotifyTemplate[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function connection(): { label: string; pill: string } {
    if (loading) return { label: 'Checking…', pill: 'pill--neutral' };
    if (!error) return { label: 'Connected', pill: 'pill--success' };
    if (httpStatus === 401) return { label: "Token's client not allowed on eagle-notify", pill: 'pill--warning' };
    if (httpStatus === 403) return { label: 'No staff role', pill: 'pill--warning' };
    return { label: 'Unreachable', pill: 'pill--warning' };
  }

  /**
   * Loads the template list on first use, then sends the only template, or the selected one once a
   * `<select>` has appeared: several templates wait for a deliberate send rather than mailing
   * whichever one happened to sort first.
   */
  async function onSend() {
    if (sending) return;
    setResult(null);

    let list = templates;
    if (list === null) {
      setSending(true);
      try {
        list = await listNotifyTemplates();
        setTemplates(list);
        if (list.length) setSelectedId(list[0].id);
      } catch (err) {
        setResult({ ok: false, message: notifyMessage(err) });
        return;
      } finally {
        setSending(false);
      }
      if (list.length > 1) return;
    }

    if (list.length === 0) {
      setResult({ ok: false, message: 'No template to send' });
      return;
    }

    await send(list.length === 1 ? list[0].id : selectedId);
  }

  /**
   * Deliberately does not touch the connection pill: a 429 or 400 here is about this one send, not
   * about whether eagle-notify is reachable.
   */
  async function send(id: string) {
    setSending(true);
    try {
      const body = await sendTestEmail(id);
      setResult({ ok: true, message: `Sent to ${body.to}` });
    } catch (err) {
      setResult({ ok: false, message: notifyMessage(err) });
    } finally {
      setSending(false);
    }
  }

  function campaignPill(campaign: NotifyCampaign): string {
    return CAMPAIGN_PILL[campaign.status] || 'pill--neutral';
  }

  function campaignStatus(campaign: NotifyCampaign): string {
    if (campaign.status !== 'sending') return campaign.status;
    return campaign.id === activeId ? 'Sending' : 'Queued';
  }

  // No base this app will call: nothing is asked for, so there is nothing to show but why.
  if (notifyApiBase() === null) {
    return (
      <>
        {HEADER}
        <div className="callout callout--warning">
          No eagle-notify service is set for this environment, so nothing was asked for.
        </div>
      </>
    );
  }

  const status = connection();

  return (
    <>
      {HEADER}

      {error && <div className="callout callout--warning">{error}</div>}

      <div className="stat-grid" aria-busy={loading ? 'true' : undefined}>
        <div className="stat-card">
          <div className="micro-label">Confirmed subscribers</div>
          <div className="stat-card__value">
            {loading ? <Skeleton width="3.5rem" /> : figure(stats?.subscribers?.confirmed)}
          </div>
          <div className="stat-card__note">clicked the confirmation link</div>
        </div>
        <div className="stat-card">
          <div className="micro-label">Unconfirmed</div>
          <div className="stat-card__value">
            {loading ? <Skeleton width="3.5rem" /> : figure(stats?.subscribers?.unconfirmed)}
          </div>
          <div className="stat-card__note">asked to subscribe, never confirmed</div>
        </div>
        <div className="stat-card">
          <div className="micro-label">Bounced addresses</div>
          <div className="stat-card__value">
            {loading ? <Skeleton width="3.5rem" /> : figure(stats?.bounces?.addresses)}
          </div>
          <div className="stat-card__note">
            {loading ? (
              <Skeleton width="6rem" />
            ) : (
              `${figure(stats?.bounces?.hard)} hard — a hard bounce unsubscribes the address`
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="micro-label">Sends this hour</div>
          <div className="stat-card__value">
            {loading ? (
              <Skeleton width="5rem" />
            ) : (
              `${figure(stats?.sending?.usedThisHour)} / ${figure(stats?.sending?.hourlyBudget)}`
            )}
          </div>
          <div className="stat-card__note">one budget, shared with confirmation mail</div>
        </div>
      </div>

      <section className="panel">
        <h2 className="panel__title" style={titleRow}>
          <span>Connection</span>
          <span style={titleActions}>
            {templates && templates.length > 1 && (
              <select
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
                aria-label="Template to test"
                style={templateSelect}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" disabled={sending} onClick={onSend} style={sendButton}>
              {sending ? 'Sending…' : 'Send test email'}
            </button>
          </span>
        </h2>
        {result && (
          <div style={{ padding: 'var(--layout-padding-small) var(--layout-padding-large) 0' }}>
            <span className={`pill ${result.ok ? 'pill--success' : 'pill--warning'}`}>{result.message}</span>
          </div>
        )}
        <div className="row-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
          <div>
            <div className="micro-label">Endpoint</div>
            <div className="row-grid__figure">
              <code className="cell__mono" style={{ overflowWrap: 'anywhere' }}>
                {notifyEndpointHost()}
              </code>
            </div>
          </div>
          <div>
            <div className="micro-label">Status</div>
            <div style={{ marginTop: 2 }}>
              <span className={`pill ${status.pill}`}>{status.label}</span>
            </div>
          </div>
          <div>
            <div className="micro-label">Credential</div>
            <div className="row-grid__figure">Keycloak bearer token</div>
          </div>
          <div>
            <div className="micro-label">Templates</div>
            <div className="row-grid__figure">{loading ? <Skeleton width="2.5rem" /> : figure(stats?.templates)}</div>
          </div>
        </div>
      </section>

      <section className="panel panel--scroll" aria-busy={loading ? 'true' : undefined}>
        <h2 className="panel__title">Services</h2>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th className="cell--right" style={{ width: '12rem' }}>
                Confirmed subscribers
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td>
                  <Skeleton width="10rem" />
                </td>
                <td className="cell--right">
                  <Skeleton width="3rem" />
                </td>
              </tr>
            ) : stats?.services?.length ? (
              stats.services.map((service) => (
                <tr key={service.serviceName}>
                  <td>{service.serviceName}</td>
                  <td className="cell--right cell--figures">{figure(service.confirmed)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={2} className="cell--muted">
                  No service has a confirmed subscriber.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel panel--scroll" aria-busy={loading ? 'true' : undefined}>
        <h2 className="panel__title">Recent sends</h2>
        {loading && <p className="visually-hidden">Loading campaigns…</p>}
        <table style={{ minWidth: '46rem' }}>
          <thead>
            <tr>
              <th style={{ width: '11rem' }}>Created</th>
              <th>Template</th>
              <th style={{ width: '8rem' }}>Audience</th>
              <th style={{ width: '9rem' }}>Sent / failed</th>
              <th style={{ width: '9rem' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length ? (
              campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td className="cell--muted cell--nowrap">{when(campaign.createdAt)}</td>
                  <td>
                    <div className="cell__title">{campaign.templateName || campaign.id}</div>
                    <div className="cell__sub">
                      {campaign.serviceLabel || campaign.serviceName || '—'}
                      {campaign.templateVersion ? ` · v${campaign.templateVersion}` : ''}
                    </div>
                  </td>
                  <td className="cell--figures">{figure(campaign.audience)}</td>
                  <td className="cell--figures">
                    {figure(campaign.sent)} / {figure(campaign.failed)}
                  </td>
                  <td className="cell--nowrap">
                    <span className={`pill ${campaignPill(campaign)}`}>{campaignStatus(campaign)}</span>
                  </td>
                </tr>
              ))
            ) : loading ? (
              SKELETON_ROWS.map((row) => (
                <tr key={row} aria-hidden="true">
                  <td>
                    <Skeleton width="7rem" />
                  </td>
                  <td>
                    <div className="cell__title">
                      <Skeleton width="60%" />
                    </div>
                    <div className="cell__sub">
                      <Skeleton width="40%" />
                    </div>
                  </td>
                  <td>
                    <Skeleton width="3.5rem" />
                  </td>
                  <td>
                    <Skeleton width="4.5rem" />
                  </td>
                  <td>
                    <span className="pill" style={{ padding: 0 }}>
                      <Skeleton width="3.5rem" />
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="cell--muted">
                  No campaigns have been created.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="footnote">
        DEMI holds no mailing list of its own. Subscriptions, suppression and templates live in eagle-notify; DEMI
        supplies the event and the recipient query.
      </p>
    </>
  );
}
