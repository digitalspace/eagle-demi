import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegistryStateService } from '../../services/registry-state.service';
import { SummaryCitation } from '../../models/registry.models';

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
  changeDetection: ChangeDetectionStrategy.Eager,
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
   * Index search debounces keystrokes because its legs are cheap index reads. This leg costs
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

  // A citation carries documentId and projectId, both already resolved behind the caller's ACL,
  // so the row can fetch its own download link without a second search.
  downloadingChunkId = signal<string | null>(null);
  downloadError = signal<string | null>(null);

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
