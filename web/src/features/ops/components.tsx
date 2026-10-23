import { useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Search } from 'lucide-react';
import { Badge, Button, Card, Input, PageHeader, Page, cn } from '@/components/ui';
import { copyText } from './lib';

/** Standard page chrome: the shell clips overflow, so each page owns its scroll container. */
export function OpsPage({ title, description, actions, children, narrow }: { title: string; description?: string; actions?: ReactNode; children: ReactNode; narrow?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={title} description={description} actions={actions} />
      <div className="min-h-0 flex-1 overflow-y-auto"><Page narrow={narrow}>{children}</Page></div>
    </div>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
export const runTone = (s: string | null | undefined): Tone =>
  s === 'done' || s === 'succeeded' || s === 'approved' ? 'ok'
    : s === 'failed' || s === 'error' || s === 'denied' ? 'danger'
      : s === 'running' || s === 'pending' ? 'warn'
        : s === 'queued' || s === 'idle' ? 'accent' : 'neutral';

export function RunStatus({ status }: { status: string | null | undefined }) {
  const s = status ?? 'unknown';
  return (
    <Badge tone={runTone(s)}>
      {s === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {s}
    </Badge>
  );
}

export const SourceBadge = ({ source }: { source: string | null | undefined }) =>
  <Badge tone={source === 'chat' ? 'accent' : 'neutral'}>{source === 'chat' ? 'chat' : 'run'}</Badge>;

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-xs font-medium text-muted">{label}{icon}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string | (() => string); label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  return (
    <Button size={size} variant="ghost" onClick={async () => { await copyText(typeof text === 'function' ? text() : text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}{label}
    </Button>
  );
}

export function CodeBlock({ text, className, maxHeight = 'max-h-72', copy }: { text: string; className?: string; maxHeight?: string; copy?: boolean }) {
  return (
    <div className={cn('group relative', className)}>
      <pre className={cn('overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed', maxHeight)}>{text}</pre>
      {copy && <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100"><CopyButton text={text} label="" /></div>}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'Search…'} className="pl-8" />
    </div>
  );
}

export function Pagination({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  if (total <= 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
      <span>{from}–{to} of {total.toLocaleString()}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft className="size-3.5" />Prev</Button>
        <Button size="sm" variant="ghost" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next<ChevronRight className="size-3.5" /></Button>
      </div>
    </div>
  );
}

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) =>
  <th className={cn('whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted', className)}>{children}</th>;
export const Td = ({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) =>
  <td title={title} className={cn('px-4 py-2.5 align-middle', className)}>{children}</td>;

export const ErrorNote = ({ error }: { error: unknown }) =>
  error ? <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error instanceof Error ? error.message : String(error)}</div> : null;

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <code className={cn('font-mono text-xs', className)}>{children}</code>;
