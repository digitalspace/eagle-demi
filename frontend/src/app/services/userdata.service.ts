import { Injectable, inject, signal } from '@angular/core';
import { RegistryStateService } from './registry-state.service';
import { apiRequest } from './api-request';
import { Prefs } from '../shell/prefs';

/** `GET /me/data` lasso row — src/controllers/nosql/userdata.js `presentLasso()`. */
export interface SavedLasso {
  slug: string;
  name: string;
  ring: number[][];
  updatedAt: string;
}

interface MyData {
  prefs: Prefs;
  lassos: SavedLasso[];
}

@Injectable({ providedIn: 'root' })
export class UserdataService {
  private registry = inject(RegistryStateService);

  lassos = signal<SavedLasso[]>([]);
  /** null until `/me/data` has answered — the API always sends prefs, defaulted when unset. */
  prefs = signal<Prefs | null>(null);
  error = signal<string>('');
  loading = signal<boolean>(false);

  // Budget for `GET /me/data`. Startup awaits this read before opening the authReady gate, so a
  // hung API must not hold the route guards open. Static so a spec can shorten it, as /api/me does.
  static myDataTimeoutMs = 5000;

  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return apiRequest<T>(this.registry.getBasePath(), path, init);
  }

  private json(payload: unknown): RequestInit {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  }

  async loadMyData(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      // An abort lands in the catch below like any other failure: the caller keeps localStorage.
      const data = await this.request<MyData>('/me/data', {
        signal: AbortSignal.timeout(UserdataService.myDataTimeoutMs)
      });
      this.lassos.set(data.lassos || []);
      this.prefs.set(data.prefs || null);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /** Upserts by the slug the API derives from `name`. Returns false and sets `error` on refusal. */
  async saveLasso(name: string, ring: number[][]): Promise<boolean> {
    return this.write('/me/lassos', { method: 'PUT', ...this.json({ name, ring }) });
  }

  async deleteLasso(slug: string): Promise<boolean> {
    return this.write(`/me/lassos/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  }

  /** No reload: the caller already holds the values, and localStorage is written before this runs. */
  async putPrefs(prefs: Prefs): Promise<boolean> {
    this.error.set('');
    try {
      this.prefs.set(await this.request<Prefs>('/me/prefs', { method: 'PUT', ...this.json(prefs) }));
      return true;
    } catch (err) {
      this.error.set((err as Error).message);
      return false;
    }
  }

  private async write(path: string, init: RequestInit): Promise<boolean> {
    this.error.set('');
    try {
      await this.request(path, init);
      await this.loadMyData();
      return true;
    } catch (err) {
      this.error.set((err as Error).message);
      return false;
    }
  }
}
