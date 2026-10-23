import { useEffect, useState } from 'react';
import { toast } from '@/components/ui';

export interface RunRow {
  id: string; agent_id: string | null; session_id: string | null; trace_id: string | null; status: string; model: string | null;
  provider_type: string | null; task_prompt: string | null; definition_hash: string | null; created_at: string; finished_at: string | null;
  error: string | null; source: string | null; thread_id: string | null; project_id: string | null;
}

export interface AuditRun {
  id: string; agent_id: string | null; status: string; model: string | null; provider_type: string | null; source: string | null;
  thread_id: string | null; project_id: string | null; created_at: string; finished_at: string | null; error: string | null;
  prompt: string | null; has_audit: number; tokens_in: number | null; tokens_out: number | null; duration_ms: number | null; project_name: string | null;
}

export interface RunEvent { seq: number; type: string; payload_json: string; at: string; persisted?: number }

export interface RunUsage { tokens_in: number | null; tokens_out: number | null; credits: number | null; duration_ms: number | null; endpoint: string | null }

export interface AuditBundle {
  run: RunRow; usage: RunUsage | null; events: RunEvent[];
  approvals: { id: string; threadId: string | null; runId: string | null; tool: string; args: unknown; status: string; scope: string | null; decidedBy: string | null; reason: string | null; requestedAt: string; decidedAt: string | null }[];
}

export const opsKeys = {
  runs: ['ops', 'runs'] as const,
  sessions: ['ops', 'sessions'] as const,
  bundle: (id: string) => ['ops', 'bundle', id] as const,
  agents: ['ops', 'agents'] as const,
  mcp: ['ops', 'mcp'] as const,
  approvals: ['ops', 'approvals'] as const,
  retention: ['ops', 'retention'] as const,
};

export const qs = (o: Record<string, string | number | boolean | null | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const token = (): string | null => sessionStorage.getItem('minion.token');
const authHeaders = (): Record<string, string> => { const t = token(); return t ? { authorization: `Bearer ${t}` } : {}; };

/** Like api() but never throws on HTTP errors, so callers can read structured error bodies (diagnosis, authHint, autoFix). */
export async function apiRaw<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export async function downloadFromApi(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
  downloadBlob(await res.blob(), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast.ok(what); } catch { toast.error('Clipboard unavailable'); }
}

export const parseTs = (iso: string | null | undefined): number => {
  if (!iso) return NaN;
  return new Date(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime();
};

export const fmtNum = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString());

export const fmtCompact = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtDate = (iso: string | null | undefined): string => {
  const t = parseTs(iso);
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
};

/** Prefer recorded usage duration; otherwise wall-clock (elapsed-so-far for running runs). */
export function runDuration(r: { status: string; created_at: string; finished_at: string | null }, usageMs?: number | null): number | null {
  if (usageMs !== null && usageMs !== undefined && usageMs > 0) return usageMs;
  const start = parseTs(r.created_at);
  const end = r.finished_at ? parseTs(r.finished_at) : r.status === 'running' ? Date.now() : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

export const safeParse = <T = unknown>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export const pretty = (v: unknown): string => {
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  try { return JSON.stringify(v, null, 2) ?? ''; } catch { return String(v); }
};

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const RUN_STATUSES = ['running', 'done', 'failed', 'aborted'] as const;
