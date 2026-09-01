import { Injectable, inject, signal } from '@angular/core';
import { RegistryStateService } from './registry-state.service';
import { apiRequest } from './api-request';

/** `GET /links` row shape — src/controllers/nosql/link.js `present()`. */
export interface ShortLink {
  id: string;
  url: string;
  note: string | null;
  shortUrl: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string | null;
  /** Hidden from other users' lists. `/s/:code` still redirects for anyone holding the URL. */
  personal: boolean;
}

@Injectable({ providedIn: 'root' })
export class LinksService {
  private registry = inject(RegistryStateService);

  links = signal<ShortLink[]>([]);
  error = signal<string>('');
  loading = signal<boolean>(false);

  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return apiRequest<T>(this.registry.getBasePath(), path, init);
  }

  private json(payload: unknown): RequestInit {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.links.set(await this.request<ShortLink[]>('/links'));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /** `code` blank means the API generates one. Returns false and sets `error` on refusal. */
  async create(url: string, note?: string, code?: string, personal = false): Promise<boolean> {
    return this.write('/links', { method: 'POST', ...this.json({ url, note: note || undefined, code: code || undefined, personal }) });
  }

  async repoint(code: string, url: string): Promise<boolean> {
    return this.write(`/links/${encodeURIComponent(code)}`, { method: 'PUT', ...this.json({ url }) });
  }

  async remove(code: string): Promise<boolean> {
    return this.write(`/links/${encodeURIComponent(code)}`, { method: 'DELETE' });
  }

  private async write(path: string, init: RequestInit): Promise<boolean> {
    this.error.set('');
    try {
      await this.request(path, init);
      await this.load();
      return true;
    } catch (err) {
      this.error.set((err as Error).message);
      return false;
    }
  }
}
