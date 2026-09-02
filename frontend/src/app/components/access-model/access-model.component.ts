import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';

/** One catalogued field, exactly as `POST /api/access/simulate` reports it. */
export interface SimulateField {
  field: string;
  defaultVis: number;
  maxVis: number;
  when: string | null;
  visible: boolean;
}

export interface SimulateResponse {
  roles: string[];
  level: number;
  tier: string;
  privileged: boolean;
  staffUi: boolean;
  rows: Record<string, { readable: boolean; via: string | null; read: string[] }>;
  fields: { projects: SimulateField[]; documents: SimulateField[] };
  predicatesAssumedFalse: boolean;
  notes?: { sealedCompartment?: string };
}

export interface SimulateRequest {
  roles: string[];
  identityProvider?: string;
  teams?: string[];
  projectScope?: string[];
  credential?: { scope: { type: string; ids: string[] }; levels: number[] };
}

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
  { key: 'compliance', note: 'The only role a sealed level-0 row matches. Not a ladder rung.' }
];

/** The ladder as docs/rbac-architecture.md §1 states it. The stored `read[]` comes from the engine. */
const LADDER = [
  { level: 1, name: 'Team only', detail: 'Reached only through the team arm: the row carries team and its project is one of the caller’s.' },
  { level: 2, name: 'All EAO', detail: 'Every EAO staff member, any project or business unit.' },
  { level: 3, name: 'All IDIR', detail: 'Any BC Government IDIR account. idir comes from the identity_provider claim, never a role.' },
  { level: 4, name: 'Public', detail: 'Anyone, no credential.' }
];

const IDENTITY_PROVIDERS = [
  { value: '', label: 'None', note: 'No identity provider claim.' },
  { value: 'idir', label: 'IDIR', note: 'The only provider that moves a caller to level 3.' },
  { value: 'bceid', label: 'BCeID', note: 'Where a Selected Credential holder signs in. Never level 3.' }
];

/** What moves a record between levels. Row plane only — none of it touches the field catalog. */
const LEVEL_CHANGES = [
  { dot: 'attention-row__dot--warning', title: 'Publishing to level 4', detail: 'PUT /:id/level with confirm: true and a reason. Without either it answers 400. Audited as record.widen.' },
  { dot: 'attention-row__dot--danger', title: 'Pulling back from level 4', detail: 'sysadmin only, audited as record.takedown, and handled as incident response — a routine correction publishes a replacement instead.' },
  { dot: 'attention-row__dot--info', title: 'Holding a Selected Credential', detail: 'One extra OR arm for the named party at levels 1–3. It changes no record’s level and no field.' }
];

const FIELDSET = 'border: 0; margin: 0; padding: 0;';
const CHECK_ROW = 'display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer; padding: 3px 0;';
const TEXT_INPUT = 'width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem; border: var(--layout-border-width-small) solid var(--surface-color-border-default); border-radius: var(--layout-border-radius-small); font: var(--typography-regular-small-body);';

@Component({
  selector: 'app-access-model',
  standalone: true,
  imports: [],
  templateUrl: './access-model.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class AccessModelComponent implements OnDestroy {
  private service = inject(RegistryStateService);

  /** Static so a spec can shorten it before the component is created. */
  static debounceMs = 150;

  readonly roleOptions = ROLE_OPTIONS;
  readonly identityProviders = IDENTITY_PROVIDERS;
  readonly ladder = LADDER;
  readonly levelChanges = LEVEL_CHANGES;
  readonly fieldsetStyle = FIELDSET;
  readonly checkRowStyle = CHECK_ROW;
  readonly textInputStyle = TEXT_INPUT;

  // Described caller.
  roles = signal<Record<string, boolean>>({ public: true });
  identityProvider = signal('');
  teamsText = signal('');
  scopeText = signal('');
  credentialOn = signal(false);
  credentialType = signal<'project' | 'document'>('project');
  credentialIdsText = signal('');
  credentialLevels = signal<Record<number, boolean>>({ 2: true });

  showPlumbing = signal(false);

  // Engine answer.
  result = signal<SimulateResponse | null>(null);
  error = signal<string | null>(null);
  loading = signal(true);

  /** The real caller, from the service that already asked `/api/me` — never re-fetched here. */
  readonly realm = this.service.config.KEYCLOAK_REALM || '—';
  yourLevel = this.service.visLevel;
  yourStaffUi = this.service.isStaff;

  /** The simulator sits behind authMiddleware, so without a session there is nothing to ask. */
  signedIn = this.service.isAuthenticated;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    // Every input change re-asks the engine; nothing on this screen is computed from a local copy
    // of the rules. The bearer token is attached by the service's fetch interceptor, which owns
    // every Authorization header the app sends to its own API.
    effect(() => {
      const body = this.body();
      if (!this.signedIn()) {
        this.loading.set(false);
        return;
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.simulate(body), AccessModelComponent.debounceMs);
    });
  }

  ngOnDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  /** The request body for the described caller. Optional keys are omitted, not sent empty. */
  body = computed<SimulateRequest>(() => {
    const roles = this.roles();
    const request: SimulateRequest = { roles: ROLE_OPTIONS.filter(r => roles[r.key]).map(r => r.key) };

    if (this.identityProvider()) request.identityProvider = this.identityProvider();

    const teams = idList(this.teamsText());
    if (teams.length > 0) request.teams = teams;

    // Sent only when asked for: `projectScope` present at all makes the tier `scoped`, so a text
    // box holding nothing but separators must not describe a caller scoped to no project.
    const scope = idList(this.scopeText());
    if (scope.length > 0) request.projectScope = scope;

    if (this.credentialOn()) {
      const levels = this.credentialLevels();
      request.credential = {
        scope: { type: this.credentialType(), ids: idList(this.credentialIdsText()) },
        levels: [1, 2, 3].filter(l => levels[l])
      };
    }
    return request;
  });

  private async simulate(body: SimulateRequest) {
    const mine = ++this.seq;
    this.loading.set(true);
    try {
      const res = await fetch(`${this.service.getBasePath()}/access/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      if (mine !== this.seq) return;
      if (res.ok && data) {
        this.result.set(data as SimulateResponse);
        this.error.set(null);
      } else {
        // A refusal is an answer too — the registry would refuse this caller's credential — so the
        // stale result is dropped rather than left on screen under a new description.
        this.result.set(null);
        this.error.set((data && data.error) || `The access engine answered ${res.status}.`);
      }
    } catch {
      if (mine !== this.seq) return;
      this.result.set(null);
      this.error.set('The access engine did not answer.');
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  toggleRole(key: string) {
    this.roles.update(r => ({ ...r, [key]: !r[key] }));
  }

  toggleCredentialLevel(level: number) {
    this.credentialLevels.update(l => ({ ...l, [level]: !l[level] }));
  }

  /** Typed value of an input or textarea event, for the template. */
  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  ladderRows = computed(() => {
    const rows = this.result()?.rows || {};
    return LADDER.map(rung => {
      const row = rows[String(rung.level)];
      const readable = !!row?.readable;
      return {
        ...rung,
        read: row?.read || [],
        heading: `Level ${rung.level} — ${rung.name}`,
        readable,
        dotClass: readable ? 'attention-row__dot--success' : 'attention-row__dot--neutral',
        pillClass: readable ? 'pill pill--success' : 'pill pill--neutral',
        verdict: readable ? 'Readable' : 'Withheld',
        via: row?.via ? `via ${row.via}` : null
      };
    });
  });

  /** Readable levels, narrowest first, for the live summary. */
  private readableLevels = computed(() => this.ladderRows().filter(r => r.readable).map(r => r.level));

  projectFields = computed(() => this.catalog('projects'));
  documentFields = computed(() => this.catalog('documents'));

  private catalog(entity: 'projects' | 'documents') {
    const all = this.result()?.fields?.[entity] || [];
    const rows = (this.showPlumbing() ? all : all.filter(f => f.maxVis > 0))
      // Most fields are 4/4 with no predicate. Tinting the rest is what makes the exceptions
      // findable in a catalog of sixty.
      .map(f => ({ ...f, notable: f.defaultVis !== 4 || f.maxVis !== 4 || !!f.when }));
    const hidden = all.length - rows.length;
    return {
      rows,
      caption: `${rows.filter(f => f.visible).length} of ${rows.length} returned` +
        (hidden > 0 ? ` · ${hidden} plumbing key${hidden === 1 ? '' : 's'} hidden` : '')
    };
  }

  sealedNote = computed(() => this.result()?.notes?.sealedCompartment || null);

  /** One sentence for the live region: the whole answer, without reading every table row aloud. */
  summary = computed(() => {
    const result = this.result();
    if (!result) return 'Asking the access engine…';
    const levels = this.readableLevels();
    return `Level ${result.level}, tier ${result.tier}. ` +
      (levels.length ? `Reads records at level ${levels.join(', ')}. ` : 'Reads no records. ') +
      `${this.projectFields().rows.filter(f => f.visible).length} project fields and ` +
      `${this.documentFields().rows.filter(f => f.visible).length} document fields returned.`;
  });
}

/** "402, 111" → ['402', '111']. Blanks dropped so a trailing comma is not an empty id. */
function idList(text: string): string[] {
  return text.split(',').map(id => id.trim()).filter(Boolean);
}
