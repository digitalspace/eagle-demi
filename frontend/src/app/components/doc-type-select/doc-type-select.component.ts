import { Component, inject, input, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';

/**
 * The document type picker, shared by Index Search and Content Search.
 *
 * Each screen keeps its own `docTypeOptions().length` guard because each owns the row this sits
 * in: an empty lookup has to take that row with it rather than leave it behind, empty.
 */
@Component({
  selector: 'app-doc-type-select',
  standalone: true,
  imports: [],
  templateUrl: './doc-type-select.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class DocTypeSelectComponent {
  service = inject(RegistryStateService);

  /** Names what is being narrowed — documents on one screen, passages on the other. */
  ariaLabel = input.required<string>();

  onDocTypeChange(event: Event) {
    this.service.setDocType((event.target as HTMLSelectElement).value);
  }
}
