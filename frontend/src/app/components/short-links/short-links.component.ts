import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { LinksService, ShortLink } from '../../services/links.service';
import { RegistryStateService } from '../../services/registry-state.service';

@Component({
  selector: 'app-short-links',
  standalone: true,
  imports: [],
  templateUrl: './short-links.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ShortLinksComponent implements OnInit {
  links = inject(LinksService);
  private registry = inject(RegistryStateService);

  formOpen = signal(false);
  newUrl = signal('');
  newCode = signal('');
  newNote = signal('');
  newPersonal = signal(false);

  /** Lowercased both sides: the API stores `createdBy` lowercased, the token claim is not. */
  private me = computed(() =>
    (this.registry.isAuthenticated() ? this.registry.keycloak?.tokenParsed?.preferred_username || '' : '').toLowerCase()
  );

  /** Mine first, then everyone's. Empty groups are dropped rather than shown as a bare heading. */
  linkGroups = computed<{ title: string; rows: ShortLink[] }[]>(() => {
    const me = this.me();
    const mine = me ? this.links.links().filter(l => (l.createdBy || '').toLowerCase() === me) : [];
    const shared = this.links.links().filter(l => !mine.includes(l));
    return [
      { title: 'My links', rows: mine },
      { title: 'Shared links', rows: shared }
    ].filter(g => g.rows.length > 0);
  });

  /** Code of the row being repointed, '' when none. */
  editingCode = signal('');
  editUrl = signal('');

  /** Code whose short URL was last copied, so the row can confirm it. */
  copiedCode = signal('');

  ngOnInit() {
    this.links.load();
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** ISO timestamp to the spec's "24 Aug". */
  shortDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-CA', { day: '2-digit', month: 'short' });
  }

  toggleForm() {
    this.formOpen.update(open => !open);
    this.links.error.set('');
  }

  async submit() {
    const url = this.newUrl().trim();
    if (!url) return;
    const created = await this.links.create(url, this.newNote().trim(), this.newCode().trim(), this.newPersonal());
    if (!created) return;
    this.newUrl.set('');
    this.newCode.set('');
    this.newNote.set('');
    this.newPersonal.set(false);
    this.formOpen.set(false);
  }

  startRepoint(link: ShortLink) {
    this.editingCode.set(link.id);
    this.editUrl.set(link.url);
    this.links.error.set('');
  }

  cancelRepoint() {
    this.editingCode.set('');
  }

  async saveRepoint(code: string) {
    const url = this.editUrl().trim();
    if (!url) return;
    if (await this.links.repoint(code, url)) this.editingCode.set('');
  }

  async remove(link: ShortLink) {
    if (!confirm(`Delete ${link.shortUrl}? Anything already printed with this link stops working.`)) return;
    await this.links.remove(link.id);
  }

  async copy(link: ShortLink) {
    await navigator.clipboard.writeText(link.shortUrl);
    this.copiedCode.set(link.id);
  }
}
