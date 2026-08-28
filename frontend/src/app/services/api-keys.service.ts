import { Injectable, computed, inject, signal } from '@angular/core';
import { RegistryStateService } from './registry-state.service';
import { apiRequest } from './api-request';

/** `GET /admin/api-keys` row — the record minus `hash` (src/repositories/api-keys.js `redact`). */
export interface ApiKey {
  id: string;
  name: string;
  roles: string[];
  projectScope: string[] | null;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface MintRequest {
  name: string;
  roles: string[];
  projectScope?: string[];
  expiresAt?: string;
  allowWrite?: boolean;
}

/** Mirrors GRANTABLE_ROLES in src/controllers/nosql/api-key.js. DEMI serves no roles endpoint. */
export const GRANTABLE_ROLES = [
  'sysadmin', 'staff', 'demi-admin', 'demi-service-read', 'demi-service-write', 'compliance', 'public'
];

/** Roles that can mutate data — picking one makes `allowWrite: true` mandatory on mint. */
export const WRITE_ROLES = ['sysadmin', 'staff', 'demi-admin', 'demi-service-write'];

export function grantsWrite(roles: string[]): boolean {
  return roles.some(r => WRITE_ROLES.includes(r));
}

export type KeyStatus = 'Revoked' | 'Expired' | 'Expiring' | 'Active';

/** How long before expiry a key starts warning. */
export const EXPIRING_SOON_DAYS = 30;

/** DEMI stores no status field; `revokedAt` and `expiresAt` are the whole of it. */
export function keyStatus(key: ApiKey, now = Date.now()): KeyStatus {
  if (key.revokedAt) return 'Revoked';
  const daysLeft = (new Date(key.expiresAt).getTime() - now) / 86_400_000;
  if (daysLeft <= 0) return 'Expired';
  if (daysLeft <= EXPIRING_SOON_DAYS) return 'Expiring';
  return 'Active';
}

@Injectable({ providedIn: 'root' })
export class ApiKeysService {
  private registry = inject(RegistryStateService);

  keys = signal<ApiKey[]>([]);
  error = signal<string>('');
  loading = signal<boolean>(false);

  /** Shown once, then gone — DEMI stores a hash and cannot reissue it. */
  mintedPlaintext = signal<string>('');

  counts = computed(() => {
    const statuses = this.keys().map(k => keyStatus(k));
    return {
      total: statuses.length,
      active: statuses.filter(s => s === 'Active' || s === 'Expiring').length,
      expiring: statuses.filter(s => s === 'Expiring').length,
      revoked: statuses.filter(s => s === 'Revoked').length
    };
  });

  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return apiRequest<T>(this.registry.getBasePath(), path, init);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.keys.set(await this.request<ApiKey[]>('/admin/api-keys'));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async mint(req: MintRequest): Promise<boolean> {
    this.error.set('');
    try {
      const created = await this.request<ApiKey & { key: string }>('/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      this.mintedPlaintext.set(created.key);
      await this.load();
      return true;
    } catch (err) {
      this.error.set((err as Error).message);
      return false;
    }
  }

  async revoke(id: string): Promise<boolean> {
    this.error.set('');
    try {
      await this.request(`/admin/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await this.load();
      return true;
    } catch (err) {
      this.error.set((err as Error).message);
      return false;
    }
  }

  /**
   * Mint the replacement first, then revoke — the consumer is never without a working credential,
   * and a failed revoke must not cost the caller a secret that is shown once.
   */
  async rotate(key: ApiKey): Promise<boolean> {
    const minted = await this.mint({
      name: key.name,
      roles: key.roles,
      ...(key.projectScope && key.projectScope.length ? { projectScope: key.projectScope } : {}),
      ...(grantsWrite(key.roles) ? { allowWrite: true } : {})
    });
    if (!minted) return false;
    return this.revoke(key.id);
  }

  dismissMinted(): void {
    this.mintedPlaintext.set('');
  }
}
