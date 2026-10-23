import { useState } from 'react';
import { Settings2, Sparkles } from 'lucide-react';
import { Button, Field, Input, Select, toast } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { useProviders } from '@/lib/queries';
import { useBuilder } from './context';
import { providerMode } from './ProviderSection';
import { Callout } from './ui-bits';

export interface AiTuning { maxTokens: number; timeoutMs: number; temperature: number; key: string }

/** "Draft with AI" button for a text field, backed by POST /api/agents/elaborate. */
export default function AiAssist({ field, content, onResult, label = 'Draft with AI' }: { field: string; content: string; onResult: (text: string) => void; label?: string }) {
  const { def } = useBuilder();
  const providers = useProviders();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tune, setTune] = useState<AiTuning>({ maxTokens: 4096, timeoutMs: 180000, temperature: 0.7, key: '' });

  const run = async () => {
    setErr(null);
    const p = def.provider ?? {};
    const mode = providerMode(p);
    const ref = mode === 'ref' ? providers.data?.find((x) => x.id === p.providerRef || x.name === p.providerRef) : undefined;
    const provider: Record<string, unknown> = mode === 'ref'
      ? { type: ref?.type, baseUrl: ref?.baseUrl, model: p.model || ref?.defaultModel, providerRef: ref?.id ?? p.providerRef }
      : { type: p.type, baseUrl: p.baseUrl, model: p.model, providerApiKey: p.providerApiKey };
    if (tune.key.trim()) provider.providerApiKey = tune.key.trim();
    if (!provider.baseUrl || !provider.model) {
      setErr('Choose a provider and model in the “Provider & model” step first.');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ elaborated: string }>('/api/agents/elaborate', {
        method: 'POST',
        body: {
          field, content, provider,
          context: { metadata: def.metadata, task: def.task?.prompt ? def.task : undefined, tools: def.tools?.builtins?.all === false ? 'selected built-ins only' : 'all built-ins', mcp: def.mcp?.use },
          maxTokens: tune.maxTokens, timeoutMs: tune.timeoutMs, temperature: tune.temperature,
        },
      });
      onResult(r.elaborated);
      toast.ok('Draft ready — review and edit it.');
    } catch (e) {
      setErr(errMsg(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={run} loading={busy} type="button"><Sparkles className="size-3.5" />{label}</Button>
        <Button size="sm" variant="ghost" type="button" aria-label="AI settings" aria-expanded={open} onClick={() => setOpen(!open)}><Settings2 className="size-3.5" /></Button>
      </div>
      {open && (
        <div className="grid gap-3 rounded-lg border border-border bg-surface-2/50 p-3 sm:grid-cols-3">
          <Field label="Max tokens"><Input type="number" min={16} max={65536} value={tune.maxTokens} onChange={(e) => setTune({ ...tune, maxTokens: Number(e.target.value) || 4096 })} /></Field>
          <Field label="Timeout (ms)"><Input type="number" min={1000} max={900000} value={tune.timeoutMs} onChange={(e) => setTune({ ...tune, timeoutMs: Number(e.target.value) || 180000 })} /></Field>
          <Field label="Temperature"><Select value={String(tune.temperature)} onChange={(e) => setTune({ ...tune, temperature: Number(e.target.value) })}>
            {[0, 0.3, 0.5, 0.7, 1, 1.5].map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
          <Field label="API key override (optional)" className="sm:col-span-3" hint="Only for drafting: a key or ${ENV_VAR} to use when the selected provider's key cannot be resolved by the server. Never saved.">
            <Input type="password" autoComplete="off" value={tune.key} onChange={(e) => setTune({ ...tune, key: e.target.value })} placeholder="${OPENAI_API_KEY}" />
          </Field>
        </div>
      )}
      {err && <Callout tone="danger">{err}</Callout>}
    </div>
  );
}
