import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegistryStateService } from '../../services/registry-state.service';
import { Document, SummaryCitation } from '../../models/registry.models';

/**
 * The AI Summary page. Step 5 of the search pipeline on a surface of its own — see wiki ADR-006.
 *
 * It briefly lived as a panel on deep-search, where it fired a model call on every debounced
 * keystroke of an ordinary keyword search. Here it runs only when someone asks a question.
 */
@Component({
  selector: 'app-summarizer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './summarizer.component.html',
  styleUrls: []
})
export class SummarizerComponent implements OnInit {
  service = inject(RegistryStateService);

  ngOnInit() {
    this.service.activePage.set('summary');
  }

  /**
   * Submit on Enter or on the button — NOT on input.
   *
   * Deep-search debounces keystrokes because its three legs are cheap index reads. This leg costs
   * tokens and several seconds, so it is explicit: the user finishes their question, then asks.
   */
  ask() {
    this.service.loadSummary();
  }

  onQueryInput(event: Event) {
    this.service.summaryQuery.set((event.target as HTMLInputElement).value);
  }

  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') this.ask();
  }

  // --- Source cards -------------------------------------------------------------------------
  // A citation carries documentId and projectId, both already resolved behind the caller's ACL, so
  // the card can open the document it points at without a second search.

  /** chunkId of the open card, or null. One at a time — this list sits under the answer. */
  expandedChunkId = signal<string | null>(null);
  expandedDoc = signal<Document | null>(null);
  detailLoading = signal(false);
  detailError = signal<string | null>(null);
  downloadingChunkId = signal<string | null>(null);
  downloadError = signal<string | null>(null);

  /** Re-opening a card the user already looked at should not hit the API again. */
  private docCache = new Map<string, Document>();

  async toggleCitation(c: SummaryCitation) {
    if (this.expandedChunkId() === c.chunkId) {
      this.expandedChunkId.set(null);
      return;
    }

    this.expandedChunkId.set(c.chunkId);
    this.detailError.set(null);
    this.downloadError.set(null);

    const cached = this.docCache.get(c.documentId);
    if (cached) {
      this.expandedDoc.set(cached);
      return;
    }

    this.expandedDoc.set(null);
    this.detailLoading.set(true);
    try {
      const doc = await this.service.fetchDocument(c.documentId, c.projectId);
      // A later click may have moved on while this was in flight — do not overwrite its state.
      if (this.expandedChunkId() !== c.chunkId) return;
      if (!doc) {
        this.detailError.set('That document is no longer available to you.');
        return;
      }
      this.docCache.set(c.documentId, doc);
      this.expandedDoc.set(doc);
    } catch (err) {
      console.error('[Summarizer] Failed to load cited document:', err);
      if (this.expandedChunkId() === c.chunkId) {
        this.detailError.set('Could not load the document details.');
      }
    } finally {
      this.detailLoading.set(false);
    }
  }

  async download(c: SummaryCitation) {
    if (this.downloadingChunkId()) return;
    this.downloadingChunkId.set(c.chunkId);
    this.downloadError.set(null);
    try {
      const url = await this.service.getDownloadUrl(c.documentId, c.projectId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      console.error('[Summarizer] Download failed:', err);
      this.downloadError.set(err instanceof Error ? err.message : 'Could not prepare the download.');
    } finally {
      this.downloadingChunkId.set(null);
    }
  }
}
