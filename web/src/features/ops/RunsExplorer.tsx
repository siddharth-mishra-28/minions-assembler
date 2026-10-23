import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, History, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { Button, Card, EmptyState, IconButton, Select, Spinner, toast, timeAgo } from '@/components/ui';
import { ErrorNote, Mono, Pagination, RunStatus, SearchBox, SourceBadge, Td, Th } from './components';
import { RUN_STATUSES, downloadFromApi, fmtCompact, fmtDuration, opsKeys, qs, runDuration, useDebounced, type AuditRun } from './lib';
import { errMsg } from '@/lib/api';

interface AuditResponse { total: number; runs: AuditRun[] }

/** Filterable run table backed by /api/audit/runs (joins usage, project, source). Used by Runs and Audit. */
export function RunsExplorer({ audit }: { audit?: boolean }) {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [agent, setAgent] = useState('');
  const [projectId, setProjectId] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(audit ? 50 : 25);
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(q);

  const agents = useQuery({ queryKey: opsKeys.agents, queryFn: () => api<{ agents: { id: string }[] }>('/api/agents').then((r) => r.agents) });
  const projects = useQuery({ queryKey: ['ops', 'projects'], enabled: !!audit, queryFn: () => api<{ projects: Project[] }>('/api/projects').then((r) => r.projects) });

  const filters = { status, source, agentId: agent, projectId, q: dq, limit, offset };
  const runs = useQuery({
    queryKey: [...opsKeys.runs, filters],
    queryFn: () => api<AuditResponse>(`/api/audit/runs${qs(filters)}`),
    placeholderData: (prev) => prev,
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === 'running') ? 3000 : false),
  });

  const agentOptions = useMemo(() => {
    const ids = new Set<string>(agents.data?.map((a) => a.id) ?? []);
    runs.data?.runs.forEach((r) => r.agent_id && ids.add(r.agent_id));
    if (agent) ids.add(agent);
    return [...ids].sort();
  }, [agents.data, runs.data, agent]);

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };
  const rows = runs.data?.runs ?? [];
  const running = rows.filter((r) => r.status === 'running').length;
  const filtered = !!(status || source || agent || projectId || dq);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={reset(setQ)} placeholder="Search prompt, agent or run id…" className="w-72" />
        <Select value={status} onChange={(e) => reset(setStatus)(e.target.value)} className="w-36" aria-label="Status">
          <option value="">All statuses</option>
          {RUN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select value={source} onChange={(e) => reset(setSource)(e.target.value)} className="w-36" aria-label="Source">
          <option value="">All sources</option>
          <option value="run">Headless runs</option>
          <option value="chat">Chat turns</option>
        </Select>
        <Select value={agent} onChange={(e) => reset(setAgent)(e.target.value)} className="w-52" aria-label="Agent">
          <option value="">All agents</option>
          {agentOptions.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        {audit && (
          <Select value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)} className="w-44" aria-label="Project">
            <option value="">All projects</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted">
          {running > 0 && <span className="flex items-center gap-1.5 text-warn"><span className="size-1.5 animate-pulse rounded-full bg-warn" />{running} running · auto-refreshing</span>}
          {filtered && <Button size="sm" variant="ghost" onClick={() => { setStatus(''); setSource(''); setAgent(''); setProjectId(''); setQ(''); setOffset(0); }}>Clear filters</Button>}
          <IconButton label="Refresh" onClick={() => runs.refetch()}><RefreshCw className={runs.isFetching ? 'size-4 animate-spin' : 'size-4'} /></IconButton>
        </div>
      </div>

      <ErrorNote error={runs.error} />

      <Card className="overflow-hidden">
        {runs.isLoading ? (
          <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title={filtered ? 'No runs match these filters' : 'No runs yet'}
            description={filtered ? 'Try widening the filters.' : 'Start a run from the New run page, or chat with an agent.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/50">
                <tr><Th>Run</Th><Th>Agent</Th><Th>Status</Th><Th>Model</Th><Th>Source</Th>{audit && <Th>Project</Th>}<Th className="text-right">Tokens in / out</Th><Th className="text-right">Duration</Th><Th>Started</Th>{audit && <Th />}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => nav(`/runs/${r.id}`)} className="cursor-pointer hover:bg-surface-2/50">
                    <Td className="max-w-xs">
                      <Mono className="text-accent">{r.id}</Mono>
                      {r.prompt && <div className="mt-0.5 truncate text-xs text-muted" title={r.prompt}>{r.prompt.replace(/\s+/g, ' ')}</div>}
                    </Td>
                    <Td className="max-w-44 truncate" title={r.agent_id ?? ''}>{r.agent_id ?? '—'}</Td>
                    <Td><RunStatus status={r.status} /></Td>
                    <Td className="max-w-40 truncate text-muted" title={r.model ?? ''}>{r.model || '—'}</Td>
                    <Td><SourceBadge source={r.source} /></Td>
                    {audit && <Td className="text-muted">{r.project_name ?? '—'}</Td>}
                    <Td className="text-right tabular-nums text-muted">{fmtCompact(r.tokens_in)} / {fmtCompact(r.tokens_out)}</Td>
                    <Td className="text-right tabular-nums text-muted">{fmtDuration(runDuration(r, r.duration_ms))}</Td>
                    <Td className="whitespace-nowrap text-muted" title={r.created_at}>{timeAgo(r.created_at)}</Td>
                    {audit && (
                      <Td className="text-right">
                        <IconButton label="Export audit bundle" onClick={(e) => { e.stopPropagation(); downloadFromApi(`/api/audit/runs/${r.id}/export`, `audit-${r.id}.json`).catch((err) => toast.error(errMsg(err))); }}>
                          <Download className="size-4" />
                        </IconButton>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runs.data && (
          <div className="flex items-center">
            <div className="flex-1"><Pagination offset={offset} limit={limit} total={runs.data.total} onChange={setOffset} /></div>
            <div className="border-t border-border px-4 py-1.5">
              <Select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }} className="h-7 w-24 text-xs" aria-label="Page size">
                {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </Select>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
