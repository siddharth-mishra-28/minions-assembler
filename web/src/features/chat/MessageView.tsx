import { useState } from 'react';
import { AlertCircle, Brain, Check, ChevronRight, Loader2, Sparkles, StopCircle, Wrench, X } from 'lucide-react';
import type { ChatMessage, ToolCall } from '@/lib/types';
import { cn } from '@/components/ui';
import { CopyButton, Markdown } from './Markdown';
import { summarizeArgs } from './ApprovalCard';

export function ToolRow({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const arg = summarizeArgs(t.args);
  return (
    <div className="rounded-lg border border-border bg-surface text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight className={cn('size-3 text-muted transition-transform', open && 'rotate-90')} />
        <Wrench className="size-3 text-muted" />
        <span className="font-medium">{t.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted">{arg.split('\n')[0]}</span>
        {t.done === false || (t.done === undefined && t.success === undefined && t.result === undefined) ? <Loader2 className="size-3 animate-spin text-muted" />
          : t.success === false ? <X className="size-3.5 text-danger" /> : <Check className="size-3.5 text-ok" />}
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border p-2.5 font-mono">
          {arg && <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-muted">{arg}</pre>}
          {t.result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{t.result}</pre>}
        </div>
      )}
    </div>
  );
}

export function Reasoning({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-muted hover:text-fg">
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} /><Brain className="size-3" />{streaming ? 'Thinking…' : 'Reasoning'}
      </button>
      {open && <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-muted">{text}</div>}
    </div>
  );
}

export interface AssistantShape { text: string; reasoning?: string; tools?: ToolCall[]; model?: string; usage?: { tokensIn?: number; tokensOut?: number }; status?: string; error?: string }

export function AssistantBlock({ a, label, streaming, extra }: { a: AssistantShape; label: string; streaming?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="group flex gap-3 fade-in">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><Sparkles className="size-4" /></div>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex items-center gap-2 text-xs text-muted"><span className="font-medium text-fg">{label}</span>{a.model && <span>{a.model}</span>}</div>
        {a.reasoning ? <Reasoning text={a.reasoning} streaming={streaming} /> : null}
        {a.tools && a.tools.length > 0 && <div className="space-y-1.5">{a.tools.map((t) => <ToolRow key={t.callId} t={t} />)}</div>}
        {extra}
        {a.text ? <Markdown streaming={streaming}>{a.text}</Markdown> : streaming && !extra ? <div className="flex items-center gap-1.5 text-sm text-muted"><Loader2 className="size-3.5 animate-spin" />Working…</div> : null}
        {a.status === 'error' && <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"><AlertCircle className="mt-0.5 size-4 shrink-0" />{a.error ?? 'The turn failed.'}</div>}
        {a.status === 'cancelled' && <div className="flex items-center gap-1.5 text-xs text-muted"><StopCircle className="size-3.5" />Stopped</div>}
        {!streaming && (a.text || a.usage) && (
          <div className="flex items-center gap-3 text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
            {a.text && <CopyButton text={a.text} />}
            {a.usage?.tokensIn != null && <span>{a.usage.tokensIn.toLocaleString()} in · {(a.usage.tokensOut ?? 0).toLocaleString()} out tokens</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageView({ m, agentLabel }: { m: ChatMessage; agentLabel: string }) {
  if (m.role === 'system') {
    return <div className="flex items-center gap-3 py-1 text-xs text-muted"><div className="h-px flex-1 bg-border" /><span>{m.content}</span><div className="h-px flex-1 bg-border" /></div>;
  }
  if (m.role === 'user') {
    return (
      <div className="flex justify-end fade-in">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-accent-fg">{m.content}</div>
      </div>
    );
  }
  const meta = m.meta ?? {};
  const label = m.author && m.author !== 'assistant' ? m.author.split('@')[0] : agentLabel;
  return <AssistantBlock label={label} a={{ text: m.content, reasoning: meta.reasoning, tools: meta.tools, model: meta.model, usage: meta.usage, status: meta.status, error: meta.error }} />;
}
