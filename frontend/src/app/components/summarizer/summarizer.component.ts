import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegistryStateService } from '../../services/registry-state.service';

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
}
