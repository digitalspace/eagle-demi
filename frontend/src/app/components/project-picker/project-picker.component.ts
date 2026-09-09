import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectSummaryService } from '../../services/project-summary.service';
import { LabelLine, ProjectListRow } from '../../models/project-summary.models';

/** Rows drawn at once. The filter still runs over all 411; a 411-row list is a wall, not a list. */
export const MAX_ROWS = 50;

/**
 * Project picker — the way into the Project summary screen.
 *
 * The whole list is one read held in the browser, so a keystroke filters locally: no debounce, no
 * in-flight state, no stale response to race. Results are plain links rather than a combobox, so
 * Enter, open-in-new-tab and the focus ring are the browser's; only arrow movement is added.
 */
@Component({
  selector: 'app-project-picker',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './project-picker.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ProjectPickerComponent implements OnInit {
  service = inject(ProjectSummaryService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private searchBox = viewChild<ElementRef<HTMLInputElement>>('search');

  query = signal<string>('');

  constructor() {
    // The one control on the screen: typing should be the first thing that works, without a click.
    effect(() => this.searchBox()?.nativeElement.focus());
  }

  ngOnInit() {
    this.service.loadProjects();
  }

  /** True only before the first answer lands: an empty list afterwards is a result, not a wait. */
  loading = computed(() => this.service.projects() === null && !this.service.projectsError());

  /** Case-insensitive substring on the name, alphabetical. Every match, before the display cap. */
  matches = computed<ProjectListRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    return (this.service.projects() || [])
      .filter(row => !q || row.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * What is drawn, each row with its secondary line already resolved.
   *
   * Resolved here rather than by a call in the template: a template call reruns for every row on
   * every change detection pass, and this recomputes only when the list, the query or the `List`
   * lookup actually changes. `matches()` stays whole, so the count is the count, not the page.
   */
  visible = computed(() => this.matches()
    .slice(0, MAX_ROWS)
    .map(row => ({ row, meta: this.secondary(row) })));

  countLabel = computed<string>(() => {
    const found = this.matches().length;
    const total = this.service.projectsTotal();
    const loaded = this.service.projects()?.length ?? 0;
    const noun = found === 1 ? 'project' : 'projects';
    const parts = [`${found} ${noun}`];
    if (found > MAX_ROWS) parts.push(`showing the first ${MAX_ROWS}`);
    // The read is one page. Saying "411 projects" over a 500-row page that held 500 of 900 would
    // be a claim about the registry this screen cannot make.
    if (total !== null && total > loaded) parts.push(`${loaded} of ${total} loaded`);
    return parts.join(' · ');
  });

  /**
   * Region or proponent, then the current phase, as one muted line.
   *
   * Through the service's label lookup, so a `List` id renders as its name — or is withheld while
   * the lookup is still in flight, rather than shown as an id and swapped a moment later.
   */
  secondary(row: ProjectListRow): LabelLine {
    return this.service.labelLine([row.region || row.proponent, row.currentPhaseName], ' · ');
  }

  onInput(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Arrow keys walk from the box into the list and back. `from` is the row's index, or -1 for the
   * search box. Enter and the links themselves are untouched: they are anchors.
   */
  moveFocus(from: number, delta: number, event: Event) {
    event.preventDefault();
    const next = from + delta;
    if (next < 0) {
      this.searchBox()?.nativeElement.focus();
      return;
    }
    const rows = this.host.nativeElement.querySelectorAll<HTMLAnchorElement>('.pp-result');
    rows[Math.min(next, rows.length - 1)]?.focus();
  }
}
