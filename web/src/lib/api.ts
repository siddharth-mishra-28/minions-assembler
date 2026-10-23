export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const token = (): string | null => sessionStorage.getItem('minion.token');

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : typeof data === 'string' && data ? data : res.statusText) || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
