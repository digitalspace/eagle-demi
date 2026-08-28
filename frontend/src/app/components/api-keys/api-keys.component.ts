import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ApiKey, ApiKeysService, GRANTABLE_ROLES, KeyStatus, grantsWrite, keyStatus } from '../../services/api-keys.service';

/** Status to pill modifier, from the demo spec's KEY_PILL. */
const PILL: Record<KeyStatus, string> = {
  Active: 'pill--success',
  Expiring: 'pill--warning',
  Expired: 'pill--neutral',
  Revoked: 'pill--neutral'
};

@Component({
  selector: 'app-api-keys',
  standalone: true,
  imports: [],
  templateUrl: './api-keys.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ApiKeysComponent implements OnInit {
  keys = inject(ApiKeysService);

  readonly grantableRoles = GRANTABLE_ROLES;

  mintOpen = signal(false);
  name = signal('');
  roles = signal<string[]>([]);
  scope = signal('');
  allowWrite = signal(false);

  /** The mint route refuses a write role unless allowWrite is confirmed, so the box only appears then. */
  needsAllowWrite = computed(() => grantsWrite(this.roles()));

  /** Nothing fetched yet. A later reload keeps the rows it has rather than falling back to skeletons. */
  firstLoad = computed(() => this.keys.loading() && !this.keys.keys().length);

  copied = signal(false);

  ngOnInit() {
    this.keys.load();
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  status(key: ApiKey): KeyStatus {
    return keyStatus(key);
  }

  pillClass(key: ApiKey): string {
    return PILL[keyStatus(key)];
  }

  when(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-CA', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  scopeLabel(key: ApiKey): string {
    return key.projectScope && key.projectScope.length ? key.projectScope.join(', ') : 'All projects';
  }

  hasRole(role: string): boolean {
    return this.roles().includes(role);
  }

  toggleRole(role: string) {
    this.roles.update(list => list.includes(role) ? list.filter(r => r !== role) : [...list, role]);
    if (!this.needsAllowWrite()) this.allowWrite.set(false);
  }

  toggleMint() {
    this.mintOpen.update(open => !open);
    this.keys.error.set('');
  }

  async mint() {
    const scope = this.scope().split(',').map(s => s.trim()).filter(Boolean);
    const minted = await this.keys.mint({
      name: this.name().trim(),
      roles: this.roles(),
      ...(scope.length ? { projectScope: scope } : {}),
      ...(this.needsAllowWrite() ? { allowWrite: this.allowWrite() } : {})
    });
    if (!minted) return;
    this.name.set('');
    this.roles.set([]);
    this.scope.set('');
    this.allowWrite.set(false);
    this.mintOpen.set(false);
  }

  async rotate(key: ApiKey) {
    if (!confirm(`Rotate ${key.name}? A replacement is minted first, then this key is revoked.`)) return;
    await this.keys.rotate(key);
  }

  async revoke(key: ApiKey) {
    if (!confirm(`Revoke ${key.name}? It stops authenticating immediately and cannot be restored.`)) return;
    await this.keys.revoke(key.id);
  }

  async copySecret() {
    await navigator.clipboard.writeText(this.keys.mintedPlaintext());
    this.copied.set(true);
  }

  dismiss() {
    this.copied.set(false);
    this.keys.dismissMinted();
  }
}
