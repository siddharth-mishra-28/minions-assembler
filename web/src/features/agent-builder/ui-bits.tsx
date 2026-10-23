import { useState, type ReactNode } from 'react';
import { X, Plus, CircleCheck } from 'lucide-react';
import { cn, Input } from '@/components/ui';

export function SectionCard({ title, description, children, right }: { title: string; description?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {right}
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

export function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 text-sm text-muted">{description}</p>
    </div>
  );
}

export function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const cls = { info: 'border-accent/30 bg-accent/5', warn: 'border-warn/40 bg-warn/10', danger: 'border-danger/40 bg-danger/10', ok: 'border-ok/40 bg-ok/10' }[tone];
  return <div className={cn('rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed', cls)}>{children}</div>;
}

export interface RadioOption<T extends string> { value: T; title: string; desc?: string; badge?: string }

export function RadioCards<T extends string>({ value, onChange, options, label, cols = 3 }:
  { value: T; onChange: (v: T) => void; options: RadioOption<T>[]; label: string; cols?: 2 | 3 }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-2', cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cn('rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent',
              on ? 'border-accent bg-accent/5 ring-1 ring-accent' : 'border-border hover:bg-surface-2')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{o.title}</span>
              {o.badge && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">{o.badge}</span>}
              {on && !o.badge && <CircleCheck className="size-4 text-accent" />}
            </div>
            {o.desc && <p className="mt-1 text-xs text-muted">{o.desc}</p>}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; tone?: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', value === o.value ? cn('bg-surface shadow-sm', o.tone ?? 'text-fg') : 'text-muted hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Free-text chip list: Enter or comma adds, Backspace on empty removes last. */
export function ChipInput({ value, onChange, placeholder, label, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string; suggestions?: string[] }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const items = raw.split(',').map((s) => s.trim()).filter((s) => s && !value.includes(s));
    if (items.length) onChange([...value, ...items]);
    setText('');
  };
  const listId = `chips-${label.replace(/\W+/g, '-')}`;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-2 pr-1 text-xs">
            <span className="max-w-[28ch] truncate" title={v}>{v}</span>
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="rounded p-0.5 text-muted hover:bg-border hover:text-fg"><X className="size-3" /></button>
          </span>
        ))}
      </div>
      <div className={cn('flex gap-2', value.length && 'mt-2')}>
        <Input aria-label={label} list={suggestions ? listId : undefined} value={text} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); }
            else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)} />
        <button type="button" aria-label={`Add ${label}`} onClick={() => add(text)} disabled={!text.trim()} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"><Plus className="size-4" /></button>
      </div>
      {suggestions && <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

export const monoArea = 'font-mono text-xs leading-relaxed';

/** Like Field but safe for composite controls (no wrapping <label>, so clicks never trigger inner buttons). */
export function Group({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('space-y-1.5', className)}>
      <div className="text-xs font-medium text-muted">{label}</div>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
