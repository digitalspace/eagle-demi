import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';
import { Project, Document } from '../../models/registry.models';

@Component({
  selector: 'app-deep-search',
  standalone: true,
  imports: [],
  templateUrl: './deep-search.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class DeepSearchComponent implements OnInit {
  service = inject(RegistryStateService);

  private searchDebounceTimer: any = null;

  ngOnInit() {
    this.service.activePage.set('search');
  }

  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.service.searchQuery.set(value);

    // shortcut: set loading placeholder sentinel values immediately
    this.service.projects.set(null);
    if (value) {
      this.service.documents.set(null);
      this.service.documentChunks.set(null);
    } else {
      this.service.documents.set([]);
      this.service.documentChunks.set([]);
    }

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.service.loadData();
    }, 300);
  }

  selectProject(proj: Project) {
    this.service.selectProject(proj);
  }

  selectDocument(doc: Document) {
    this.service.selectDocument(doc);
  }

  highlightText(text: string, query: string): string {
    return this.service.highlightText(text, query);
  }

  /** Prefer the index's own highlight; fall back to client marking. See the service. */
  highlightField(serverMarkup: string | undefined | null, text: string, query: string): string {
    return this.service.highlightField(serverMarkup, text, query);
  }
}
