import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertTriangle, Brain, ChevronDown, ChevronRight, Cog, MessageSquare, ShieldCheck, Wrench } from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui';
import { CodeBlock } from './components';
import { parseTs, pretty, safeParse, type RunEvent } from './lib';

type Cat = 'message' | 'tool' | 'reasoning' | 'permission' | 'error' | 'system';
interface Body { kind: 'text' | 'md' | 'json'; text: string }
export interface TimelineItem {
  key: string; seqs: [number, number]; type: string; cat: Cat; at: string; title: string; summary: string;
  body?: Body; extra?: Body; raw: unknown; ok?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : pretty(v));
const toolName = (d: any): string => d?.toolName ?? d?.tool_title ?? d?.toolTitle ?? d?.mcpToolName ?? d?.name ?? '';
const msgText = (o: any): string => str(o?.event?.data?.content ?? o?.event?.data?.text ?? o?.data?.content ?? o?.content ?? o?.text ?? '');
const oneLine = (s: string, n = 140): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

const categorize = (type: string): Cat =>
  /error|fail/.test(type) ? 'error'
    : type.startsWith('tool.') ? 'tool'
      : type === 'assistant.reasoning' ? 'reasoning'
        : type.startsWith('permission.') ? 'permission'
          : type === 'prompt.send' || type.startsWith('assistant.message') ? 'message' : 'system';

export function buildItems(events: RunEvent[]): TimelineItem[] {
  const names = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'tool.call') continue;
    const d = safeParse<any>(e.payload_json, {}).data;
    if (d?.toolCallId) names.set(d.toolCallId, toolName(d));
  }
  const items: TimelineItem[] = [];
  for (const e of events) {
    const o = safeParse<any>(e.payload_json, {});
    const base = { key: `e${e.seq}`, seqs: [e.seq, e.seq] as [number, number], type: e.type, cat: categorize(e.type), at: e.at, raw: o };
    const d = o?.data ?? {};
    switch (e.type) {
      case 'assistant.message_delta': {
        const last = items[items.length - 1];
        if (last?.type === 'assistant.message_delta' && last.body) { last.body.text += str(o.delta); last.seqs[1] = e.seq; last.summary = oneLine(last.body.text); }
        else items.push({ ...base, title: 'Streaming output', summary: oneLine(str(o.delta)), body: { kind: 'text', text: str(o.delta) } });
        break;
      }
      case 'assistant.message': { const t = msgText(o); items.push({ ...base, title: 'Assistant message', summary: oneLine(t), body: { kind: 'md', text: t } }); break; }
      case 'prompt.send': items.push({ ...base, title: 'Prompt sent', summary: oneLine(str(o.prompt)), body: { kind: 'text', text: str(o.prompt) } }); break;
      case 'assistant.reasoning': { const t = str(d.content ?? d.text ?? d.reasoningText ?? d); items.push({ ...base, title: 'Reasoning', summary: oneLine(t), body: { kind: 'text', text: t } }); break; }
      case 'tool.call': {
        let args: unknown = d.arguments ?? d.args ?? {};
        if (typeof args === 'string') args = safeParse(args, args);
        const empty = !args || (typeof args === 'object' && Object.keys(args as object).length === 0);
        items.push({ ...base, title: `Tool call · ${toolName(d) || 'tool'}`, summary: empty ? '' : oneLine(JSON.stringify(args)), body: empty ? undefined : { kind: 'json', text: pretty(args) } });
        break;
      }
      case 'tool.result': {
        const out = d.result?.content ?? d.result?.detailedContent ?? d.content ?? d.output ?? d.result ?? d.text;
        const failed = d.success === false || !!d.error || /fail/i.test(str(d.resultType));
        const name = names.get(d.toolCallId) || toolName(d);
        const text = out === undefined ? (d.error ? str(d.error?.message ?? d.error) : '') : str(out);
        items.push({ ...base, title: `Tool result${name ? ` · ${name}` : ''}`, summary: oneLine(text), ok: !failed, cat: failed ? 'error' : 'tool', body: text ? { kind: 'text', text: text.slice(0, 20000) } : undefined });
        break;
      }
      case 'tool.partial_result': case 'tool.progress': items.push({ ...base, title: e.type === 'tool.progress' ? 'Tool progress' : 'Tool partial result', summary: oneLine(str(d.progressMessage ?? d.content ?? d.partialOutput ?? '')) }); break;
      case 'permission.request': case 'permission.decision': {
        const dec = d.decision ?? d.result?.kind ?? d.kind ?? '';
        items.push({ ...base, title: e.type === 'permission.request' ? 'Permission requested' : 'Permission decision', summary: oneLine(`${dec} ${str(d.toolName ?? d.tool ?? d.fullCommandText ?? '')}`) });
        break;
      }
      case 'permission.ask_denied': case 'permission.destructive_denied':
        items.push({ ...base, cat: 'permission', title: e.type === 'permission.ask_denied' ? 'Ask deferred → denied' : 'Destructive gate denied', summary: oneLine(`${str(o.tool)} ${str(o.reason)}`), body: { kind: 'text', text: str(o.reason) }, ok: false });
        break;
      case 'run.error': items.push({ ...base, cat: 'error', title: 'Run error', summary: oneLine(str(o.error)), body: { kind: 'text', text: str(o.error) } }); break;
      case 'run.complete': items.push({ ...base, title: 'Run complete', summary: `${o.chars ?? 0} chars${o.durationMs ? ` · ${(o.durationMs / 1000).toFixed(1)}s` : ''}` }); break;
      case 'run.start': items.push({ ...base, title: 'Run started', summary: oneLine(`${o.agentId ?? ''} · audit ${o.auditLevel ?? 'default'}`) }); break;
      case 'session.create': case 'session.resume': items.push({ ...base, title: e.type === 'session.create' ? 'Session created' : 'Session resumed', summary: str(o.sessionId) }); break;
      case 'persona.resolved': items.push({ ...base, title: 'Persona resolved', summary: oneLine(str(o.summary)) }); break;
      case 'tools.resolved': items.push({ ...base, title: 'Tools policy', summary: oneLine(str(o.summary)) }); break;
      case 'usage.totals': items.push({ ...base, title: 'Usage totals', summary: oneLine(JSON.stringify(o)) }); break;
      case 'usage.capture': items.push({ ...base, title: 'Usage captured', summary: oneLine(JSON.stringify(o)) }); break;
      case 'assistant.usage': items.push({ ...base, title: 'Assistant usage', summary: oneLine(JSON.stringify(o.event?.data ?? o.event ?? o)) }); break;
      default: items.push({ ...base, title: e.type, summary: e.payload_json && e.payload_json !== '{}' ? oneLine(e.payload_json) : '' });
    }
  }
  return items;
}

/** Final answer: the last full assistant message (falls back to concatenated deltas). */
export function finalOutput(events: RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'assistant.message') { const t = msgText(safeParse<any>(events[i].payload_json, {})); if (t) return t; }
  }
  return events.filter((e) => e.type === 'assistant.message_delta').map((e) => str(safeParse<any>(e.payload_json, {}).delta)).join('');
}

/** Token totals derived from usage events when no usage row exists. */
export function usageFromEvents(events: RunEvent[]): { calls: number | null; tokensIn: number | null; tokensOut: number | null } | null {
  let totals: any = null;
  for (const e of events) if (e.type === 'usage.totals') totals = safeParse(e.payload_json, null);
  if (!totals) return null;
  return { calls: totals.calls ?? totals.APIcalls ?? null, tokensIn: totals.tokIn ?? totals.tokensIn ?? null, tokensOut: totals.tokOut ?? totals.tokensOut ?? null };
}

const catMeta: Record<Cat, { icon: ReactNode; tone: string; label: string }> = {
  message: { icon: <MessageSquare className="size-3.5" />, tone: 'text-accent', label: 'Messages' },
  tool: { icon: <Wrench className="size-3.5" />, tone: 'text-warn', label: 'Tools' },
  reasoning: { icon: <Brain className="size-3.5" />, tone: 'text-muted', label: 'Reasoning' },
  permission: { icon: <ShieldCheck className="size-3.5" />, tone: 'text-ok', label: 'Permissions' },
  error: { icon: <AlertTriangle className="size-3.5" />, tone: 'text-danger', label: 'Errors' },
  system: { icon: <Cog className="size-3.5" />, tone: 'text-muted', label: 'System' },
};

function BodyView({ body }: { body: Body }) {
  if (body.kind === 'md') return <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown>{body.text}</ReactMarkdown></div>;
  return <CodeBlock text={body.text} copy maxHeight="max-h-80" />;
}

function Row({ item, startMs, open, toggle }: { item: TimelineItem; startMs: number; open: boolean; toggle: () => void }) {
  const meta = catMeta[item.cat];
  const t = parseTs(item.at);
  const offset = Number.isNaN(t) || Number.isNaN(startMs) ? '' : `+${Math.max(0, (t - startMs) / 1000).toFixed(1)}s`;
  const seq = item.seqs[0] === item.seqs[1] ? `#${item.seqs[0]}` : `#${item.seqs[0]}–${item.seqs[1]}`;
  return (
    <div className={cn('rounded-lg border bg-surface', item.cat === 'error' ? 'border-danger/40' : 'border-border')}>
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <span className={cn('shrink-0', meta.tone)}>{meta.icon}</span>
        <span className="shrink-0 text-sm font-medium">{item.title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{item.summary}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted">{seq}</span>
        {offset && <span className="w-14 shrink-0 text-right font-mono text-[10px] text-muted">{offset}</span>}
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-muted" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-3">
          {item.body && <BodyView body={item.body} />}
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-muted hover:text-fg">Raw payload</summary>
            <CodeBlock text={pretty(item.raw).slice(0, 30000)} copy className="mt-1.5" />
          </details>
        </div>
      )}
    </div>
  );
}

export function Timeline({ events, live }: { events: RunEvent[]; live?: boolean }) {
  const items = useMemo(() => buildItems(events), [events]);
  const hasFinal = events.some((e) => e.type === 'assistant.message');
  const [showDeltas, setShowDeltas] = useState(false);
  const [cats, setCats] = useState<Set<Cat>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const startMs = parseTs(events[0]?.at);

  const visible = items.filter((i) => (showDeltas || !hasFinal || i.type !== 'assistant.message_delta') && (cats.size === 0 || cats.has(i.cat)));
  const counts = items.reduce<Record<string, number>>((a, i) => { a[i.cat] = (a[i.cat] ?? 0) + 1; return a; }, {});
  const isOpen = (i: TimelineItem) => open.has(i.key) || (i.cat === 'error' && !open.has(`!${i.key}`));
  const toggle = (i: TimelineItem) => setOpen((s) => {
    const n = new Set(s);
    if (isOpen(i)) { n.delete(i.key); n.add(`!${i.key}`); } else { n.add(i.key); n.delete(`!${i.key}`); }
    return n;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(catMeta) as Cat[]).filter((c) => counts[c]).map((c) => (
          <button key={c} onClick={() => setCats((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })}
            className={cn('flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors', cats.has(c) ? 'border-accent bg-accent/10 text-fg' : 'border-border text-muted hover:text-fg')}>
            <span className={catMeta[c].tone}>{catMeta[c].icon}</span>{catMeta[c].label}<span className="text-muted">{counts[c]}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {hasFinal && <Button size="sm" variant="ghost" onClick={() => setShowDeltas((v) => !v)}>{showDeltas ? 'Hide' : 'Show'} streamed chunks</Button>}
          <Button size="sm" variant="ghost" onClick={() => setOpen(new Set(visible.map((i) => i.key)))}>Expand all</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(new Set(items.filter((i) => i.cat === 'error').map((i) => `!${i.key}`)))}>Collapse all</Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted">{live ? 'Waiting for events…' : 'No events recorded for this run.'}</div>
      ) : (
        <div className="space-y-1.5">{visible.map((i) => <Row key={i.key} item={i} startMs={startMs} open={isOpen(i)} toggle={() => toggle(i)} />)}</div>
      )}
      {live && <div className="flex items-center gap-2 text-xs text-warn"><span className="size-1.5 animate-pulse rounded-full bg-warn" />Live — refreshing every 2s</div>}
      {!live && items.length > 0 && <Badge>{events.length} events</Badge>}
    </div>
  );
}
