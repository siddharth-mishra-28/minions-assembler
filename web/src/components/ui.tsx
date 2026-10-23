import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import clsx from 'clsx';
import { Check, Loader2, X, AlertTriangle, Info } from 'lucide-react';

export const cn = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'bg-surface-2 text-fg border border-border hover:bg-border/60',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20',
};

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm', variants[variant], className)}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label}
      className={cn('inline-flex size-8 items-center justify-center rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors disabled:opacity-40', className)}>
      {children}
    </button>
  );
}

const field = 'w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted/70 focus:outline-2 focus:outline-accent/60 focus:border-accent disabled:opacity-60';
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cn(field, 'h-9', className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cn(field, 'py-2 leading-relaxed', className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cn(field, 'h-9 pr-8', className)} />;

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="block text-xs text-danger">{error}</span> : hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div><div className="text-sm font-medium">{label}</div>{description && <div className="text-xs text-muted mt-0.5">{description}</div>}</div>
      <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-border')}>
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-border bg-surface', className)}>{children}</div>;
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted', ok: 'bg-ok/15 text-ok', warn: 'bg-warn/15 text-warn', danger: 'bg-danger/15 text-danger', accent: 'bg-accent/15 text-accent',
};
export const Badge = ({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) =>
  <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;

export const statusTone = (s: string | null | undefined): Tone =>
  s === 'succeeded' || s === 'done' || s === 'approved' ? 'ok' : s === 'failed' || s === 'error' || s === 'denied' ? 'danger' : s === 'running' || s === 'pending' ? 'warn' : s === 'cancelled' || s === 'expired' ? 'neutral' : 'neutral';

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('size-4 animate-spin text-muted', className)} />;

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {icon && <div className="flex size-12 items-center justify-center rounded-xl bg-surface-2 text-muted">{icon}</div>}
      <div className="text-sm font-semibold">{title}</div>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-8 py-5">
      <div><h1 className="text-lg font-semibold tracking-tight">{title}</h1>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={cn('mx-auto w-full px-8 py-6', narrow ? 'max-w-3xl' : 'max-w-6xl')}>{children}</div>;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div role="tablist" className="inline-flex gap-1 rounded-lg bg-surface-2 p-1">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}
          className={cn('rounded-md px-3 py-1 text-sm transition-colors', value === i.id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>{i.label}</button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }:
  { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cn('fade-in relative flex max-h-[85vh] w-full flex-col rounded-xl border border-border bg-surface shadow-2xl', width)}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>, document.body);
}

interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }
const useToasts = create<{ items: Toast[]; push: (kind: Toast['kind'], text: string) => void; dismiss: (id: number) => void }>((set) => ({
  items: [],
  push: (kind, text) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
export const toast = {
  ok: (t: string) => useToasts.getState().push('ok', t),
  error: (t: string) => useToasts.getState().push('error', t),
  info: (t: string) => useToasts.getState().push('info', t),
};
export function Toaster() {
  const { items, dismiss } = useToasts();
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} onClick={() => dismiss(t.id)} className="fade-in flex max-w-sm cursor-pointer items-start gap-2 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm shadow-lg">
          {t.kind === 'ok' ? <Check className="mt-0.5 size-4 text-ok" /> : t.kind === 'error' ? <AlertTriangle className="mt-0.5 size-4 text-danger" /> : <Info className="mt-0.5 size-4 text-accent" />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>, document.body);
}

export function ConfirmButton({ onConfirm, children, confirmLabel = 'Confirm?', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { onConfirm: () => void; confirmLabel?: string; variant?: Variant; size?: Size; loading?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  return <Button {...rest} variant={armed ? 'danger' : rest.variant ?? 'ghost'} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>{armed ? confirmLabel : children}</Button>;
}

export const timeAgo = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
