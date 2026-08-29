/** Goes through the app's global fetch override, which attaches the bearer for API URLs. */
export async function apiRequest<T>(basePath: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${basePath}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Request failed (HTTP ${res.status})`);
  return body as T;
}
