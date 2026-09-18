import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { highlightParts } from './highlight';

/**
 * Marks search hits in plain text. The runs are rendered as text nodes rather than injected HTML,
 * so a record whose name contains markup stays text.
 */
@Component({
  selector: 'app-highlight',
  standalone: true,
  // No whitespace between the runs: a mid-word match must not gain a phantom space.
  template: `@for (part of parts(); track $index) {@if (part.hit) {<mark class="display-grid__hit">{{ part.text }}</mark>} @else {{{ part.text }}}}`,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class HighlightComponent {
  text = input('');
  /** Already split by `toTerms`. Empty leaves the text untouched. */
  terms = input<string[]>([]);

  parts = computed(() => highlightParts(this.text(), this.terms()));
}
