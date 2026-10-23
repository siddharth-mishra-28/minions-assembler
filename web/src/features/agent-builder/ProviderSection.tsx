import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Loader2, Settings2 } from 'lucide-react';
import { Badge, Field, Input, Select } from '@/components/ui';
import { useProviders } from '@/lib/queries';
import { useBuilder, useField } from './context';
import { useProviderModels } from './hooks';
import { Callout, Group, RadioCards, SectionCard, SectionTitle } from './ui-bits';
import { PROVIDER_PRESETS, type Def } from './model';

export type ProviderMode = 'ref' | 'custom';

export const providerMode = (p: Def | undefined): ProviderMode =>
  p && p.providerRef === undefined && (p.type || p.baseUrl || p.providerApiKey || p.credentialEnv) ? 'custom' : 'ref';

export default function ProviderSection() {
  const { def, setDef } = useBuilder();
  const providers = useProviders();
  const mode = providerMode(def.provider);

  const switchMode = (m: ProviderMode) => {
    if (m === mode) return;
    setDef((d: Def) => {
      const model = d.provider?.model ?? '';
      if (m === 'ref') return { ...d, provider: { providerRef: '', model } };
      return { ...d, provider: { type: 'openai', baseUrl: PROVIDER_PRESETS[0].baseUrl, providerApiKey: '', model } };
    });
  };

  return (
    <div className="space-y-5">
      <SectionTitle title="Provider & model" description="Choose the language model that powers this agent." />
      <RadioCards<ProviderMode> label="Provider source" cols={2} value={mode} onChange={switchMode} options={[
        { value: 'ref', title: 'Use a configured provider', badge: 'Recommended', desc: 'Pick a provider you set up once in Settings. Keys stay out of the agent definition.' },
        { value: 'custom', title: 'Advanced: custom endpoint + API key', desc: 'Embed a base URL and key (or ${ENV_VAR}) directly in this agent.' },
      ]} />
      {mode === 'ref' ? <RefProvider loading={providers.isLoading} /> : <CustomProvider />}
    </div>
  );
}

function RefProvider({ loading }: { loading: boolean }) {
  const { set, def } = useBuilder();
  const providers = useProviders();
  const ref = useField<string>('provider.providerRef', '');
  const model = useField<string>('provider.model', '');
  const list = providers.data ?? [];
  const matched = useMemo(() => list.find((p) => p.id === ref.value || p.name === ref.value), [list, ref.value]);
  const models = useProviderModels(matched?.id);

  // Auto-select the default provider on a fresh agent.
  useEffect(() => {
    if (!list.length || ref.value || def.provider?.model) return;
    const p = list.find((x) => x.isDefault) ?? list[0];
    set('provider.providerRef', p.id);
    if (p.defaultModel) set('provider.model', p.defaultModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  const pick = (id: string) => {
    const p = list.find((x) => x.id === id);
    set('provider.providerRef', id);
    if (p?.defaultModel && (!model.value || model.value === matched?.defaultModel)) set('provider.model', p.defaultModel);
  };

  if (!loading && list.length === 0) {
    return (
      <Callout tone="warn">
        <div className="flex items-start gap-2">
          <Settings2 className="mt-0.5 size-4 shrink-0" />
          <div>
            <b>No providers configured yet.</b> Add one in <Link to="/settings" className="font-medium text-accent underline">Settings</Link> (OpenAI, Anthropic, Azure, Ollama…) and come back, or switch to the advanced custom endpoint above.
          </div>
        </div>
      </Callout>
    );
  }

  return (
    <SectionCard title="Configured provider" description="Resolved at run time, so rotating a key in Settings updates every agent that uses it.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider *" error={ref.error}>
          <Select value={matched?.id ?? ref.value} onChange={(e) => pick(e.target.value)}>
            {!matched && <option value={ref.value}>{ref.value ? `${ref.value} (not found)` : 'Select a provider…'}</option>}
            {list.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''} — {p.type}</option>)}
          </Select>
        </Field>
        <Field label="Model *" error={model.error}
          hint={models.isFetching ? 'Loading available models…' : models.isError ? 'Could not list models; type one manually.' : models.data ? `${models.data.length} models available — pick or type your own.` : undefined}>
          <div className="relative">
            <Input list="provider-models" value={model.value} onChange={(e) => model.set(e.target.value)} placeholder={matched?.defaultModel || 'model name'} />
            {models.isFetching && <Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-muted" />}
          </div>
          <datalist id="provider-models">{(models.data ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
      </div>
      {matched && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge>{matched.type}</Badge>
          {matched.baseUrl && <span className="truncate font-mono">{matched.baseUrl}</span>}
          <Badge tone={matched.hasKey ? 'ok' : 'warn'}><KeyRound className="size-3" />{matched.hasKey ? 'key configured' : 'no key'}</Badge>
        </div>
      )}
    </SectionCard>
  );
}

function CustomProvider() {
  const { def, setDef } = useBuilder();
  const type = useField<string>('provider.type', 'openai');
  const baseUrl = useField<string>('provider.baseUrl', '');
  const model = useField<string>('provider.model', '');
  const key = useField<string>('provider.providerApiKey', '');
  const wire = useField<string>('provider.wireApi', '');
  const azure = useField<string>('provider.azureApiVersion', '');
  const sealed = key.value.startsWith('enc:v1:');

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setDef((d: Def) => ({
      ...d,
      provider: {
        ...d.provider, type: p.type, baseUrl: p.baseUrl, model: p.model || d.provider?.model || '',
        providerApiKey: d.provider?.providerApiKey && !String(d.provider.providerApiKey).startsWith('${') ? d.provider.providerApiKey : `\${${p.env}}`,
      },
    }));
  };

  return (
    <SectionCard title="Custom endpoint" description="Use only when this agent needs credentials or an endpoint that is not configured in Settings.">
      <Group label="Quick presets">
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => applyPreset(p.id)} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-surface-2">{p.label}</button>
          ))}
        </div>
      </Group>
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <Field label="Type *" error={type.error}>
          <Select value={type.value} onChange={(e) => type.set(e.target.value)}>
            <option value="openai">openai (OpenAI-compatible)</option><option value="anthropic">anthropic</option><option value="azure">azure</option>
          </Select>
        </Field>
        <Field label="Base URL *" error={baseUrl.error}>
          <Input value={baseUrl.value} onChange={(e) => baseUrl.set(e.target.value)} placeholder="https://api.openai.com/v1" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model *" error={model.error}><Input value={model.value} onChange={(e) => model.set(e.target.value)} placeholder="gpt-4o" /></Field>
        <Field label="Wire API" hint="Leave on default unless your endpoint needs the Responses API.">
          <Select value={wire.value} onChange={(e) => wire.set(e.target.value || undefined)}>
            <option value="">default</option><option value="completions">completions</option><option value="responses">responses</option>
          </Select>
        </Field>
      </div>
      {type.value === 'azure' && <Field label="Azure API version"><Input value={azure.value} onChange={(e) => azure.set(e.target.value)} placeholder="2024-10-21" /></Field>}
      <Field label="API key *" error={key.error}
        hint={sealed ? 'An encrypted key is already stored with this agent. Type to replace it.' : <>Paste a key (sealed with AES-256-GCM on save) or reference an environment variable such as <code>{'${OPENAI_API_KEY}'}</code>.</>}>
        <Input type={key.value.startsWith('${') ? 'text' : 'password'} autoComplete="off" value={sealed ? '' : key.value}
          placeholder={sealed ? '•••••••• (stored encrypted)' : '${OPENAI_API_KEY} or sk-…'}
          onChange={(e) => key.set(e.target.value)} />
      </Field>
      {def.provider?.credentialEnv && <Callout tone="warn">This definition uses the legacy <code>credentialEnv</code> field. Edit it in the JSON tab or replace it with an API key above.</Callout>}
    </SectionCard>
  );
}
