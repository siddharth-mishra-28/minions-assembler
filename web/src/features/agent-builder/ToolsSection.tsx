import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, Search } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Spinner, Textarea, Toggle, Badge, cn, toast } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { useBuilder } from './context';
import { useBuiltinTools, useMcpServers } from './hooks';
import { Callout, ChipInput, Group, SectionCard, SectionTitle, monoArea } from './ui-bits';
import { normalizeMcpUse, serializeMcpUse, setToolDecision, toolDecision, splitList, type Def, type McpUse } from './model';

const GROUP_LABEL: Record<string, string> = { files: 'Files', search: 'Search', execution: 'Execution', session: 'Session' };

export default function ToolsSection() {
  const { def, set } = useBuilder();
  const builtins = (def.tools?.builtins ?? { all: true }) as Def;
  const all = builtins.all !== false;
  const tools = useBuiltinTools();
  const toolNames = (tools.data ?? []).map((t) => t.name);

  const setAll = (v: boolean) => {
    if (v) {
      const per = Object.fromEntries(Object.entries((builtins.perTool ?? {}) as Record<string, string>).filter(([, d]) => d !== 'deny'));
      set('tools.builtins', { ...builtins, all: true, perTool: per });
    } else {
      const per: Record<string, string> = {};
      for (const n of toolNames) per[n] = toolDecision(builtins, n);
      set('tools.builtins', { ...builtins, all: false, perTool: per });
    }
  };

  const grouped = useMemo(() => {
    const g: Record<string, typeof tools.data> = {};
    for (const t of tools.data ?? []) (g[t.group] ??= []).push(t);
    return g;
  }, [tools.data]);

  return (
    <div className="space-y-5">
      <SectionTitle title="Tools" description="Decide which built-in tools and MCP servers the agent can use. How each tool is approved is set in Permissions." />
      <SectionCard title="Built-in tools" description="Files, search, shell and session tools provided by the Copilot runtime.">
        <Toggle checked={all} onChange={setAll} label="Enable all built-in tools" description="Turn off to pick exactly which tools are available." />
        {!all && (
          <div className="space-y-4">
            {tools.isLoading && <Spinner />}
            {Object.entries(grouped).map(([g, list]) => (
              <Group key={g} label={GROUP_LABEL[g] ?? g}>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {(list ?? []).map((t) => {
                    const on = toolDecision(builtins, t.name) !== 'deny';
                    return (
                      <label key={t.name} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors', on ? 'border-accent/50 bg-accent/5' : 'border-border hover:bg-surface-2')}>
                        <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={on}
                          onChange={(e) => set('tools.builtins', setToolDecision(builtins, t.name, e.target.checked ? 'allow' : 'deny'))} />
                        <span className="min-w-0"><span className="font-mono text-xs font-medium">{t.name}</span>
                          {t.description && <span className="block text-xs text-muted">{t.description}</span>}</span>
                      </label>
                    );
                  })}
                </div>
              </Group>
            ))}
          </div>
        )}
        <Toggle checked={def.tools?.harness !== false} onChange={(v) => set('tools.harness', v ? undefined : false)}
          label="Coding harness tools" description="Keep the harness tools (bash, mkdir, write, create) available to sub-agents and always-allowed by policy." />
        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted">Advanced: explicit allow / exclude lists</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Group label="Available (allowlist)" hint="Only these tool names are exposed. Leave empty for no restriction.">
              <ChipInput label="Available tools" value={def.tools?.available ?? []} onChange={(v) => set('tools.available', v)} suggestions={toolNames} placeholder="view, grep" />
            </Group>
            <Group label="Excluded" hint="Tool names removed even when otherwise available.">
              <ChipInput label="Excluded tools" value={def.tools?.excluded ?? []} onChange={(v) => set('tools.excluded', v)} suggestions={toolNames} placeholder="bash" />
            </Group>
          </div>
        </details>
      </SectionCard>
      <McpCard />
    </div>
  );
}

function McpCard() {
  const { def, set } = useBuilder();
  const servers = useMcpServers();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const uses = normalizeMcpUse(def.mcp?.use);
  const useMap = new Map(uses.map((u) => [u.name, u]));
  const toolCount = (j?: string) => { try { return (JSON.parse(j ?? '[]') as unknown[]).length; } catch { return 0; } };
  const list = (servers.data ?? []).filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.description?.toLowerCase().includes(q.toLowerCase()));
  const save = (next: McpUse[]) => set('mcp.use', next.length ? serializeMcpUse(next) : undefined);
  const toggle = (name: string, on: boolean) => save(on ? [...uses, { name }] : uses.filter((u) => u.name !== name));
  const patch = (name: string, p: Partial<McpUse>) => save(uses.map((u) => (u.name === name ? { ...u, ...p } : u)));
  const unknownUses = uses.filter((u) => !(servers.data ?? []).some((s) => s.name === u.name));

  return (
    <SectionCard title="MCP servers" description="Extend the agent with tools from registered Model Context Protocol servers."
      right={<Button size="sm" onClick={() => setAdding(true)}><Plus className="size-3.5" />Register server</Button>}>
      {servers.isLoading && <Spinner />}
      {servers.data && servers.data.length > 4 && (
        <div className="relative"><Search className="absolute left-2.5 top-2.5 size-4 text-muted" /><Input className="pl-8" placeholder="Search servers…" aria-label="Search MCP servers" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      )}
      {servers.data?.length === 0 && <Callout tone="info">No MCP servers registered yet. Use <b>Register server</b> to add one (stdio command or HTTP/SSE URL).</Callout>}
      <div className="space-y-2">
        {list.map((s) => {
          const u = useMap.get(s.name);
          return (
            <div key={s.name} className={cn('rounded-lg border p-3 transition-colors', u ? 'border-accent/50 bg-accent/5' : 'border-border')}>
              <div className="flex items-center gap-3">
                <input type="checkbox" id={`mcp-${s.name}`} aria-label={`Use ${s.name}`} checked={!!u} onChange={(e) => toggle(s.name, e.target.checked)} className="accent-[var(--color-accent)]" />
                <label htmlFor={`mcp-${s.name}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <Plug className="size-4 shrink-0 text-muted" />
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  <Badge>{toolCount(s.tools_json)} tools</Badge>
                </label>
              </div>
              {s.description && <p className="ml-7 mt-0.5 text-xs text-muted">{s.description}</p>}
              {u && (
                <details className="ml-7 mt-2">
                  <summary className="cursor-pointer text-xs text-muted">Filters</summary>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <Field label="Allow only (comma separated)"><Input value={(u.allow ?? []).join(', ')} onChange={(e) => patch(s.name, { allow: splitList(e.target.value) })} placeholder="tool_a, tool_b" /></Field>
                    <Field label="Deny (comma separated)"><Input value={(u.deny ?? []).join(', ')} onChange={(e) => patch(s.name, { deny: splitList(e.target.value) })} placeholder="dangerous_tool" /></Field>
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
      {unknownUses.length > 0 && <Callout tone="warn">Not found in the registry: {unknownUses.map((u) => u.name).join(', ')}. Register {unknownUses.length > 1 ? 'them' : 'it'} or remove the reference.
        <div className="mt-1.5 flex gap-2">{unknownUses.map((u) => <Button key={u.name} size="sm" onClick={() => toggle(u.name, false)}>Remove {u.name}</Button>)}</div></Callout>}
      <McpRegisterModal open={adding} onClose={() => setAdding(false)} onDone={(name) => { if (!useMap.has(name)) toggle(name, true); }} />
    </SectionCard>
  );
}

function McpRegisterModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState<'probe' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const config = (): Record<string, unknown> => {
    if (kind === 'stdio') {
      const e = Object.fromEntries(env.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
      return { type: 'stdio', command: command.trim(), args: args.trim() ? args.match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, '')) : [], ...(Object.keys(e).length ? { env: e } : {}), tools: ['*'] };
    }
    return { type: kind, url: url.trim(), tools: ['*'] };
  };

  const probe = async () => {
    setBusy('probe'); setResult(null);
    try { const r = await api<{ count: number; tools: { name: string }[] }>('/api/mcp/probe', { method: 'POST', body: { config: config() } }); setResult({ ok: true, text: `Connected — ${r.count} tools: ${r.tools.slice(0, 8).map((t) => t.name).join(', ')}${r.count > 8 ? '…' : ''}` }); }
    catch (e) { setResult({ ok: false, text: errMsg(e) }); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save');
    try {
      await api('/api/mcp', { method: 'POST', body: { name: name.trim(), description: desc.trim() || undefined, config: config(), probe: true } });
      await qc.invalidateQueries({ queryKey: ['mcp-servers'] });
      toast.ok(`Registered MCP server “${name.trim()}”`);
      onDone(name.trim()); onClose();
    } catch (e) { setResult({ ok: false, text: errMsg(e) }); } finally { setBusy(null); }
  };
  const ready = name.trim() && (kind === 'stdio' ? command.trim() : url.trim());

  return (
    <Modal open={open} onClose={onClose} title="Register MCP server" width="max-w-xl"
      footer={<><Button onClick={probe} loading={busy === 'probe'} disabled={!ready}>Test connection</Button><Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!ready}>Register & use</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name *"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" /></Field>
          <Field label="Transport"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="stdio">stdio (local command)</option><option value="http">http</option><option value="sse">sse</option></Select></Field>
        </div>
        <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        {kind === 'stdio' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Command *"><Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></Field>
              <Field label="Arguments"><Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." /></Field>
            </div>
            <Field label="Environment (KEY=value per line)"><Textarea rows={3} className={monoArea} value={env} onChange={(e) => setEnv(e.target.value)} /></Field>
          </>
        ) : <Field label="URL *"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></Field>}
        {result && <Callout tone={result.ok ? 'ok' : 'danger'}>{result.text}</Callout>}
      </div>
    </Modal>
  );
}
