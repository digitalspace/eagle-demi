import { api, jsonBody } from './client';

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
  'sysadmin',
  'staff',
  'demi-admin',
  'demi-service-read',
  'demi-service-write',
  'compliance',
  'public',
];

/** Roles that can mutate data — picking one makes `allowWrite: true` mandatory on mint. */
export const WRITE_ROLES = ['sysadmin', 'staff', 'demi-admin', 'demi-service-write'];

export function grantsWrite(roles: string[]): boolean {
  return roles.some((role) => WRITE_ROLES.includes(role));
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

export interface KeyCounts {
  total: number;
  active: number;
  expiring: number;
  revoked: number;
}

export function keyCounts(keys: ApiKey[]): KeyCounts {
  const statuses = keys.map((key) => keyStatus(key));
  return {
    total: statuses.length,
    active: statuses.filter((s) => s === 'Active' || s === 'Expiring').length,
    expiring: statuses.filter((s) => s === 'Expiring').length,
    revoked: statuses.filter((s) => s === 'Revoked').length,
  };
}

export const listApiKeys = (): Promise<ApiKey[]> => api<ApiKey[]>('/admin/api-keys');

/** The plaintext on `key` is the only copy: DEMI stores a hash and cannot reissue it. */
export const mintApiKey = (req: MintRequest): Promise<ApiKey & { key: string }> =>
  api<ApiKey & { key: string }>('/admin/api-keys', jsonBody(req));

export const revokeApiKey = (id: string): Promise<void> =>
  api<void>(`/admin/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** The mint body that reproduces an existing key, for a rotation. */
export function replacementFor(key: ApiKey): MintRequest {
  return {
    name: key.name,
    roles: key.roles,
    ...(key.projectScope && key.projectScope.length ? { projectScope: key.projectScope } : {}),
    ...(grantsWrite(key.roles) ? { allowWrite: true } : {}),
  };
}
