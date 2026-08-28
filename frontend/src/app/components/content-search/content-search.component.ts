import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';
import { DocumentChunk } from '../../models/registry.models';

/**
 * Search inside the extracted text of documents — the chunk leg of the pipeline, on a surface of
 * its own. Index Search matches metadata; this matches passages.
 */
@Component({
  selector: 'app-content-search',
  standalone: true,
  imports: [],
  templateUrl: './content-search.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ContentSearchComponent implements OnInit {
  service = inject(RegistryStateService);

  private searchDebounceTimer: any = null;

  copiedChunkId = signal<string | null>(null);
  downloadError = signal<string | null>(null);
  downloadingChunkId = signal<string | null>(null);

  chunkCount = computed(() =>
    this.service.resultCountLabel(this.service.documentChunks()?.length, this.service.chunkMatchCount())
  );

  noResults = computed(() =>
    !!this.service.debouncedSearchQuery().trim() && this.service.documentChunks()?.length === 0
  );

  /** Sectors present in the loaded corpus — a query with no hits gets offered real ones. */
  suggestions = computed(() =>
    this.service.sectorOptions().filter(o => o.value !== 'all').slice(0, 3).map(o => o.label)
  );

  ngOnInit() {
    this.service.activePage.set('search');
    this.service.loadDbStats();
  }

  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.service.searchQuery.set(value);

    // shortcut: set loading placeholder sentinel values immediately
    this.service.documentChunks.set(value ? null : []);

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

  chunkMeta(chunk: DocumentChunk): string {
    return [chunk.projectName, chunk.pageNumber != null ? `page ${chunk.pageNumber}` : ''].filter(Boolean).join(' · ');
  }

  async copyPassageId(chunk: DocumentChunk) {
    try {
      await navigator.clipboard.writeText(chunk.id);
      this.copiedChunkId.set(chunk.id);
      setTimeout(() => this.copiedChunkId.set(null), 2000);
    } catch (err) {
      console.warn('[ContentSearch] Clipboard write refused:', err);
    }
  }

  async openDocument(chunk: DocumentChunk) {
    if (this.downloadingChunkId()) return;
    this.downloadingChunkId.set(chunk.id);
    this.downloadError.set(null);
    try {
      const url = await this.service.getDownloadUrl(chunk.documentId, String(chunk.projectId));
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      this.downloadError.set(err instanceof Error ? err.message : 'Could not prepare the download.');
    } finally {
      this.downloadingChunkId.set(null);
    }
  }

  highlightText(text: string | undefined, query: string): string {
    return this.service.highlightText(text, query);
  }
}
