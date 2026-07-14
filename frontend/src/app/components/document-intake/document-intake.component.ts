import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegistryStateService } from '../../services/registry-state.service';
import { Project } from '../../models/registry.models';

@Component({
  selector: 'app-document-intake',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './document-intake.component.html',
  styleUrls: []
})
export class DocumentIntakeComponent implements OnInit {
  service = inject(RegistryStateService);

  ngOnInit() {
    this.service.activePage.set('intake');
  }

  onIntakeProjectSearch(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.service.intakeProjectSearchQuery.set(value);
    if (!value.trim()) {
      this.service.intakeProjectId.set('');
    }
  }

  selectIntakeProject(proj: Project) {
    this.service.intakeProjectId.set(String(proj.id));
    this.service.intakeProjectSearchQuery.set(proj.name);
    this.service.showIntakeDropdown.set(false);
  }

  onIntakeDropdownBlur() {
    setTimeout(() => {
      this.service.showIntakeDropdown.set(false);
      const currentId = this.service.intakeProjectId();
      const currentProj = (this.service.projects() || []).find(p => String(p.id) === currentId);
      if (currentProj) {
        this.service.intakeProjectSearchQuery.set(currentProj.name);
      } else {
        this.service.intakeProjectSearchQuery.set('');
      }
    }, 200);
  }

  isProjectSelected(id: string | number): boolean {
    return String(id) === this.service.intakeProjectId();
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
}
