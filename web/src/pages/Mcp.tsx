import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Plug, Plus, RefreshCw } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';
import { Badge, Button, Card, ConfirmButton, EmptyState, Spinner, toast, timeAgo } from '@/components/ui';
import { CodeBlock, CopyButton, ErrorNote, Mono, OpsPage, SearchBox } from '@/features/ops/components';
import { McpEditor, ProbeFailure, ToolList, isSecretKey, type McpConfig, type McpTool, type ProbeFail } from '@/features/ops/McpEditor';
import { apiRaw, opsKeys, pretty, safeParse, useDebounced } from '@/features/ops/lib';

interface McpRow { name: string; description: string | null; tools_json: string | null; created_at: string }
interface McpDetail { name: string; description: string | null; config_json: string; tools: McpTool[]; created_at: string }

const transportOf = (c: McpConfig | null): string => (!c ? '?' : c.type === 'local' || c.type === 'stdio' || (!c.type && c.command) ? 'stdio' : (c.type ?? (c.url ? 'http' : '?')));

function maskConfig(c: McpConfig, reveal: boolean): McpConfig {
  if (reveal) return c;
  const mask = (o?: Record<string, string>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, isSecretKey(k) && !/^\$\{[^}]+\}$/.test(v) ? '••••••••' : v]));
  return { ...c, ...(c.env ? { env: mask(c.env) } : {}), ...(c.headers ? { headers: mask(c.headers) } : {}) };
}

function ServerCard({ row, onEdit }: { row: McpRow; onEdit: (d: McpDetail) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [fail, setFail] = useState<ProbeFail | null>(null);
  const [reprobing, setReprobing] = useState(false);
  const detail = useQuery({ queryKey: [...opsKeys.mcp, row.name], enabled: open, queryFn: () => api<McpDetail>(`/api/mcp/${encodeURIComponent(row.name)}`) });
  const del = useApiMutation(() => api(`/api/mcp/${encodeURIComponent(row.name)}`, { method: 'DELETE' }), { invalidate: [opsKeys.mcp], onSuccess: () => toast.ok(`Deleted ${row.name}`) });

  const cfg = safeParse<McpConfig | null>(detail.data?.config_json, null);
  const count = safeParse<unknown[]>(row.tools_json, []).length;

  const reprobe = async () => {
    setFail(null); setReprobing(true);
    try {
      const r = await apiRaw<{ count?: number } & ProbeFail>(`/api/mcp/${encodeURIComponent(row.name)}/tools`, { method: 'POST' });
      if (r.ok) toast.ok(`Discovered ${r.data.count ?? 0} tools`); else { setFail(r.data); setOpen(true); if (r.data.autoFix?.saved) toast.ok('Repaired config saved'); }
      qc.invalidateQueries({ queryKey: opsKeys.mcp });
    } catch (e) { toast.error(errMsg(e)); } finally { setReprobing(false); }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2"><span className="truncate font-medium">{row.name}</span>{detail.data && <Badge>{transportOf(cfg)}</Badge>}<Badge tone={count ? 'ok' : 'neutral'}>{count} tool{count === 1 ? '' : 's'}</Badge></div>
            <div className="truncate text-xs text-muted">{row.description || 'No description'} · added {timeAgo(row.created_at)}</div>
          </div>
        </button>
        <Button size="sm" variant="secondary" loading={reprobing} onClick={reprobe}><RefreshCw className="size-3.5" />Re-probe</Button>
        <Button size="sm" variant="secondary" onClick={async () => { try { onEdit(detail.data ?? await api<McpDetail>(`/api/mcp/${encodeURIComponent(row.name)}`)); } catch (e) { toast.error(errMsg(e)); } }}><Pencil className="size-3.5" />Edit</Button>
        <ConfirmButton size="sm" loading={del.isPending} confirmLabel="Really delete?" onConfirm={() => del.mutate(undefined)}>Delete</ConfirmButton>
      </div>
      {open && (
        <div className="space-y-4 border-t border-border bg-surface-2/30 px-4 py-4">
          {fail && <ProbeFailure f={fail} />}
          {detail.isLoading && <Spinner className="size-4" />}
          <ErrorNote error={detail.error} />
          {detail.data && (
            <>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Config</h4>
                  <Button size="sm" variant="ghost" onClick={() => setReveal((v) => !v)}>{reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{reveal ? 'Mask secrets' : 'Reveal secrets'}</Button>
                </div>
                <CodeBlock text={cfg ? pretty(maskConfig(cfg, reveal)) : detail.data.config_json} copy={reveal} maxHeight="max-h-52" />
              </div>
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Tools ({detail.data.tools.length})</h4>
                <ToolList tools={detail.data.tools} />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between"><h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Use in an agent definition</h4><CopyButton text={`"mcp": { "use": ["${row.name}"] }`} /></div>
                <Mono className="block rounded-lg border border-border bg-surface-2 p-2.5">{`"mcp": { "use": ["${row.name}"] }`}</Mono>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Mcp() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q).toLowerCase();
  const [editor, setEditor] = useState<{ name: string; description: string; config: McpConfig } | null | undefined>(undefined);
  const list = useQuery({ queryKey: opsKeys.mcp, queryFn: () => api<{ servers: McpRow[] }>('/api/mcp').then((r) => r.servers) });
  const rows = (list.data ?? []).filter((s) => !dq || s.name.toLowerCase().includes(dq) || s.description?.toLowerCase().includes(dq));

  return (
    <OpsPage title="MCP servers" description="Registry of Model Context Protocol servers that agents can reference by name."
      actions={<Button variant="primary" onClick={() => setEditor(null)}><Plus className="size-4" />Add server</Button>}>
      <div className="space-y-4">
        {(list.data?.length ?? 0) > 4 && <SearchBox value={q} onChange={setQ} placeholder="Filter servers…" className="w-72" />}
        <ErrorNote error={list.error} />
        {list.isLoading ? <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
          : rows.length === 0 ? (
            <Card><EmptyState icon={<Plug className="size-5" />} title={dq ? 'No servers match' : 'No MCP servers registered'}
              description="Register a stdio, HTTP or SSE server — or sign in with OAuth — then reference it from an agent with mcp.use."
              action={!dq && <Button variant="primary" onClick={() => setEditor(null)}><Plus className="size-4" />Add server</Button>} /></Card>
          ) : <div className="space-y-2.5">{rows.map((r) => <ServerCard key={r.name} row={r} onEdit={(d) => setEditor({ name: d.name, description: d.description ?? '', config: safeParse<McpConfig>(d.config_json, {}) })} />)}</div>}
      </div>
      <McpEditor open={editor !== undefined} initial={editor ?? null} onClose={() => setEditor(undefined)} />
    </OpsPage>
  );
}
