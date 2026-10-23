import { useEffect, useState } from 'react';
import { CheckCircle2, Pencil, Plus, Star, Trash2, Zap } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { qk, useApiMutation, useBootstrap, useProviders, useSettings } from '@/lib/queries';
import type { AppSettings, ApprovalMode, Provider } from '@/lib/types';
import { ProviderForm } from '@/features/providers/ProviderForm';
import { Badge, Button, Card, ConfirmButton, EmptyState, Field, IconButton, Input, Modal, Page, PageHeader, Select, Spinner, Tabs, Textarea, Toggle, timeAgo, toast } from '@/components/ui';

type Tab = 'providers' | 'defaults' | 'approvals' | 'data' | 'about';

function ProvidersTab() {
  const { data: providers = [], isLoading } = useProviders();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const del = useApiMutation((id: string) => api(`/api/providers/${id}`, { method: 'DELETE' }), { invalidate: [qk.providers, qk.bootstrap], onSuccess: () => toast.ok('Provider removed') });
  const mkDefault = useApiMutation((id: string) => api(`/api/providers/${id}/default`, { method: 'POST' }), { invalidate: [qk.providers, qk.bootstrap] });
  const test = async (p: Provider) => {
    setTesting(p.id);
    try { const r = await api<{ message: string }>(`/api/providers/${p.id}/test`, { method: 'POST' }); toast.ok(`${p.name}: ${r.message}`); }
    catch (e) { toast.error(`${p.name}: ${errMsg(e)}`); } finally { setTesting(null); }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Model providers power the default Copilot agent and any custom agent that references them. Keys are kept in the encrypted vault.</p>
        <Button variant="primary" onClick={() => setEditing('new')}><Plus className="size-4" />Add provider</Button>
      </div>
      {isLoading ? <Spinner /> : providers.length === 0 ? <Card><EmptyState title="No providers yet" description="Add a provider to start chatting." /></Card> : (
        <div className="space-y-2">
          {providers.map((p) => (
            <Card key={p.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="font-medium">{p.name}</span>
                  {p.isDefault && <Badge tone="accent"><Star className="size-3" />Default</Badge>}
                  <Badge>{p.type}</Badge>{!p.hasKey && <Badge tone="warn">No key</Badge>}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted">{p.baseUrl}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</div>
              </div>
              <Button size="sm" loading={testing === p.id} onClick={() => test(p)}><Zap className="size-3.5" />Test</Button>
              {!p.isDefault && <Button size="sm" variant="ghost" onClick={() => mkDefault.mutate(p.id)}>Make default</Button>}
              <IconButton label="Edit" onClick={() => setEditing(p)}><Pencil className="size-4" /></IconButton>
              <ConfirmButton size="sm" onConfirm={() => del.mutate(p.id)} confirmLabel="Delete?"><Trash2 className="size-3.5" /></ConfirmButton>
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add provider' : 'Edit provider'} width="max-w-xl">
        {editing && <ProviderForm key={editing === 'new' ? 'new' : editing.id} existing={editing === 'new' ? undefined : editing} firstRun={providers.length === 0} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}

function useSave() {
  return useApiMutation((body: Record<string, unknown>) => api<AppSettings>('/api/settings', { method: 'PATCH', body }), {
    invalidate: [qk.settings, qk.bootstrap, qk.providers], onSuccess: () => toast.ok('Settings saved'),
  });
}

function DefaultsTab({ s }: { s: AppSettings }) {
  const { data: providers = [] } = useProviders();
  const save = useSave();
  const [providerId, setProviderId] = useState(s.defaults.providerId ?? '');
  const [model, setModel] = useState(s.defaults.model ?? '');
  const [prompt, setPrompt] = useState(s.defaults.systemPrompt);
  const [models, setModels] = useState<string[]>([]);
  const pid = providerId || providers.find((p) => p.isDefault)?.id || '';
  useEffect(() => {
    setModels([]);
    if (!pid) return;
    api<{ models: string[] }>(`/api/providers/${pid}/models`).then((r) => setModels(r.models)).catch(() => undefined);
  }, [pid]);
  return (
    <Card className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Default provider" hint="Used by the built-in Copilot agent."><Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">Provider marked as default</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Default model" hint="Empty = the provider's default model.">
          {models.length ? <Select value={model} onChange={(e) => setModel(e.target.value)}><option value="">Provider default</option>{models.map((m) => <option key={m}>{m}</option>)}</Select>
            : <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Provider default" />}
        </Field>
      </div>
      <Field label="Extra system instructions" hint="Appended to the built-in Copilot agent's instructions in every chat."><Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ defaults: { providerId: providerId || null, model: model || null, systemPrompt: prompt } })}>Save</Button></div>
    </Card>
  );
}

const modes: { id: ApprovalMode; title: string; desc: string }[] = [
  { id: 'interactive', title: 'Ask me (recommended)', desc: 'Pause and ask before running commands or changing files that need permission. You choose Allow once, for this chat or for this project.' },
  { id: 'autopilot', title: 'Autopilot', desc: 'Approve everything automatically. Destructive commands (rm -rf, force push…) are still blocked.' },
  { id: 'strict', title: 'Read-only', desc: 'Deny anything that would modify files or run commands.' },
];
function ApprovalsTab({ s }: { s: AppSettings }) {
  const save = useSave();
  const [mode, setMode] = useState<ApprovalMode>(s.approvals.chatMode);
  const [timeout, setTimeoutSec] = useState(s.approvals.timeoutSec);
  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-2">
        {modes.map((m) => (
          <label key={m.id} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${mode === m.id ? 'border-accent bg-accent/5' : 'border-border'}`}>
            <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} className="mt-1 accent-[var(--c-accent)]" />
            <span><span className="block text-sm font-medium">{m.title}</span><span className="block text-xs text-muted">{m.desc}</span></span>
          </label>
        ))}
      </div>
      <Field label="Approval timeout (seconds)" hint="A pending request is denied automatically after this time." className="max-w-xs">
        <Input type="number" min={10} max={3600} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
      </Field>
      <p className="text-xs text-muted">This applies to chats. The CLI and REST API run in autopilot unless a request specifies otherwise. Note: the bash tool is not sandboxed — approvals are your main safeguard.</p>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ approvals: { chatMode: mode, timeoutSec: Math.min(3600, Math.max(10, timeout || 120)) } })}>Save</Button></div>
    </Card>
  );
}

function DataTab({ s }: { s: AppSettings }) {
  const save = useSave();
  const [days, setDays] = useState(s.retention.days);
  const [scope, setScope] = useState(s.retention.scope);
  const [keepPinned, setKeepPinned] = useState(s.retention.keepPinned);
  const [level, setLevel] = useState(s.audit.level);
  const [last, setLast] = useState<Record<string, unknown> | null>(null);
  const purge = useApiMutation(() => api<{ threads: number; runs: number; messages: number }>('/api/retention/purge', { method: 'POST', body: { days } }), {
    invalidate: [['threads']], onSuccess: (r) => toast.ok(`Purged ${r.threads} chats, ${r.runs} runs, ${r.messages} messages`),
  });
  useEffect(() => { api<{ lastRun: Record<string, unknown> | null }>('/api/retention').then((r) => setLast(r.lastRun)).catch(() => undefined); }, [purge.isSuccess]);
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Keep history for (days)" hint="Older chats, runs and audit logs are deleted automatically every hour. 7 is the default."><Input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          <Field label="What gets purged"><Select value={scope} onChange={(e) => setScope(e.target.value as AppSettings['retention']['scope'])}>
            <option value="everything">Chats, runs, events and audit files</option><option value="chats">Chats only (keep run audit)</option></Select></Field>
        </div>
        <Toggle checked={keepPinned} onChange={setKeepPinned} label="Never purge pinned chats" description="Pinned conversations are kept regardless of age." />
        <Field label="Audit detail" hint="How much of each turn is recorded in the audit trail." className="max-w-xs">
          <Select value={level} onChange={(e) => setLevel(e.target.value as AppSettings['audit']['level'])}><option value="minimal">Minimal (metadata)</option><option value="standard">Standard</option><option value="full">Full (all events)</option></Select>
        </Field>
        <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ retention: { days: Math.max(1, days || 7), scope, keepPinned }, audit: { level } })}>Save</Button></div>
      </Card>
      <Card className="flex items-center justify-between p-5">
        <div><div className="text-sm font-medium">Run the purge now</div>
          <div className="text-xs text-muted">{last ? `Last sweep ${timeAgo(String((last as { at?: string }).at ?? ''))}.` : 'No sweep has run yet.'} Daily totals on the dashboard are preserved.</div></div>
        <ConfirmButton variant="danger" loading={purge.isPending} confirmLabel="Delete old data?" onConfirm={() => purge.mutate(undefined)}>Purge now</ConfirmButton>
      </Card>
    </div>
  );
}

function AboutTab() {
  const { data: b } = useBootstrap();
  return (
    <Card className="space-y-2 p-5 text-sm">
      <div className="flex items-center gap-2"><CheckCircle2 className="size-4 text-ok" />Minions Cockpit <Badge>v{b?.version}</Badge></div>
      <p className="text-muted">Chats, runs and approvals are stored in a local SQLite database. Provider keys are encrypted in the credential vault. The server only accepts loopback Host headers unless <code>MINION_ALLOWED_HOSTS</code> is set; set <code>MINION_API_TOKEN</code> to require a bearer token for API clients (this disables the browser UI).</p>
      <p className="text-muted">Shortcuts: <kbd className="rounded border border-border px-1">Ctrl</kbd> + <kbd className="rounded border border-border px-1">K</kbd> command palette · <kbd className="rounded border border-border px-1">Enter</kbd> send · <kbd className="rounded border border-border px-1">Shift</kbd> + <kbd className="rounded border border-border px-1">Enter</kbd> new line · <kbd className="rounded border border-border px-1">Esc</kbd> stop.</p>
    </Card>
  );
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>('providers');
  const { data: s, isLoading } = useSettings();
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Settings" description="Providers, defaults, approvals and data retention." />
      <Page narrow>
        <div className="mb-5"><Tabs value={tab} onChange={setTab} items={[
          { id: 'providers', label: 'Providers' }, { id: 'defaults', label: 'Defaults' }, { id: 'approvals', label: 'Approvals' }, { id: 'data', label: 'Data & retention' }, { id: 'about', label: 'About' }]} /></div>
        {tab === 'providers' && <ProvidersTab />}
        {isLoading && tab !== 'providers' && tab !== 'about' ? <Spinner /> : s && (
          <>{tab === 'defaults' && <DefaultsTab s={s} />}{tab === 'approvals' && <ApprovalsTab s={s} />}{tab === 'data' && <DataTab s={s} />}</>
        )}
        {tab === 'about' && <AboutTab />}
      </Page>
    </div>
  );
}
