import { Component, OnInit, inject, signal, computed, effect, untracked, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';
import { Document } from '../../models/registry.models';
import { readPrefs } from '../../shell/prefs';

@Component({
  selector: 'app-index-search',
  standalone: true,
  imports: [],
  templateUrl: './index-search.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class IndexSearchComponent implements OnInit {
  service = inject(RegistryStateService);

  private searchDebounceTimer: any = null;

  scope = signal<'projects' | 'documents'>('projects');
  sortBy = signal<'relevance' | 'name'>('relevance');
  /** Rows added per "Load N more" — the profile's "Results per page" pref. */
  private pageSize = readPrefs().perPage;
  visibleCount = signal<number>(this.pageSize);

  readonly scopeTabs: { id: 'projects' | 'documents'; label: string }[] = [
    { id: 'projects', label: 'Projects' },
    { id: 'documents', label: 'Documents' }
  ];

  sortedProjects = computed(() => {
    const list = this.service.filteredProjects();
    if (list === null) return null;
    if (this.sortBy() !== 'name') return list;
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  });

  sortedDocuments = computed(() => {
    const list = this.service.filteredDocuments();
    if (list === null) return null;
    if (this.sortBy() !== 'name') return list;
    return [...list].sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  });

  pagedProjects = computed(() => (this.sortedProjects() || []).slice(0, this.visibleCount()));
  canLoadMore = computed(() => (this.sortedProjects() || []).length > this.visibleCount());

  // A table in its first load renders as skeleton rows rather than nothing, so the panel keeps its box.
  projectsSkeleton = computed(() => this.scope() !== 'documents' && this.service.projectsLoading() === 'first');
  documentsSkeleton = computed(() => this.scope() !== 'projects' && this.service.documentsLoading() === 'first');

  showProjectResults = computed(() => this.projectsSkeleton() || (this.scope() !== 'documents' && (this.sortedProjects() || []).length > 0));
  showDocumentResults = computed(() => this.documentsSkeleton() || (this.scope() !== 'projects' && (this.sortedDocuments() || []).length > 0));

  /** Both legs answered, both empty — distinct from the loading sentinel, which is null. */
  noResults = computed(() =>
    !!this.service.debouncedSearchQuery().trim() &&
    this.sortedProjects()?.length === 0 &&
    this.sortedDocuments()?.length === 0
  );

  indexSummary = computed(() => {
    const projects = this.service.resultCountLabel(this.sortedProjects()?.length, this.service.projectMatchCount());
    const documents = this.service.resultCountLabel(this.sortedDocuments()?.length, this.service.documentMatchCount());
    return `${projects} projects and ${documents} documents match.`;
  });

  resultSummary = computed(() => `Showing ${this.pagedProjects().length} of ${(this.sortedProjects() || []).length}`);

  /** Sectors present in the loaded corpus — a query with no hits gets offered real ones. */
  suggestions = computed(() =>
    this.service.sectorOptions().filter(o => o.value !== 'all').slice(0, 3).map(o => o.label)
  );

  constructor() {
    // A new result set starts at page one; without this a narrower search keeps the old page depth.
    effect(() => {
      this.service.filteredProjects();
      this.sortBy();
      untracked(() => this.visibleCount.set(this.pageSize));
    });
  }

  ngOnInit() {
    this.service.activePage.set('search');
  }

  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.service.searchQuery.set(value);

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.service.loadData();
    }, 300);
  }

  clearQuery() {
    this.service.searchQuery.set('');
    this.service.loadData();
  }

  applySuggestion(label: string) {
    this.service.searchQuery.set(label);
    this.service.loadData();
  }

  onSortChange(event: Event) {
    this.sortBy.set((event.target as HTMLSelectElement).value as 'relevance' | 'name');
  }

  loadMore() { this.visibleCount.set(this.visibleCount() + this.pageSize); }

  pillClass(state: string | undefined): string {
    return state === 'staged' ? 'pill--warning' : 'pill--success';
  }

  downloadError = signal<string | null>(null);
  downloadingId = signal<string | number | null>(null);

  async download(doc: Document) {
    if (this.downloadingId()) return;
    this.downloadingId.set(doc.id);
    this.downloadError.set(null);
    try {
      const url = await this.service.getDownloadUrl(String(doc.id), String(doc.projectId));
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      this.downloadError.set(err instanceof Error ? err.message : 'Could not prepare the download.');
    } finally {
      this.downloadingId.set(null);
    }
  }

  highlightText(text: string | undefined, query: string): string {
    return this.service.highlightText(text, query);
  }

  /** Prefer the index's own highlight; fall back to client marking. See the service. */
  highlightField(serverMarkup: string | undefined | null, text: string | undefined, query: string): string {
    return this.service.highlightField(serverMarkup, text, query);
  }
}
