import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, ExternalLink, Plus, Search, Trash2, Wand2 } from 'lucide-react';
import { Badge, Button, Field, IconButton, Input, Modal, Select, Tabs, Textarea, Toggle, toast } from '@/components/ui';
import { CodeBlock, ErrorNote } from './components';
import { apiRaw, opsKeys, pretty } from './lib';
import { errMsg } from '@/lib/api';

export interface McpTool { name: string; description?: string; inputSchema?: unknown }
export interface McpConfig {
  type?: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string;
  headers?: Record<string, string>; timeoutMs?: number; authType?: string; [k: string]: unknown;
}
interface AuthHint { status: number; guidance: string; issuer?: string; scopes_supported?: string[]; resource_name?: string; resource?: string }
interface ProbeFail { error?: string; authHint?: AuthHint; diagnosis?: string; diagnosisModel?: string; autoFix?: { config: McpConfig; probed: boolean; count: number; model: string; error?: string; saved?: boolean } }

type Transport = 'stdio' | 'http' | 'sse';
type KV = { k: string; v: string }[];
interface Form { name: string; description: string; transport: Transport; command: string; args: string; cwd: string; url: string; env: KV; headers: KV; timeoutMs: string; authType: string }

const SECRET = /authorization|token|key|secret|password|passwd|auth|cookie|credential/i;
export const isSecretKey = (k: string) => SECRET.test(k);

const splitArgs = (s: string): string[] => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'));
const joinArgs = (a: string[] = []) => a.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ');
const toKV = (o?: Record<string, string>): KV => Object.entries(o ?? {}).map(([k, v]) => ({ k, v: String(v) }));
const fromKV = (kv: KV): Record<string, string> | undefined => {
  const e = kv.filter((r) => r.k.trim());
  return e.length ? Object.fromEntries(e.map((r) => [r.k.trim(), r.v])) : undefined;
};

const emptyForm = (): Form => ({ name: '', description: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', env: [], headers: [], timeoutMs: '', authType: '' });

export function configToForm(name: string, description: string, c: McpConfig): Form {
  const t = c.type === 'http' || c.type === 'sse' ? c.type : c.url && !c.command ? 'http' : 'stdio';
  return { name, description, transport: t, command: c.command ?? '', args: joinArgs(c.args), cwd: c.cwd ?? '', url: c.url ?? '', env: toKV(c.env), headers: toKV(c.headers), timeoutMs: c.timeoutMs ? String(c.timeoutMs) : '', authType: c.authType ?? '' };
}

function formToConfig(f: Form): McpConfig {
  const c: McpConfig = f.transport === 'stdio'
    ? { type: 'local', command: f.command.trim(), args: splitArgs(f.args), ...(fromKV(f.env) ? { env: fromKV(f.env) } : {}), ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}) }
    : { type: f.transport, url: f.url.trim(), ...(fromKV(f.headers) ? { headers: fromKV(f.headers) } : {}) };
  if (f.timeoutMs && Number(f.timeoutMs) > 0) c.timeoutMs = Number(f.timeoutMs);
  if (f.authType) c.authType = f.authType;
  return c;
}

const PRESETS: { label: string; form: Partial<Form> }[] = [
  { label: 'Filesystem (npx)', form: { name: 'filesystem', description: 'Local filesystem access', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem .' } },
  { label: 'GitHub (remote, PAT)', form: { name: 'github', description: 'GitHub MCP server', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ k: 'Authorization', v: 'Bearer ${GITHUB_TOKEN}' }], authType: 'headers' } },
  { label: 'Everything (demo)', form: { name: 'everything', description: 'MCP reference server', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-everything' } },
];

function KVEditor({ rows, onChange, keyPh, valPh }: { rows: KV; onChange: (r: KV) => void; keyPh: string; valPh: string }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const set = (i: number, p: Partial<KV[number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => {
        const secret = isSecretKey(r.k) && !shown.has(i);
        return (
          <div key={i} className="flex gap-1.5">
            <Input value={r.k} onChange={(e) => set(i, { k: e.target.value })} placeholder={keyPh} className="w-2/5 font-mono text-xs" />
            <Input value={r.v} onChange={(e) => set(i, { v: e.target.value })} placeholder={valPh} type={secret ? 'password' : 'text'} autoComplete="off" className="flex-1 font-mono text-xs" />
            {isSecretKey(r.k) && <IconButton label={shown.has(i) ? 'Hide value' : 'Reveal value'} onClick={() => setShown((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>{shown.has(i) ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</IconButton>}
            <IconButton label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
          </div>
        );
      })}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { k: '', v: '' }])}><Plus className="size-3.5" />Add</Button>
    </div>
  );
}

export function ToolList({ tools }: { tools: McpTool[] }) {
  if (!tools.length) return <p className="text-xs text-muted">No tools discovered yet.</p>;
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {tools.map((t) => (
        <details key={t.name} className="group px-3 py-2">
          <summary className="flex cursor-pointer list-none items-baseline gap-2">
            <code className="font-mono text-xs font-medium">{t.name}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{t.description}</span>
          </summary>
          {t.description && <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted">{t.description}</p>}
          {t.inputSchema != null && <CodeBlock text={pretty(t.inputSchema)} maxHeight="max-h-52" className="mt-2" />}
        </details>
      ))}
    </div>
  );
}

function Failure({ f, onApply }: { f: ProbeFail; onApply?: (c: McpConfig) => void }) {
  return (
    <div className="space-y-2.5 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm">
      <div className="whitespace-pre-wrap break-words font-medium text-danger">{f.error ?? 'Probe failed'}</div>
      {f.authHint && (
        <div className="rounded-md border border-warn/30 bg-warn/10 p-2.5 text-xs">
          <div className="mb-1 font-semibold text-warn">Authentication required (HTTP {f.authHint.status})</div>
          <p>{f.authHint.guidance}</p>
          {f.authHint.issuer && <p className="mt-1 text-muted">Issuer: {f.authHint.issuer}</p>}
          {f.authHint.scopes_supported?.length ? <p className="text-muted">Scopes: {f.authHint.scopes_supported.join(', ')}</p> : null}
          <p className="mt-1">Use the <strong>OAuth sign-in</strong> tab, or add an <code>Authorization</code> header.</p>
        </div>
      )}
      {f.diagnosis && <div className="text-xs"><div className="mb-0.5 font-semibold">Diagnosis{f.diagnosisModel ? <span className="font-normal text-muted"> · {f.diagnosisModel}</span> : ''}</div><p className="whitespace-pre-wrap text-muted">{f.diagnosis}</p></div>}
      {f.autoFix && (
        <div className="rounded-md border border-border bg-surface p-2.5 text-xs">
          <div className="mb-1 flex items-center gap-2 font-semibold"><Wand2 className="size-3.5 text-accent" />Suggested fix{f.autoFix.probed ? <Badge tone="ok">{f.autoFix.count} tools found</Badge> : <Badge tone="warn">not verified</Badge>}</div>
          {f.autoFix.saved && <p className="mb-1 text-ok">Repaired config was saved automatically.</p>}
          {f.autoFix.error && <p className="mb-1 text-danger">{f.autoFix.error}</p>}
          <CodeBlock text={pretty(f.autoFix.config)} maxHeight="max-h-40" />
          {onApply && !f.autoFix.saved && <Button size="sm" variant="secondary" className="mt-2" onClick={() => onApply(f.autoFix!.config)}>Apply to form</Button>}
        </div>
      )}
    </div>
  );
}
export { Failure as ProbeFailure };
export type { ProbeFail };

/** Add / edit modal for MCP servers (manual form, raw JSON, or OAuth sign-in). */
export function McpEditor({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: { name: string; description: string; config: McpConfig } | null }) {
  const qc = useQueryClient();
  const editing = !!initial;
  const [tab, setTab] = useState<'form' | 'json' | 'oauth'>('form');
  const [form, setForm] = useState<Form>(emptyForm());
  const [jsonText, setJsonText] = useState('');
  const [probeOnSave, setProbeOnSave] = useState(true);
  const [busy, setBusy] = useState<'' | 'probe' | 'save'>('');
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [fail, setFail] = useState<ProbeFail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab('form'); setTools(null); setFail(null); setError(null);
    setForm(initial ? configToForm(initial.name, initial.description, initial.config) : emptyForm());
  }, [open, initial]);

  const upd = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  const currentConfig = (): McpConfig | null => {
    if (tab === 'json') {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const wrapped = parsed.mcpServers as Record<string, McpConfig> | undefined;
        if (wrapped) { const [n, c] = Object.entries(wrapped)[0] ?? []; if (n && !form.name) upd({ name: n }); return c ?? null; }
        return parsed as McpConfig;
      } catch (e) { setError(`Invalid JSON: ${(e as Error).message}`); return null; }
    }
    return formToConfig(form);
  };

  const switchTab = (t: 'form' | 'json' | 'oauth') => {
    setError(null);
    if (t === 'json' && tab === 'form') setJsonText(pretty(formToConfig(form)));
    if (t === 'form' && tab === 'json') { const c = currentConfig(); if (!c) return; setForm((f) => configToForm(f.name, f.description, c)); }
    setTab(t);
  };

  const probe = async () => {
    setError(null); setFail(null);
    const config = currentConfig(); if (!config) return;
    setBusy('probe');
    try {
      const r = await apiRaw<{ tools?: McpTool[] } & ProbeFail>('/api/mcp/probe', { method: 'POST', body: { config } });
      if (r.ok) { setTools(r.data.tools ?? []); toast.ok(`Found ${r.data.tools?.length ?? 0} tools`); } else { setTools(null); setFail(r.data); }
    } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };

  const save = async () => {
    setError(null); setFail(null);
    const config = currentConfig(); if (!config) return;
    if (!form.name.trim()) { setError('Give the server a name.'); return; }
    if (!/^[A-Za-z0-9._-]+$/.test(form.name.trim())) { setError('Name may only contain letters, numbers, dots, dashes and underscores.'); return; }
    setBusy('save');
    try {
      const r = await apiRaw<{ tools?: McpTool[] } & ProbeFail>('/api/mcp', { method: 'POST', body: { name: form.name.trim(), description: form.description.trim() || undefined, config, probe: probeOnSave } });
      if (!r.ok) { setFail(r.data); if (!r.data.error) setError(`Save failed (HTTP ${r.status})`); return; }
      toast.ok(`Saved ${form.name.trim()}`);
      qc.invalidateQueries({ queryKey: opsKeys.mcp });
      onClose();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${initial?.name}` : 'Add MCP server'} width="max-w-2xl"
      footer={tab === 'oauth' ? <Button variant="ghost" onClick={onClose}>Close</Button> : (
        <>
          <Toggle checked={probeOnSave} onChange={setProbeOnSave} label="Probe on save" />
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="secondary" loading={busy === 'probe'} onClick={probe}><Search className="size-4" />Probe</Button>
            <Button variant="primary" loading={busy === 'save'} onClick={save}>{editing ? 'Save changes' : 'Register'}</Button>
          </div>
        </>
      )}>
      <div className="space-y-4">
        <Tabs value={tab} onChange={switchTab} items={[{ id: 'form', label: 'Form' }, { id: 'json', label: 'JSON' }, { id: 'oauth', label: 'OAuth sign-in' }]} />

        {tab !== 'oauth' && (
          <>
            {!editing && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">Presets:
                {PRESETS.map((p) => <Button key={p.label} size="sm" variant="secondary" onClick={() => { setForm({ ...emptyForm(), ...p.form }); setTab('form'); setTools(null); setFail(null); }}>{p.label}</Button>)}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" hint="Referenced from agents via mcp.use"><Input value={form.name} onChange={(e) => upd({ name: e.target.value })} disabled={editing} placeholder="my-server" /></Field>
              <Field label="Description"><Input value={form.description} onChange={(e) => upd({ description: e.target.value })} placeholder="What it provides" /></Field>
            </div>
          </>
        )}

        {tab === 'form' && (
          <div className="space-y-3">
            <Field label="Transport">
              <Select value={form.transport} onChange={(e) => upd({ transport: e.target.value as Transport })}>
                <option value="stdio">stdio — local process</option><option value="http">http — streamable HTTP</option><option value="sse">sse — server-sent events</option>
              </Select>
            </Field>
            {form.transport === 'stdio' ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Command"><Input value={form.command} onChange={(e) => upd({ command: e.target.value })} placeholder="npx" className="font-mono text-xs" /></Field>
                  <Field label="Arguments" className="sm:col-span-2" hint="Space separated; quote values containing spaces."><Input value={form.args} onChange={(e) => upd({ args: e.target.value })} placeholder="-y @scope/server" className="font-mono text-xs" /></Field>
                </div>
                <Field label="Working directory (optional)"><Input value={form.cwd} onChange={(e) => upd({ cwd: e.target.value })} className="font-mono text-xs" /></Field>
                <Field label="Environment variables" hint="Secret-looking values are masked. Use ${VAR} to reference a server environment variable."><KVEditor rows={form.env} onChange={(env) => upd({ env })} keyPh="NAME" valPh="value or ${ENV_VAR}" /></Field>
              </>
            ) : (
              <>
                <Field label="URL"><Input value={form.url} onChange={(e) => upd({ url: e.target.value })} placeholder="https://example.com/mcp" className="font-mono text-xs" /></Field>
                <Field label="Headers" hint="Secret-looking values are masked. Use ${VAR} to reference a server environment variable."><KVEditor rows={form.headers} onChange={(headers) => upd({ headers })} keyPh="Authorization" valPh="Bearer ${TOKEN}" /></Field>
              </>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Auth type"><Select value={form.authType} onChange={(e) => upd({ authType: e.target.value })}><option value="">Auto-detect</option><option value="none">None</option><option value="headers">Static header / PAT</option><option value="env">Environment credentials</option><option value="oauth">OAuth</option></Select></Field>
              <Field label="Timeout (ms)" hint="Optional"><Input type="number" min={0} value={form.timeoutMs} onChange={(e) => upd({ timeoutMs: e.target.value })} /></Field>
            </div>
          </div>
        )}

        {tab === 'json' && (
          <Field label="Server config JSON" hint='Either the bare config or an {"mcpServers": {"name": {…}}} wrapper. Secrets are shown as stored.'>
            <Textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={12} spellCheck={false} className="font-mono text-xs" />
          </Field>
        )}

        {tab === 'oauth' && <OAuthPanel onDone={() => { qc.invalidateQueries({ queryKey: opsKeys.mcp }); onClose(); }} />}

        {tab !== 'oauth' && (
          <>
            <ErrorNote error={error} />
            {fail && <Failure f={fail} onApply={(c) => { setForm((f) => configToForm(f.name, f.description, c)); setTab('form'); setFail(null); toast.info('Fix applied — probe to verify'); }} />}
            {tools && <div><div className="mb-1.5 text-xs font-medium text-muted">Discovered {tools.length} tool{tools.length === 1 ? '' : 's'}</div><ToolList tools={tools} /></div>}
          </>
        )}
      </div>
    </Modal>
  );
}

interface OAuthStart { authorizeUrl: string; state: string; issuer?: string; scopes?: string[]; registered_via_dcr?: boolean }

function OAuthPanel({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [registerAs, setRegisterAs] = useState('');
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');
  const [started, setStarted] = useState<OAuthStart | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'waiting' | 'done' | 'timeout'>('idle');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const start = async () => {
    setError(null);
    if (!url.trim()) { setError('Enter the MCP server URL.'); return; }
    setState('starting');
    const body = { url: url.trim(), registerAs: registerAs.trim() || undefined, description: description.trim() || undefined, clientId: clientId.trim() || undefined, clientSecret: clientSecret || undefined, scopes: scopes.split(/[\s,]+/).filter(Boolean) };
    const r = await apiRaw<OAuthStart & { error?: string }>('/api/mcp/oauth/start', { method: 'POST', body: { ...body, scopes: body.scopes.length ? body.scopes : undefined } }).catch((e) => ({ ok: false, status: 0, data: { error: errMsg(e) } as OAuthStart & { error?: string } }));
    if (!r.ok) { setState('idle'); setError(r.data.error ?? `HTTP ${r.status}`); return; }
    setStarted(r.data); setState('waiting');
    window.open(r.data.authorizeUrl, '_blank', 'noopener');
    for (let i = 0; i < 150 && alive.current; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await apiRaw<{ pending?: { state: string }[] }>('/api/mcp/oauth/status').catch(() => null);
      if (s?.ok && !(s.data.pending ?? []).some((p) => p.state === r.data.state)) {
        if (!alive.current) return;
        setState('done'); toast.ok(registerAs.trim() ? `Signed in — ${registerAs.trim()} registered` : 'Authorization completed');
        onDone(); return;
      }
    }
    if (alive.current) setState('timeout');
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Sign in to a remote MCP server with OAuth (PKCE). A browser window opens for consent; the token is stored sealed and attached as an <code>Authorization</code> header.</p>
      <Field label="MCP server URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className="font-mono text-xs" disabled={state === 'waiting'} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Register as" hint="Name to save the server under after sign-in"><Input value={registerAs} onChange={(e) => setRegisterAs(e.target.value)} placeholder="my-server" disabled={state === 'waiting'} /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={state === 'waiting'} /></Field>
      </div>
      <details className="rounded-lg border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none text-xs text-muted">Advanced — pre-registered client</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Client ID" hint="Needed when the server has no dynamic client registration"><Input value={clientId} onChange={(e) => setClientId(e.target.value)} /></Field>
          <Field label="Client secret"><Input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></Field>
          <Field label="Scopes" hint="Space or comma separated" className="sm:col-span-2"><Input value={scopes} onChange={(e) => setScopes(e.target.value)} /></Field>
        </div>
      </details>
      <ErrorNote error={error} />
      {state === 'waiting' && started && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs">
          <div className="flex items-center gap-2 font-medium text-warn"><span className="size-1.5 animate-pulse rounded-full bg-warn" />Waiting for you to finish signing in…</div>
          <p className="mt-1 text-muted">A new tab should have opened. If not, <a className="inline-flex items-center gap-1 text-accent underline" href={started.authorizeUrl} target="_blank" rel="noreferrer">open the consent page<ExternalLink className="size-3" /></a>.</p>
        </div>
      )}
      {state === 'timeout' && <ErrorNote error="Timed out waiting for the OAuth callback. Start again to retry." />}
      {state === 'done' && <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">Authorization completed.</div>}
      <div className="flex justify-end"><Button variant="primary" loading={state === 'starting' || state === 'waiting'} onClick={start}>Sign in</Button></div>
    </div>
  );
}
