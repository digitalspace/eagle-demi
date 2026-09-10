import { ChangeDetectionStrategy, Component, ElementRef, LOCALE_ID, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ProjectSummaryService } from '../../services/project-summary.service';
import { RegistryStateService } from '../../services/registry-state.service';
import {
  ConditionItem,
  FederalDocumentRef,
  FederalFacts,
  KEY_DOCUMENT_LABELS,
  KeyDocumentRole,
  LabelLine,
  NationNote,
  OrganizationRow,
  PhaseHistoryEntry,
  ProjectSummaryCitation,
  SummaryDocumentRef,
  TimelineRow
} from '../../models/project-summary.models';

/** The public EPIC project page, which is where a reader goes for the documents themselves. */
const EPIC_PROJECT_BASE = 'https://projects.eao.gov.bc.ca/p';

/** `phaseHistory` rows are bare names in Eagle and dated objects in Track. Read both. */
const phaseLabel = (entry: PhaseHistoryEntry): string =>
  typeof entry === 'string' ? entry : (entry?.name || entry?.phaseName || '');

const phaseDate = (entry: PhaseHistoryEntry): string | null =>
  typeof entry === 'string' ? null : (entry?.date || entry?.dateCompleted || null);

/**
 * Project summary — the stored, offline-generated status page for one project.
 *
 * The page never calls a model. Facts come from `GET /projects/:id` live; everything generated is
 * one stored row read from `GET /projects/:id/summary`, written by the generation script. That is
 * why it is instant, and why a section can simply be absent: the generator found no source
 * document for it and wrote null rather than inventing one.
 *
 * Every generated block on this page carries the same two things as the AI Summary screen: the
 * "AI-generated from the sources below" badge, and citation chips that resolve to a real document
 * row. Nothing generated renders without them.
 */
@Component({
  selector: 'app-project-summary',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './project-summary.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ProjectSummaryComponent implements OnInit {
  service = inject(ProjectSummaryService);
  registry = inject(RegistryStateService);
  private route = inject(ActivatedRoute);
  private locale = inject(LOCALE_ID);

  projectId = signal<string>('');

  private dialogRef = viewChild<ElementRef<HTMLDialogElement>>('conditionDialog');

  ngOnInit() {
    this.registry.activePage.set('summary');
    const id = this.route.snapshot.paramMap.get('id') || '';
    this.projectId.set(id);
    if (id) this.service.load(id);
  }

  facts = computed(() => this.service.facts());
  summary = computed(() => this.service.summary());
  sections = computed(() => this.service.summary()?.sections || null);

  /** True once the summary read has settled with nothing to show — 404, disabled, or a failure. */
  noSummary = computed(() => !this.service.summary() && !!this.service.summaryReason());

  proponent = computed(() => {
    const f = this.facts();
    return f?.proponentName || f?.proponent || '';
  });

  /**
   * Uppercase eyebrow: the Act the project is assessed under, then federal involvement.
   *
   * Every line below goes through `labelLine`, because these fields hold `List` ObjectIds on the
   * real record and only the mock fixture carries names. The `title` it returns names any id the
   * lookup could not place, so an id never appears unexplained.
   */
  eyebrow = computed<LabelLine>(() => {
    const f = this.facts();
    return this.service.labelLine([f?.legislation, f?.CEAAInvolvement], ' · ');
  });

  location = computed<LabelLine>(() => {
    const f = this.facts();
    // The address is a plain string; only the region is a lookup, so it carries the whole line.
    const region = this.service.labelLine([f?.region], '');
    return {
      ...region,
      text: [f?.address, region.text ? `${region.text} region` : ''].filter(Boolean).join(' · ')
    };
  });

  statusLabel = computed<LabelLine>(() => {
    const f = this.facts();
    return this.service.labelLine([f?.eacDecision, f?.currentPhaseName], ', ');
  });

  /**
   * Colour of the status card's left border.
   *
   * Never the only carrier of the message: the same three states are spelled out in the label text
   * beside it, so a reader who cannot tell the colours apart loses nothing.
   */
  statusTone = computed<'success' | 'warning' | 'neutral'>(() => {
    const f = this.facts();
    // The RESOLVED names: the stored values are ids, and no id contains "issued".
    const decision = this.service.resolveLabel(f?.eacDecision).text.toLowerCase();
    const certificate = (f?.eaCertificate || '').toLowerCase();
    if (decision.includes('issued') || /^[a-z]\d{2}-\d{2}$/.test(certificate)) return 'success';
    const phase = this.service.resolveLabel(f?.currentPhaseName).text.toLowerCase();
    if (decision.includes('progress') || certificate.includes('progress') || phase.includes('review') || phase.includes('application')) {
      return 'warning';
    }
    return 'neutral';
  });

  latestAmendment = computed(() => {
    const rows = this.summary()?.facts?.amendments || [];
    return rows.map(r => r.datePosted).filter(Boolean).sort().reverse()[0] || null;
  });

  /**
   * The undated phase names, in order, for the one-line sequence under the status label.
   *
   * Eagle's `phaseHistory` rows carry no date and cannot sit on a dated axis, so they render here;
   * Track's dated phase rows stay on the timeline. Each row is a `List` reference like the fields
   * above, so `title` carries whatever the lookup could not place for the whole line at once.
   */
  phaseSequence = computed<{ rows: { name: string; current: boolean }[]; title: string }>(() => {
    const f = this.facts();
    const current = this.service.resolveLabel(f?.currentPhaseName).text.trim().toLowerCase();
    const line = this.service.labelLine(
      (f?.phaseHistory || []).filter(entry => !phaseDate(entry)).map(entry => phaseLabel(entry)),
      ''
    );
    return {
      rows: line.parts
        .filter(part => !!part.text)
        .map(part => ({
          name: part.text,
          current: !!current && part.text.trim().toLowerCase() === current
        })),
      title: line.title
    };
  });

  /**
   * The merged timeline.
   *
   * Four sources, one list, newest first: dated phase rows, the decision date, one row per
   * amendment, and the model's extracted events. Eagle's undated phase names go to `phaseSequence`
   * rather than render as a row with an em dash for a date, but an extracted event can still reach
   * here without one, and a row with no date cannot be placed on the axis — so it sinks to the end.
   */
  timeline = computed<TimelineRow[]>(() => {
    const f = this.facts();
    const summary = this.summary();
    const dated: TimelineRow[] = [];

    (f?.phaseHistory || []).forEach((entry, i) => {
      const date = phaseDate(entry);
      // Track's dated rows carry the name, but the same field is a List id on Eagle's, so a dated
      // row goes through the lookup as well.
      const label = this.service.labelLine([phaseLabel(entry)], '');
      if (!date || !label.text) return;
      dated.push({ key: `phase-${i}`, date, label: label.text, kind: 'phase', title: label.title });
    });

    if (f?.decisionDate) {
      dated.push({
        key: 'decision',
        date: f.decisionDate,
        label: f.eaCertificate ? `Certificate ${f.eaCertificate} issued` : 'Decision issued',
        kind: 'decision'
      });
    }

    for (const a of summary?.facts?.amendments || []) {
      if (!a.datePosted) continue;
      dated.push({ key: `amend-${a.documentId}`, date: a.datePosted, label: a.displayName, kind: 'amendment' });
    }

    for (const e of summary?.sections?.timelineEvents || []) {
      dated.push({ key: `ai-${e.date}-${e.label}`, date: e.date, label: e.label, kind: 'ai', citations: e.citations });
    }

    dated.sort((a, b) => {
      if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : 0;
      return String(b.date).localeCompare(String(a.date));
    });
    return dated;
  });

  /** Amendment document rows joined to the one cited sentence the model wrote about each. */
  amendmentRows = computed(() => {
    const notes = new Map((this.sections()?.amendments || []).map(a => [a.documentId, a]));
    return (this.summary()?.facts?.amendments || []).map(doc => ({
      ...doc,
      sentence: notes.get(doc.documentId)?.sentence || '',
      citations: notes.get(doc.documentId)?.citations || []
    }));
  });

  /**
   * Extracted nation names joined to their Organization row.
   *
   * Three outcomes, not two: a card, a plain cited row for a name the join could not match, and
   * `pending` while the organisation list is still in flight — without which every card would
   * flash as "unmatched" for as long as that request takes.
   */
  nationRows = computed<{ note: NationNote; org: OrganizationRow | null; pending: boolean }[]>(() => {
    const orgs = this.service.organizations();
    // A nameless note would render as citation chips under a blank line: sources for nothing.
    return (this.sections()?.nations || []).filter(note => !!note.name?.trim()).map(note => ({
      note,
      org: note.organizationId ? (orgs?.get(note.organizationId) || null) : null,
      pending: !!note.organizationId && !orgs
    }));
  });

  /**
   * The registry facts behind a federal section Canada holds, and null for one DEMI holds.
   *
   * A DEMI-sourced section resolves to a document in this service and needs no registry line; an
   * IAAC-sourced one resolves to nothing here, so the facts and the links are what the page shows.
   */
  federalFacts = computed<FederalFacts | null>(() => {
    const federal = this.sections()?.federal;
    return federal?.source === 'iaac' ? federal.facts || null : null;
  });

  /** The federal fact row as text; the two registry links render as their own elements beside it. */
  federalLine = computed<string>(() => {
    const f = this.federalFacts();
    if (!f) return '';
    const parts = [`Federal assessment: ${f.status || 'status not recorded'}`];
    if (f.decision) {
      parts.push(this.dated(f.decision));
    } else {
      parts.push('No federal decision statement yet');
      if (f.latest) parts.push(`Latest: ${this.dated(f.latest)}`);
    }
    return parts.join(' · ');
  });

  /** The PDF link's label. A decision whose text would not read is still a file worth offering. */
  federalPdfLabel = computed<string>(() => {
    const pages = this.federalFacts()?.decision?.pageCount;
    return pages ? `Decision statement (PDF, ${pages} pages)` : 'Decision statement (PDF)';
  });

  /** A registry row as "Title (14 Oct 2014)". Its date is scraped text, so an odd one renders raw. */
  private dated(row: FederalDocumentRef): string {
    if (!row.date) return row.title;
    let day = row.date;
    try {
      day = formatDate(row.date, 'd MMM y', this.locale);
    } catch {
      // Not a date this locale can parse: the registry's own string is still worth showing.
    }
    return `${row.title} (${day})`;
  }

  /** The document a section is waiting on, when extraction is why it rendered nothing. */
  notExtracted(section: string): SummaryDocumentRef | null {
    const record = this.summary();
    if (record?.sectionErrors?.[section] !== 'not_extracted') return null;
    return record.sectionSources?.[section] || null;
  }

  keyDocuments = computed(() =>
    (this.summary()?.facts?.keyDocuments || []).map(doc => ({
      ...doc,
      ...(KEY_DOCUMENT_LABELS[doc.role] || { label: doc.role, note: '' })
    }))
  );

  address = (org: OrganizationRow): string =>
    [org.address1, org.city, org.province, org.postal].filter(Boolean).join(', ');

  /** The public EPIC page for this project. Empty when the record carries no Eagle id. */
  epicUrl = computed(() => {
    const f = this.facts();
    const eagleId = f?.eagleId || f?.legacyEagleId;
    return eagleId ? `${EPIC_PROJECT_BASE}/${eagleId}/project-details` : '';
  });

  /** Resolve the `[n]` markers on one generated claim to the chunks they point at. */
  citations(numbers: number[] | undefined): ProjectSummaryCitation[] {
    const lookup = this.service.citationsByNumber();
    return (numbers || []).map(n => lookup.get(n)).filter((c): c is ProjectSummaryCitation => !!c);
  }

  // Condition modal ------------------------------------------------------------------------

  openCondition = signal<ConditionItem | null>(null);
  /** The card that opened the dialog, so focus goes back to it rather than to the top of the page. */
  private opener: HTMLElement | null = null;

  showCondition(item: ConditionItem, event: Event) {
    this.opener = event.currentTarget as HTMLElement;
    this.openCondition.set(item);
    this.dialogRef()?.nativeElement.showModal();
  }

  /** Escape and the close button both land here through the dialog's own `close` event. */
  onDialogClose() {
    this.openCondition.set(null);
    this.opener?.focus();
    this.opener = null;
  }

  /**
   * Clicking the backdrop closes.
   *
   * A `<dialog>` backdrop is not a separate element, so the click arrives on the dialog itself;
   * comparing target to currentTarget is what separates "on the sheet" from "outside it".
   */
  onDialogClick(event: MouseEvent) {
    if (event.target === event.currentTarget) this.dialogRef()?.nativeElement.close();
  }

  // Downloads ------------------------------------------------------------------------------

  downloadingId = signal<string | null>(null);
  downloadError = signal<string | null>(null);

  /** Same leg as the AI Summary sources table: the API mints a short-lived presigned URL. */
  async openDocument(documentId: string) {
    if (!documentId || this.downloadingId()) return;
    this.downloadingId.set(documentId);
    this.downloadError.set(null);
    try {
      const url = await this.registry.getDownloadUrl(documentId, this.projectId());
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      console.error('[ProjectSummary] Download failed:', err);
      this.downloadError.set(err instanceof Error ? err.message : 'Could not prepare the download.');
    } finally {
      this.downloadingId.set(null);
    }
  }

  protected readonly roleLabel = (role: KeyDocumentRole) => KEY_DOCUMENT_LABELS[role]?.label || role;
}
