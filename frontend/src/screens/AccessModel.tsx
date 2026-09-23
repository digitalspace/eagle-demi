import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { simulateAccess, type SimulateField, type SimulateRequest, type SimulateResponse } from '../api/access';
import { config } from '../config';
import { useSession } from '../session/session';

/**
 * Realm roles the engine understands. `team` and `idir` are deliberately absent: `rolesFor` strips
 * both from a real token, so offering them here would let the screen forge a ladder token.
 */
const ROLE_OPTIONS: { key: string; note: string; locked?: boolean }[] = [
  { key: 'public', note: 'Resolved onto every caller — the floor of the ladder.', locked: true },
  { key: 'staff', note: 'Matches the staff token, which levels 2, 3 and 4 all carry.' },
  { key: 'sysadmin', note: 'Row-plane superuser: every ladder row, no sealed row.' },
  { key: 'demi-admin', note: 'Row-plane superuser.' },
  { key: 'demi-service-read', note: 'Service account. Privileged for reads, holds no write role.' },
  { key: 'demi-service-write', note: 'Service account. Privileged, and permitted to write.' },
  { key: 'compliance', note: 'Reads sealed level-0 rows, only through /api/sealed. Not a ladder rung.' },
];

/** The ladder as docs/rbac-architecture.md §1 states it. The stored `read[]` comes from the engine. */
const LADDER = [
  {
    level: 1,
    name: 'Team only',
    detail: 'Reached only through the team arm: the row carries team and its project is one of the caller’s.',
  },
  { level: 2, name: 'All EAO', detail: 'Every EAO staff member, any project or business unit.' },
  {
    level: 3,
    name: 'All IDIR',
    detail: 'Any BC Government IDIR account. idir comes from the identity_provider claim, never a role.',
  },
  { level: 4, name: 'Public', detail: 'Anyone, no credential.' },
];

const IDENTITY_PROVIDERS = [
  { value: '', label: 'None', note: 'No identity provider claim.' },
  { value: 'idir', label: 'IDIR', note: 'The only provider that moves a caller to level 3.' },
  { value: 'bceid', label: 'BCeID', note: 'Where a Selected Credential holder signs in. Never level 3.' },
];

/** What moves a record between levels. Row plane only — none of it touches the field catalog. */
const LEVEL_CHANGES = [
  {
    dot: 'attention-row__dot--warning',
    title: 'Publishing to level 4',
    detail:
      'PUT /:id/level with confirm: true and a reason. Without either it answers 400. Audited as record.widen.',
  },
  {
    dot: 'attention-row__dot--danger',
    title: 'Pulling back from level 4',
    detail:
      'sysadmin only, audited as record.takedown, and handled as incident response — a routine correction publishes a replacement instead.',
  },
  {
    dot: 'attention-row__dot--info',
    title: 'Holding a Selected Credential',
    detail: 'One extra OR arm for the named party at levels 1–3. It changes no record’s level and no field.',
  },
];

const CREDENTIAL_LEVELS = [1, 2, 3];

/** Every keystroke re-asks the engine, so the ask waits for the typing to stop. */
const SIMULATE_DEBOUNCE_MS = 150;

const fieldset: CSSProperties = { border: 0, margin: 0, padding: 0 };

const checkRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.6rem',
  cursor: 'pointer',
  padding: '3px 0',
};

const smallTextInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.45rem 0.6rem',
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  font: 'var(--typography-regular-small-body)',
  marginTop: 4,
};

const legend: CSSProperties = { padding: 0, marginBottom: 'var(--layout-margin-xsmall)' };

const checkboxTop: CSSProperties = { marginTop: 4 };

/** "402, 111" → ['402', '111']. Blanks dropped so a trailing comma is not an empty id. */
function idList(text: string): string[] {
  return text
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

interface Catalog {
  rows: (SimulateField & { notable: boolean })[];
  caption: string;
}

function catalog(answer: SimulateResponse | null, entity: 'projects' | 'documents', showPlumbing: boolean): Catalog {
  const all = answer?.fields?.[entity] ?? [];
  const rows = (showPlumbing ? all : all.filter((field) => field.maxVis > 0))
    // Most fields are 4/4 with no predicate. Tinting the rest is what makes the exceptions
    // findable in a catalog of sixty.
    .map((field) => ({ ...field, notable: field.defaultVis !== 4 || field.maxVis !== 4 || !!field.when }));
  const hidden = all.length - rows.length;
  return {
    rows,
    caption:
      `${rows.filter((field) => field.visible).length} of ${rows.length} returned` +
      (hidden > 0 ? ` · ${hidden} plumbing key${hidden === 1 ? '' : 's'} hidden` : ''),
  };
}

interface Rung {
  level: number;
  name: string;
  detail: string;
  read: string[];
  heading: string;
  readable: boolean;
  dotClass: string;
  pillClass: string;
  verdict: string;
  via: string | null;
}

function ladderRows(answer: SimulateResponse | null): Rung[] {
  const rows = answer?.rows ?? {};
  return LADDER.map((rung) => {
    const row = rows[String(rung.level)];
    const readable = !!row?.readable;
    return {
      ...rung,
      read: row?.read ?? [],
      heading: `Level ${rung.level} — ${rung.name}`,
      readable,
      dotClass: readable ? 'attention-row__dot--success' : 'attention-row__dot--neutral',
      pillClass: readable ? 'pill pill--success' : 'pill pill--neutral',
      verdict: readable ? 'Readable' : 'Withheld',
      via: row?.via ? `via ${row.via}` : null,
    };
  });
}

export function AccessModel() {
  // Described caller.
  const [roles, setRoles] = useState<Record<string, boolean>>({ public: true });
  const [identityProvider, setIdentityProvider] = useState('');
  const [teamsText, setTeamsText] = useState('');
  const [scopeText, setScopeText] = useState('');
  const [credentialOn, setCredentialOn] = useState(false);
  const [credentialType, setCredentialType] = useState<'project' | 'document'>('project');
  const [credentialIdsText, setCredentialIdsText] = useState('');
  const [credentialLevels, setCredentialLevels] = useState<Record<number, boolean>>({ 2: true });

  const [showPlumbing, setShowPlumbing] = useState(false);

  /** The real caller, from the session that already asked `/me` — never re-fetched here. */
  const realm = config().KEYCLOAK_REALM || '—';
  const { level: yourLevel, isStaff: yourStaffUi, authenticated: signedIn } = useSession();

  /** The request body for the described caller. Optional keys are omitted, not sent empty. */
  const body = useMemo<SimulateRequest>(() => {
    const request: SimulateRequest = { roles: ROLE_OPTIONS.filter((r) => roles[r.key]).map((r) => r.key) };

    if (identityProvider) request.identityProvider = identityProvider;

    const teams = idList(teamsText);
    if (teams.length > 0) request.teams = teams;

    // Sent only when asked for: `projectScope` present at all makes the tier `scoped`, so a text
    // box holding nothing but separators must not describe a caller scoped to no project.
    const scope = idList(scopeText);
    if (scope.length > 0) request.projectScope = scope;

    // A ticked box with no ids or no levels is a half-typed credential, not a caller to refuse:
    // leave it out until it is complete, so the answer stays on screen while the user types.
    const credentialIds = idList(credentialIdsText);
    const levels = CREDENTIAL_LEVELS.filter((l) => credentialLevels[l]);
    if (credentialOn && credentialIds.length > 0 && levels.length > 0) {
      request.credential = { scope: { type: credentialType, ids: credentialIds }, levels };
    }
    return request;
  }, [roles, identityProvider, teamsText, scopeText, credentialOn, credentialType, credentialIdsText, credentialLevels]);

  /** The body the last keystroke settled on. Null until the first debounce fires. */
  const [settled, setSettled] = useState<SimulateRequest | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(body), SIMULATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [body]);

  // Every input change re-asks the engine; nothing on this screen is computed from a local copy of
  // the rules. The bearer token is attached by the API client, which owns every Authorization
  // header the app sends to its own API.
  const query = useQuery({
    queryKey: ['access-simulate', settled],
    queryFn: () => simulateAccess(settled as SimulateRequest),
    enabled: signedIn && settled !== null,
    // A refusal is an answer too — the registry would refuse this caller's credential — so the
    // stale result is dropped rather than left on screen under a new description.
    placeholderData: keepPreviousData,
  });

  const error = query.error ? query.error.message : null;
  const answer = error ? null : (query.data ?? null);
  const loading = signedIn && (settled === null || query.isFetching);

  const rungs = ladderRows(answer);
  const projectFields = catalog(answer, 'projects', showPlumbing);
  const documentFields = catalog(answer, 'documents', showPlumbing);

  /** One sentence for the live region: the whole answer, without reading every table row aloud. */
  const summary = (() => {
    if (!answer) return 'Asking the access engine…';
    const levels = rungs.filter((rung) => rung.readable).map((rung) => rung.level);
    return (
      `Level ${answer.level}, tier ${answer.tier}. ` +
      (levels.length ? `Reads records at level ${levels.join(', ')}. ` : 'Reads no records. ') +
      `${projectFields.rows.filter((f) => f.visible).length} project fields and ` +
      `${documentFields.rows.filter((f) => f.visible).length} document fields returned.`
    );
  })();

  const sealedNote = answer?.notes?.sealedCompartment ?? null;

  const toggleRole = (key: string) => setRoles({ ...roles, [key]: !roles[key] });
  const toggleCredentialLevel = (level: number) =>
    setCredentialLevels({ ...credentialLevels, [level]: !credentialLevels[level] });

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>Access model</h1>
          <p>
            Describe a caller and the registry answers what it could read. Every line below comes from the access
            engine itself — this screen keeps no second copy of the rules.
          </p>
        </div>
      </div>

      {!signedIn && (
        <div className="callout callout--warning" role="status">
          <p>
            <strong>Sign in to run the simulator.</strong> Asking the engine about a caller is itself a staff
            request: <code className="cell__mono">POST /api/access/simulate</code> answers 401 without a DEMI
            session. The rules on this page hold either way — only the answer for a described caller needs a
            session.
          </p>
        </div>
      )}

      {signedIn && (
        <>
          <section className="panel panel--padded">
            <h2 className="panel__title panel__title--inline">Describe a caller</h2>
            <p className="panel__lede">
              Nothing here signs anyone in or grants you anything: the body describes somebody else, and the engine
              reads no data to answer it.
            </p>

            <div
              style={{
                display: 'grid',
                gap: 'var(--layout-margin-large)',
                gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
              }}
            >
              <fieldset style={fieldset}>
                <legend className="micro-label" style={legend}>
                  Realm roles
                </legend>
                {ROLE_OPTIONS.map((role) => (
                  <div key={role.key} style={checkRow}>
                    <input
                      type="checkbox"
                      id={`role-${role.key}`}
                      checked={!!roles[role.key]}
                      disabled={!!role.locked}
                      aria-describedby={`role-note-${role.key}`}
                      onChange={() => toggleRole(role.key)}
                      style={checkboxTop}
                    />
                    <span>
                      <label className="cell__title" htmlFor={`role-${role.key}`} style={{ cursor: 'pointer' }}>
                        <code className="cell__mono">{role.key}</code>
                      </label>
                      <span className="cell__sub" style={{ display: 'block' }} id={`role-note-${role.key}`}>
                        {role.note}
                      </span>
                    </span>
                  </div>
                ))}
                <p className="cell__sub" style={{ margin: 'var(--layout-margin-small) 0 0' }}>
                  team and idir are not offered here. A real token has both stripped, so a realm role can never
                  forge a ladder token.
                </p>
              </fieldset>

              <fieldset style={fieldset}>
                <legend className="micro-label" style={legend}>
                  Identity provider
                </legend>
                {IDENTITY_PROVIDERS.map((idp) => (
                  <div key={idp.value} style={checkRow}>
                    <input
                      type="radio"
                      name="identityProvider"
                      id={`idp-${idp.label}`}
                      value={idp.value}
                      checked={identityProvider === idp.value}
                      aria-describedby={`idp-note-${idp.label}`}
                      onChange={() => setIdentityProvider(idp.value)}
                      style={checkboxTop}
                    />
                    <span>
                      <label className="cell__title" htmlFor={`idp-${idp.label}`} style={{ cursor: 'pointer' }}>
                        {idp.label}
                      </label>
                      <span className="cell__sub" style={{ display: 'block' }} id={`idp-note-${idp.label}`}>
                        {idp.note}
                      </span>
                    </span>
                  </div>
                ))}
              </fieldset>

              <fieldset style={fieldset}>
                <legend className="micro-label" style={legend}>
                  Project ids
                </legend>
                <p className="cell__sub" style={{ margin: '0 0 var(--layout-margin-small)' }}>
                  Two different facts, and the engine never merges them: one grants, one restricts.
                </p>
                <label style={{ display: 'block', marginBottom: 'var(--layout-margin-medium)' }}>
                  <span className="cell__title">Team membership — grants</span>
                  <input
                    type="text"
                    inputMode="text"
                    placeholder="402, 111"
                    value={teamsText}
                    onChange={(event) => setTeamsText(event.target.value)}
                    style={smallTextInput}
                  />
                  <span className="cell__sub" style={{ display: 'block' }}>
                    The caller’s project:&lt;id&gt; realm roles. Opens the level-1 team arm on those projects only.
                  </span>
                </label>
                <label style={{ display: 'block' }}>
                  <span className="cell__title">Key project scope — restricts</span>
                  <input
                    type="text"
                    inputMode="text"
                    placeholder="402"
                    value={scopeText}
                    onChange={(event) => setScopeText(event.target.value)}
                    style={smallTextInput}
                  />
                  <span className="cell__sub" style={{ display: 'block' }}>
                    A minted key’s projectScope. ANDed into every read, and it sets the tier to scoped.
                  </span>
                </label>
              </fieldset>

              <fieldset style={fieldset}>
                <legend className="micro-label" style={legend}>
                  Selected credential
                </legend>
                <div style={checkRow}>
                  <input
                    type="checkbox"
                    id="credential-on"
                    checked={credentialOn}
                    aria-describedby="credential-note"
                    onChange={() => setCredentialOn(!credentialOn)}
                    style={checkboxTop}
                  />
                  <span>
                    <label className="cell__title" htmlFor="credential-on" style={{ cursor: 'pointer' }}>
                      The caller holds one
                    </label>
                    <span className="cell__sub" style={{ display: 'block' }} id="credential-note">
                      Row plane only, levels 1–3, exact level match. The registry validates it exactly as it would
                      validate a real grant.
                    </span>
                  </span>
                </div>

                {credentialOn && (
                  <div style={{ marginTop: 'var(--layout-margin-small)', paddingLeft: '1.6rem' }}>
                    <fieldset style={{ ...fieldset, marginBottom: 'var(--layout-margin-small)' }}>
                      <legend className="cell__title" style={{ padding: 0 }}>
                        Scope
                      </legend>
                      <label style={checkRow}>
                        <input
                          type="radio"
                          name="credentialType"
                          value="project"
                          checked={credentialType === 'project'}
                          onChange={() => setCredentialType('project')}
                          style={checkboxTop}
                        />
                        <span className="cell__sub">project — every row of those projects</span>
                      </label>
                      <label style={checkRow}>
                        <input
                          type="radio"
                          name="credentialType"
                          value="document"
                          checked={credentialType === 'document'}
                          onChange={() => setCredentialType('document')}
                          style={checkboxTop}
                        />
                        <span className="cell__sub">document — the named records themselves</span>
                      </label>
                    </fieldset>

                    <label style={{ display: 'block', marginBottom: 'var(--layout-margin-small)' }}>
                      <span className="cell__title">Scope ids</span>
                      <input
                        type="text"
                        placeholder="402"
                        value={credentialIdsText}
                        onChange={(event) => setCredentialIdsText(event.target.value)}
                        style={smallTextInput}
                      />
                    </label>

                    <fieldset style={fieldset}>
                      <legend className="cell__title" style={{ padding: 0 }}>
                        Granted levels
                      </legend>
                      {CREDENTIAL_LEVELS.map((level) => (
                        <label key={level} style={checkRow}>
                          <input
                            type="checkbox"
                            checked={!!credentialLevels[level]}
                            onChange={() => toggleCredentialLevel(level)}
                            style={checkboxTop}
                          />
                          <span className="cell__sub">Level {level}</span>
                        </label>
                      ))}
                      <p className="cell__sub" style={{ margin: '4px 0 0' }}>
                        Level 0 is sealed and level 4 is public, so neither can be granted.
                      </p>
                    </fieldset>
                  </div>
                )}
              </fieldset>
            </div>
          </section>

          <div aria-busy={loading ? 'true' : undefined} style={{ opacity: loading && answer ? 0.6 : undefined }}>
            <h2 className="panel__title panel__title--inline" style={{ marginBottom: 2 }}>
              The engine’s answer
            </h2>
            {/* One region announces the answer, so a screen reader is not read every table row again. */}
            <div aria-live="polite">
              {error ? (
                <div className="callout callout--warning">
                  <p>
                    <strong>The registry refuses this caller.</strong> {error}
                  </p>
                </div>
              ) : (
                <p className="footnote" style={{ margin: '0 0 var(--layout-margin-medium)' }}>
                  {summary}
                </p>
              )}
            </div>

            {answer && (
              <>
                <div className="stat-grid">
                  <div className="stat-card">
                    <div className="micro-label">Level</div>
                    <div className="stat-card__value">{answer.level}</div>
                    <div className="stat-card__note">Which attributes of a visible record come back.</div>
                  </div>
                  <div className="stat-card">
                    <div className="micro-label">Tier</div>
                    <div className="stat-card__value">{answer.tier}</div>
                    <div className="stat-card__note">
                      scoped means a key’s project scope is ANDed into every read.
                    </div>
                  </div>
                  <div className="stat-card">
                    <div className="micro-label">Privileged</div>
                    <div className="stat-card__value">{answer.privileged ? 'Yes' : 'No'}</div>
                    <div className="stat-card__note">The row-plane short-circuit. staff is not privileged.</div>
                  </div>
                  <div className="stat-card">
                    <div className="micro-label">Staff UI</div>
                    <div className="stat-card__value">{answer.staffUi ? 'Yes' : 'No'}</div>
                    <div className="stat-card__note">The gate authMiddleware 403s on.</div>
                  </div>
                </div>

                <section className="panel panel--padded">
                  <h2 className="panel__title panel__title--inline">Roles after the engine resolves them</h2>
                  <div className="role-chips">
                    {answer.roles.map((role) => (
                      <span key={role} className="role-chip">
                        {role}
                      </span>
                    ))}
                  </div>
                  <p className="cell__sub" style={{ margin: 'var(--layout-margin-small) 0 0' }}>
                    You, right now: level {yourLevel}, {yourStaffUi ? 'staff UI' : 'public UI'}, realm{' '}
                    <code className="cell__mono">{realm}</code>. Simulating a caller changes none of that.
                  </p>
                </section>

                <section className="panel">
                  <h2 className="panel__title">Records this caller reads</h2>
                  {rungs.map((rung) => (
                    <div key={rung.level} className="attention-row" style={{ flexWrap: 'wrap' }}>
                      <span className={`attention-row__dot ${rung.dotClass}`} />
                      <div className="attention-row__text" style={{ minWidth: '15rem' }}>
                        <div className="attention-row__title">{rung.heading}</div>
                        <div className="attention-row__detail">{rung.detail}</div>
                        <div className="role-chips" style={{ marginTop: 5 }}>
                          <span className="cell__sub">read[]</span>
                          {rung.read.map((token) => (
                            <span key={token} className="role-chip">
                              {token}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div
                        className="attention-row__action"
                        style={{ display: 'flex', gap: 'var(--layout-margin-xsmall)', alignItems: 'center' }}
                      >
                        {rung.via && <span className="pill pill--info pill--caps">{rung.via}</span>}
                        <span className={rung.pillClass}>{rung.verdict}</span>
                      </div>
                    </div>
                  ))}

                  {sealedNote && (
                    <div
                      className="attention-row"
                      style={{ background: 'var(--surface-color-background-light-gray)', flexWrap: 'wrap' }}
                    >
                      <span className="attention-row__dot attention-row__dot--neutral" />
                      <div className="attention-row__text" style={{ minWidth: '15rem' }}>
                        <div className="attention-row__title">Level 0 — sealed compartment</div>
                        <div className="attention-row__detail">
                          A sealed row carries read: [&apos;compliance&apos;], sits outside the ladder, and is
                          excluded on every ordinary route for every caller — sysadmin included. Only the
                          /api/sealed routes, gated on compliance, read it, and each read is audited. It is not a
                          rung, so no caller here can be given it.
                        </div>
                      </div>
                      <div className="attention-row__action">
                        <span className="pill pill--neutral pill--caps">{sealedNote}</span>
                      </div>
                    </div>
                  )}
                </section>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--layout-margin-medium)',
                    marginBottom: 'var(--layout-margin-medium)',
                    flexWrap: 'wrap',
                  }}
                >
                  <h2 className="panel__title panel__title--inline" style={{ margin: 0 }}>
                    Fields of a record this caller can read
                  </h2>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      font: 'var(--typography-regular-small-body)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={showPlumbing}
                      onChange={() => setShowPlumbing(!showPlumbing)}
                    />
                    Show plumbing keys
                  </label>
                </div>

                <div
                  className="panel-grid"
                  style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(24rem, 100%), 1fr))' }}
                >
                  {[
                    { title: 'Projects', data: projectFields },
                    { title: 'Documents', data: documentFields },
                  ].map((entity) => (
                    <section key={entity.title} className="panel panel--scroll">
                      <h3 className="panel__title">
                        {entity.title} · {entity.data.caption}
                      </h3>
                      <table style={{ minWidth: '20rem', width: '100%' }}>
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Default</th>
                            <th>Max</th>
                            <th>Predicate</th>
                            <th>At level {answer.level}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entity.data.rows.map((field) => (
                            <tr
                              key={field.field}
                              style={{
                                background: field.notable ? 'var(--surface-color-background-light-gray)' : undefined,
                              }}
                            >
                              <td>
                                <code className="cell__mono cell__mono--wrap">{field.field}</code>
                              </td>
                              <td className="cell--muted cell--nowrap">{field.defaultVis}</td>
                              <td className="cell--muted cell--nowrap">{field.maxVis}</td>
                              <td className="cell--nowrap">
                                {field.when ? (
                                  <code className="cell__mono">{field.when}</code>
                                ) : (
                                  <span className="cell--muted">—</span>
                                )}
                              </td>
                              <td className="cell--nowrap">
                                {field.visible ? (
                                  <span className="cell--muted">Returned</span>
                                ) : (
                                  <span className="pill pill--neutral pill--caps">Removed</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                  ))}
                </div>

                {answer.predicatesAssumedFalse && (
                  <p
                    className="footnote"
                    style={{
                      marginTop: 'calc(-1 * var(--layout-margin-small))',
                      marginBottom: 'var(--layout-margin-large)',
                    }}
                  >
                    No record is simulated, so every predicate reads false and each field sits at its default. A
                    per-record dial moves a field anywhere between 0 and its own maximum; an invalid dial falls back
                    to the default. Plumbing keys are pinned at maximum 0 and never leave the API.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}

      <section className="panel">
        <h2 className="panel__title">What changes a record’s level</h2>
        {LEVEL_CHANGES.map((change) => (
          <div key={change.title} className="attention-row">
            <span className={`attention-row__dot ${change.dot}`} />
            <div className="attention-row__text">
              <div className="attention-row__title">{change.title}</div>
              <div className="attention-row__detail">{change.detail}</div>
            </div>
          </div>
        ))}
      </section>

      <p className="footnote">
        A record a caller may not read answers 404, never 403 — a 403 would confirm the id exists. A write it may
        not make answers 403, because the caller is already known.
      </p>
    </>
  );
}
