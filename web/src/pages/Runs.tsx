import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Card, EmptyState, IconButton, Spinner, Tabs, timeAgo } from '@/components/ui';
import { ErrorNote, Mono, OpsPage, RunStatus, SearchBox, Td, Th } from '@/features/ops/components';
import { RunsExplorer } from '@/features/ops/RunsExplorer';
import { opsKeys, useDebounced } from '@/features/ops/lib';

interface SessionRow { session_id: string; run_id: string | null; agent_id: string | null; trace_id: string | null; status: string | null; summary: string | null; created_at: string; updated_at: string }

function Sessions() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q).toLowerCase();
  const sessions = useQuery({ queryKey: opsKeys.sessions, queryFn: () => api<{ sessions: SessionRow[] }>('/api/sessions').then((r) => r.sessions) });
  const rows = (sessions.data ?? []).filter((s) => !dq || [s.session_id, s.agent_id, s.run_id, s.status, s.summary].some((v) => v?.toLowerCase().includes(dq)));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Filter sessions…" className="w-72" />
        <IconButton label="Refresh" className="ml-auto" onClick={() => sessions.refetch()}><RefreshCw className={sessions.isFetching ? 'size-4 animate-spin' : 'size-4'} /></IconButton>
      </div>
      <ErrorNote error={sessions.error} />
      <Card className="overflow-hidden">
        {sessions.isLoading ? <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
          : rows.length === 0 ? <EmptyState title="No sessions" description="SDK sessions appear here once an agent has run." />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-surface-2/50"><tr><Th>Session</Th><Th>Agent</Th><Th>Run</Th><Th>Status</Th><Th>Summary</Th><Th>Updated</Th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((s) => (
                      <tr key={s.session_id} onClick={() => s.run_id && nav(`/runs/${s.run_id}`)} className={s.run_id ? 'cursor-pointer hover:bg-surface-2/50' : ''}>
                        <Td><Mono>{s.session_id}</Mono></Td>
                        <Td className="max-w-44 truncate">{s.agent_id ?? '—'}</Td>
                        <Td>{s.run_id ? <Mono className="text-accent">{s.run_id}</Mono> : '—'}</Td>
                        <Td>{s.status ? <RunStatus status={s.status} /> : '—'}</Td>
                        <Td className="max-w-sm truncate text-muted" title={s.summary ?? ''}>{s.summary || '—'}</Td>
                        <Td className="whitespace-nowrap text-muted">{timeAgo(s.updated_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>
    </div>
  );
}

export default function Runs() {
  const nav = useNavigate();
  const [tab, setTab] = useState<'runs' | 'sessions'>('runs');
  return (
    <OpsPage title="Runs" description="Every agent execution — headless runs and chat turns — with status, usage and a full event chain."
      actions={<Button variant="primary" onClick={() => nav('/runs/new')}><Plus className="size-4" />New run</Button>}>
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ id: 'runs', label: 'Runs' }, { id: 'sessions', label: 'SDK sessions' }]} /></div>
      {tab === 'runs' ? <RunsExplorer /> : <Sessions />}
    </OpsPage>
  );
}
