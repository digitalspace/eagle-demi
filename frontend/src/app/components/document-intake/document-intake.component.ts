import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';

@Component({
  selector: 'app-document-intake',
  standalone: true,
  imports: [],
  templateUrl: './document-intake.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class DocumentIntakeComponent implements OnInit {
  service = inject(RegistryStateService);

  dragging = signal<boolean>(false);

  ngOnInit() {
    this.service.activePage.set('intake');
  }

  onProjectChange(event: Event) {
    this.service.intakeProjectId.set((event.target as HTMLSelectElement).value);
  }

  triggerFileInput() {
    if (!this.service.intakeProjectValid()) return;
    const el = document.getElementById('fileInput') as HTMLInputElement;
    if (el) el.click();
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) return;
    await this.service.uploadDocument(file);
    input.value = '';
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (this.service.intakeProjectValid()) this.dragging.set(true);
  }

  onDragLeave() {
    this.dragging.set(false);
  }

  async onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file || !this.service.intakeProjectValid()) return;
    await this.service.uploadDocument(file);
  }
}
