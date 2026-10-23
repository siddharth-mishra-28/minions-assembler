import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, FileDown, MessageSquare, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, EmptyState, IconButton, Input, Modal, Page, PageHeader, Spinner, cn, timeAgo, toast } from '@/components/ui';
import { ApiError, api, errMsg } from '@/lib/api';
import { useProviders } from '@/lib/queries';
import { useAgentRows, type AgentRow } from '@/features/agent-builder/hooks';
import ImportDialog from '@/features/agent-builder/ImportDialog';
import { Callout } from '@/features/agent-builder/ui-bits';
import type { Def } from '@/features/agent-builder/model';

interface RunRow { agent_id?: string; status?: string }

const FALLBACK_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'];
const colorFor = (id: string, def?: Def) => {
  if (def?.metadata?.color) return def.metadata.color as string;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
};

const enc = encodeURIComponent;

export default function Agents() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useProviders();
  const agents = useQuery({ queryKey: ['agents-list'], queryFn: () => api<{ agents: AgentRow[] }>('/api/agents').then((r) => r.agents) });
  const drafts = useAgentRows('drafts');
  const runs = useQuery({ queryKey: ['agent-runs-summary'], queryFn: () => api<{ runs: RunRow[] }>('/api/runs').then((r) => r.runs), refetchInterval: 10_000 });
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [forceDel, setForceDel] = useState<{ id: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const details = useQueries({
    queries: (agents.data ?? []).map((a) => ({
      queryKey: ['agent-detail', a.id],
      staleTime: 30_000,
      queryFn: () => api<{ definition: Def | string }>(`/api/agents/${enc(a.id)}`).then((r) => (typeof r.definition === 'string' ? JSON.parse(r.definition) as Def : r.definition)),
    })),
  });
  const defOf = useMemo(() => {
    const m = new Map<string, Def | undefined>();
    (agents.data ?? []).forEach((a, i) => m.set(a.id, details[i]?.data));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.data, details.map((d) => d.dataUpdatedAt).join(',')]);

  const stats = useMemo(() => {
    const m = new Map<string, { total: number; running: number }>();
    for (const r of runs.data ?? []) {
      if (!r.agent_id) continue;
      const s = m.get(r.agent_id) ?? { total: 0, running: 0 };
      s.total++;
      if (r.status === 'running' || r.status === 'pending') s.running++;
      m.set(r.agent_id, s);
    }
    return m;
  }, [runs.data]);

  const providerName = (d?: Def) => {
    const ref = d?.provider?.providerRef;
    if (ref) return providers.data?.find((p) => p.id === ref || p.name === ref)?.name ?? String(ref);
    return d?.provider?.type ?? '';
  };

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (agents.data ?? []).filter((a) => {
      if (!s) return true;
      const d = defOf.get(a.id);
      return [a.name, a.version, d?.metadata?.description, d?.provider?.model, ...(d?.metadata?.tags ?? [])].some((v) => typeof v === 'string' && v.toLowerCase().includes(s));
    });
  }, [agents.data, defOf, q]);

  const refresh = () => { for (const k of ['agents-list', 'agent-rows', 'chat-agents', 'agent-runs-summary']) qc.invalidateQueries({ queryKey: [k] }); };

  const remove = async (id: string, force = false) => {
    setBusyId(id);
    try {
      await api(`/api/agents/${enc(id)}${force ? '?force=true' : ''}`, { method: 'DELETE' });
      toast.ok(`Deleted ${id}`);
      setForceDel(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !force) setForceDel({ id, message: e.message });
      else toast.error(errMsg(e));
    } finally { setBusyId(null); }
  };

  const loading = agents.isLoading;
  const none = !loading && (agents.data?.length ?? 0) === 0;

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Agents" description="Custom agents you build here appear in the chat agent picker and can be run headlessly."
        actions={<>
          <Button onClick={() => setImporting(true)}><FileDown className="size-4" />Import</Button>
          <Button variant="primary" onClick={() => navigate('/agents/new')}><Plus className="size-4" />New agent</Button>
        </>} />
      <Page>
        {agents.isError && <Callout tone="danger">Could not load agents: {errMsg(agents.error)}</Callout>}
        {(agents.data?.length ?? 0) > 0 && (
          <div className="relative mb-5 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input className="pl-8" aria-label="Search agents" placeholder="Search by name, description, model or tag…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
        {loading && <div className="flex justify-center py-16"><Spinner className="size-6" /></div>}
        {none && (
          <EmptyState icon={<Bot className="size-6" />} title="No agents yet"
            description="Create a custom agent with its own persona, tools and permissions, then chat with it or run it on a task."
            action={<div className="flex gap-2"><Button variant="primary" onClick={() => navigate('/agents/new')}><Plus className="size-4" />Create your first agent</Button><Button onClick={() => setImporting(true)}><FileDown className="size-4" />Import</Button></div>} />
        )}
        {!none && !loading && list.length === 0 && <EmptyState icon={<Search className="size-5" />} title="No matching agents" description={`Nothing matches “${q}”.`} />}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => {
            const d = defOf.get(a.id);
            const st = stats.get(a.id) ?? { total: 0, running: 0 };
            const color = colorFor(a.id, d);
            const tags = (d?.metadata?.tags ?? []) as string[];
            return (
              <Card key={a.id} className="group flex flex-col p-4 transition-shadow hover:shadow-md">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: color }}><Bot className="size-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link to={`/agents/${enc(a.id)}/edit`} className="truncate text-sm font-semibold hover:underline" title={a.name}>{a.name}</Link>
                      <Badge>v{a.version}</Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2 min-h-8 text-xs text-muted">{d?.metadata?.description || (d ? 'No description' : '')}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                  {d?.provider?.model && <Badge tone="accent">{d.provider.model}</Badge>}
                  {providerName(d) && <Badge>{providerName(d)}</Badge>}
                  {tags.slice(0, 3).map((t) => <Badge key={t}>#{t}</Badge>)}
                  {!d?.task?.prompt && d && <Badge>chat</Badge>}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted">
                  <span className="flex items-center gap-2">
                    <span>{st.total} run{st.total === 1 ? '' : 's'}</span>
                    {st.running > 0 && <Badge tone="warn">{st.running} running</Badge>}
                  </span>
                  <span className="flex items-center gap-1.5"><Badge tone="ok">{a.status ?? 'published'}</Badge>{timeAgo(a.created_at)}</span>
                </div>
                <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-3">
                  <Button size="sm" variant="primary" onClick={() => navigate(`/chat?agent=${enc(a.id)}`)}><MessageSquare className="size-3.5" />Chat</Button>
                  <Button size="sm" onClick={() => navigate(`/runs/new?agent=${enc(a.id)}`)}><Play className="size-3.5" />Run</Button>
                  <span className="ml-auto flex items-center">
                    <IconButton label="Edit" onClick={() => navigate(`/agents/${enc(a.id)}/edit`)}><Pencil className="size-4" /></IconButton>
                    <IconButton label="Duplicate" onClick={() => navigate(`/agents/new?from=${enc(a.id)}`)}><Copy className="size-4" /></IconButton>
                    <ConfirmButton size="sm" confirmLabel="Delete?" loading={busyId === a.id} aria-label={`Delete ${a.id}`} onConfirm={() => void remove(a.id)}><Trash2 className="size-3.5" /></ConfirmButton>
                  </span>
                </div>
              </Card>
            );
          })}
        </div>

        {(drafts.data?.length ?? 0) > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold">Drafts</h2>
            <p className="mb-3 text-xs text-muted">Unpublished work in progress. Drafts are not available in chat or runs.</p>
            <Card className="divide-y divide-border">
              {drafts.data!.map((d) => (
                <div key={d.id} className={cn('flex items-center gap-3 px-4 py-2.5')}>
                  <div className="min-w-0 flex-1"><span className="text-sm font-medium">{d.name}</span> <span className="text-xs text-muted">v{d.version}</span></div>
                  <Badge tone="warn">draft</Badge>
                  <span className="hidden text-xs text-muted sm:inline">{timeAgo(d.created_at)}</span>
                  <Button size="sm" onClick={() => navigate(`/agents/${enc(d.id)}/edit`)}>Resume</Button>
                  <ConfirmButton size="sm" confirmLabel="Delete?" aria-label={`Delete draft ${d.id}`} onConfirm={() => void remove(d.id)}><Trash2 className="size-3.5" /></ConfirmButton>
                </div>
              ))}
            </Card>
          </section>
        )}
      </Page>

      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={(definition) => navigate('/agents/new', { state: { definition } })} />
      <Modal open={!!forceDel} onClose={() => setForceDel(null)} title="Agent is in use"
        footer={<><Button variant="ghost" onClick={() => setForceDel(null)}>Cancel</Button><Button variant="danger" loading={busyId === forceDel?.id} onClick={() => forceDel && void remove(forceDel.id, true)}>Delete anyway</Button></>}>
        <p className="text-sm">{forceDel?.message}</p>
        <p className="mt-2 text-xs text-muted">Deleting anyway also removes this agent&apos;s runs and sessions. This cannot be undone.</p>
      </Modal>
    </div>
  );
}
