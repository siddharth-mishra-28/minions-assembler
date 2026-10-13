export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function statusBadge(s: string): string {
  const cls: Record<string, string> = { done: 'ok', running: 'run', failed: 'err', aborted: 'err', idle: 'idle', queued: 'idle' };
  return `<span class="badge ${cls[s] ?? 'idle'}">${esc(s)}</span>`;
}

export function fmtDuration(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtNum(n?: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}
