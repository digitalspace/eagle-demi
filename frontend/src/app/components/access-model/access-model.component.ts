import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';

export type RbacGroupKey = 'public' | 'idir' | 'eao' | 'team' | 'credential' | 'ce';
export type RbacGroups = Record<RbacGroupKey, boolean>;

interface RbacProject { id: number; name: string; level: number; team: boolean; }

/** The EAO sharing model: four ladder levels, one sealed compartment, one credential lane. */
const LEVELS = [
  { n: 4, name: 'Public', audience: 'Anyone, no credential, through EPIC.public', detail: 'Finalized products. Moving a file here is an explicit human action, warned and logged.' },
  { n: 3, name: 'All IDIR', audience: 'Any BC Government employee with an IDIR account', detail: 'Chosen because government-wide sharing is intended, not because the file is uncontroversial.' },
  { n: 2, name: 'All EAO', audience: 'Every EAO staff member, any project or business unit', detail: 'Approved internal records — settled enough to be relied on across the organization.' },
  { n: 1, name: 'Team Only', audience: 'The group that originated the file', detail: 'The default on admission. Unapproved, in-progress and working records live here.' }
];

const RBAC_GROUPS: { key: RbacGroupKey; label: string; note: string; locked?: boolean }[] = [
  { key: 'public', label: 'Public (no credential)', note: 'Always in effect — the floor of the ladder', locked: true },
  { key: 'idir', label: 'All IDIR', note: 'A BC Government IDIR account' },
  { key: 'eao', label: 'All EAO staff', note: 'Any EAO business unit or project' },
  { key: 'team', label: 'Site C project team', note: 'Originating group for Site C files only' },
  { key: 'credential', label: 'Selected credential — proponent', note: 'Site C content at Level 2, expires 31 Dec 2026' },
  { key: 'ce', label: 'Compliance & Enforcement', note: 'Named role for the sealed Level 0 compartment' }
];

const RBAC_PROJECTS: RbacProject[] = [
  { id: 402, name: 'Site C Clean Energy Project', level: 4, team: true },
  { id: 111, name: 'Ajax Mine', level: 4, team: false },
  { id: 404, name: 'KSM Project', level: 1, team: false }
];

const RBAC_FIELDS = [
  { key: 'name', label: 'Project name', value: 'Site C Clean Energy Project', level: 4 },
  { key: 'proponent', label: 'Proponent', value: 'BC Hydro', level: 4 },
  { key: 'region', label: 'Region', value: 'Peace', level: 4 },
  { key: 'status', label: 'Decision status', value: 'In Progress', level: 4 },
  { key: 'capital', label: 'Capital investment', value: '$16.0 B', level: 2 },
  { key: 'contact', label: 'Proponent contact', value: 'k.wells@bchydro.com', level: 2 },
  { key: 'risk', label: 'Internal risk assessment', value: 'Elevated — schedule and reservoir clearing', level: 1 },
  { key: 'rationale', label: 'Draft decision rationale', value: 'Working draft, not for reliance', level: 1 },
  { key: 'investigation', label: 'C&E investigation file', value: 'CE-2026-0114 — open', level: 0 }
];

const RBAC_DOCS = [
  { id: 'd1', name: 'Environmental Assessment Certificate #14-02', projectId: 402, level: 4 },
  { id: 'd2', name: 'Site C Compliance Report 2026', projectId: 402, level: 3 },
  { id: 'd3', name: 'Reservoir clearing cost schedule', projectId: 402, level: 2 },
  { id: 'd4', name: 'Draft condition amendment, internal', projectId: 402, level: 1 },
  { id: 'd5', name: 'Ajax Mine Project Assessment Report', projectId: 111, level: 4 },
  { id: 'd6', name: 'KSM pre-application working notes', projectId: 404, level: 1 },
  { id: 'd7', name: 'CE-2026-0114 investigation record', projectId: 402, level: 0 }
];

/**
 * Levels this simulated user can read for one project. Level 0 is a sealed compartment, not a
 * step: `ce` opens it without granting any rung of the ladder.
 */
export function levelsFor(groups: RbacGroups, project: { team: boolean }): Set<number> {
  const set = new Set<number>([4]);
  if (groups.idir) set.add(3);
  if (groups.eao) { set.add(3); set.add(2); }
  if (groups.team && project.team) { set.add(3); set.add(2); set.add(1); }
  // A credential grants sight of specified content without joining that level's audience.
  if (groups.credential && project.team) set.add(2);
  if (groups.ce) set.add(0);
  return set;
}

const ROW = 'display: flex; gap: var(--layout-margin-medium); align-items: flex-start; justify-content: space-between; padding: var(--layout-padding-small) var(--layout-padding-large);';
const ROW_RULED = ROW + ' border-bottom: var(--layout-border-width-small) solid var(--surface-color-border-default);';

@Component({
  selector: 'app-access-model',
  standalone: true,
  imports: [],
  templateUrl: './access-model.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class AccessModelComponent implements OnInit {
  service = inject(RegistryStateService);

  readonly rowLevel0Style = ROW_RULED + ' background: var(--surface-color-background-light-gray);';
  readonly rowLaneStyle = ROW;

  groups = signal<RbacGroups>({ public: true, idir: false, eao: false, team: false, credential: false, ce: false });

  /** What the API says about the real caller, unlike everything else on this screen. */
  me = signal<{ roles: string[]; level: number; tier: string; privileged: boolean } | null>(null);

  realm = this.service.config.KEYCLOAK_REALM || '—';

  /** Null `me` means both "still fetching" and "no answer"; this separates them for the UI. */
  meLoading = signal(true);

  async ngOnInit() {
    await this.service.authReady;
    try {
      const res = await fetch(`${this.service.getBasePath()}/me`);
      this.me.set(res.ok ? await res.json() : null);
    } catch {
      this.me.set(null);
    } finally {
      this.meLoading.set(false);
    }
  }

  meLabel = computed(() => {
    const me = this.me();
    return me ? `${me.level} (${me.tier})` : 'Unavailable';
  });

  toggle(key: RbacGroupKey) {
    this.groups.update(g => ({ ...g, [key]: !g[key] }));
  }

  private siteCLevels = computed(() => levelsFor(this.groups(), RBAC_PROJECTS[0]));

  groupRows = computed(() => {
    const g = this.groups();
    return RBAC_GROUPS.map(row => ({ ...row, checked: !!g[row.key], disabled: !!row.locked }));
  });

  audienceSummary = computed(() =>
    'Levels ' + Array.from(this.siteCLevels()).sort((a, b) => b - a).join(', ')
  );

  ladder = computed(() => {
    const levels = this.siteCLevels();
    return LEVELS.map(lv => {
      const can = levels.has(lv.n);
      return {
        heading: `Level ${lv.n} — ${lv.name}`,
        audience: lv.audience,
        detail: lv.detail,
        pillClass: can ? 'pill pill--success' : 'pill pill--neutral',
        verdict: can ? 'You can read' : 'Withheld',
        rowStyle: can
          ? ROW_RULED + ' box-shadow: inset 3px 0 0 var(--surface-color-primary-default);'
          : ROW_RULED + ' opacity: 0.55;'
      };
    });
  });

  sealedVerdict = computed(() => this.siteCLevels().has(0) ? 'You can read' : 'Sealed');
  sealedPillClass = computed(() => this.siteCLevels().has(0) ? 'pill pill--success' : 'pill pill--danger');

  fields = computed(() => {
    const levels = this.siteCLevels();
    return RBAC_FIELDS.map(f => {
      const visible = levels.has(f.level);
      return {
        label: f.label,
        shown: visible ? f.value : '▮▮▮▮▮▮▮▮',
        levelLabel: f.level === 0 ? 'Level 0 · sealed' : `Level ${f.level}`,
        valueStyle: visible
          ? 'font: var(--typography-regular-small-body); color: var(--typography-color-primary);'
          : 'font: var(--typography-regular-small-body); color: var(--typography-color-secondary); letter-spacing: 1px;',
        pillClass: visible ? 'pill pill--success pill--caps' : 'pill pill--neutral pill--caps',
        verdict: visible ? 'Visible' : 'Redacted'
      };
    });
  });

  projects = computed(() => {
    const groups = this.groups();
    return RBAC_PROJECTS.map(p => {
      const visible = levelsFor(groups, p).has(p.level);
      return {
        name: p.name,
        levelLabel: `Level ${p.level}`,
        pillClass: visible ? 'pill pill--success pill--caps' : 'pill pill--neutral pill--caps',
        verdict: visible ? 'In results' : 'Not in results'
      };
    });
  });

  private docVisibility = computed(() => {
    const groups = this.groups();
    return RBAC_DOCS.map(d => {
      const project = RBAC_PROJECTS.find(p => p.id === d.projectId)!;
      return { doc: d, project, visible: levelsFor(groups, project).has(d.level) };
    });
  });

  docs = computed(() => this.docVisibility().map(({ doc, project, visible }) => ({
    id: doc.id,
    projectName: project.name,
    levelLabel: doc.level === 0 ? 'Level 0 · sealed' : `Level ${doc.level}`,
    shown: visible ? doc.name : 'Withheld — not returned by the query',
    nameStyle: visible
      ? 'font: var(--typography-bold-small-body); color: var(--typography-color-primary);'
      : 'font: var(--typography-regular-small-body); color: var(--typography-color-secondary); font-style: italic;',
    pillClass: visible ? 'pill pill--success pill--caps' : 'pill pill--neutral pill--caps',
    verdict: visible ? 'Returned' : '404'
  })));

  docSummary = computed(() => {
    const vis = this.docVisibility().filter(d => d.visible).length;
    return `${vis} of ${RBAC_DOCS.length} documents returned · ${RBAC_DOCS.length - vis} withheld`;
  });
}
