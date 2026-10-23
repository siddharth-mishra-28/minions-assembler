import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Settings as SettingsIcon, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, Select, Spinner, Tabs, toast, timeAgo } from '@/components/ui';
import { CodeBlock, ErrorNote, Mono, OpsPage, SearchBox, Td, Th, runTone } from '@/features/ops/components';
import { RunsExplorer } from '@/features/ops/RunsExplorer';
import { fmtDate, fmtNum, opsKeys, pretty, qs, useDebounced } from '@/features/ops/lib';

interface Approval { id: string; threadId: string | null; runId: string | null; tool: string; args: unknown; status: string; scope: string | null; decidedBy: string | null; reason: string | null; requestedAt: string; decidedAt: string | null }
interface LogEntry { ts: string; level: string; event: string; pid?: number; [k: string]: unknown }
interface Retention {
  settings: { days: number; scope: string; keepPinned: boolean };
  lastRun: { at: string; result: { cutoff: string; runs: number; threads: number; messages: number; approvals: number; paths: number; filesRemoved: number } } | null;
}

function Approvals() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q).toLowerCase();
  const list = useQuery({ queryKey: [...opsKeys.approvals, status], queryFn: () => api<{ approvals: Approval[] }>(`/api/approvals${qs({ status, limit: 500 })}`).then((r) => r.approvals), refetchInterval: 10000 });
  const rows = (list.data ?? []).filter((a) => !dq || [a.tool, a.runId, a.threadId, a.decidedBy, a.reason].some((v) => v?.toLowerCase().includes(dq)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Filter by tool, run, reason…" className="w-72" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status">
          <option value="">All statuses</option>
          {['pending', 'approved', 'denied', 'expired'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <IconButton label="Refresh" className="ml-auto" onClick={() => list.refetch()}><RefreshCw className={list.isFetching ? 'size-4 animate-spin' : 'size-4'} /></IconButton>
      </div>
      <ErrorNote error={list.error} />
      <Card className="overflow-hidden">
        {list.isLoading ? <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
          : rows.length === 0 ? <EmptyState icon={<ShieldCheck className="size-5" />} title="No approvals" description="Tool permission requests made by chat agents appear here." />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-surface-2/50"><tr><Th>Tool</Th><Th>Status</Th><Th>Scope</Th><Th>Run</Th><Th>Decided by</Th><Th>Reason</Th><Th>Requested</Th><Th>Decided</Th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((a) => (
                      <tr key={a.id} className="align-top">
                        <Td>
                          <Mono>{a.tool}</Mono>
                          {a.args != null && <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted hover:text-fg">arguments</summary><CodeBlock text={pretty(a.args)} maxHeight="max-h-40" className="mt-1" /></details>}
                        </Td>
                        <Td><Badge tone={runTone(a.status)}>{a.status}</Badge></Td>
                        <Td className="text-muted">{a.scope ?? '—'}</Td>
                        <Td>{a.runId ? <button onClick={() => nav(`/runs/${a.runId}`)} className="text-accent hover:underline"><Mono>{a.runId}</Mono></button> : '—'}</Td>
                        <Td className="text-muted">{a.decidedBy ?? '—'}</Td>
                        <Td className="max-w-xs text-muted">{a.reason ?? '—'}</Td>
                        <Td className="whitespace-nowrap text-muted" title={a.requestedAt}>{timeAgo(a.requestedAt)}</Td>
                        <Td className="whitespace-nowrap text-muted">{a.decidedAt ? timeAgo(a.decidedAt) : '—'}</Td>
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

const levelTone = (l: string) => (l === 'error' ? 'danger' : l === 'warn' ? 'warn' : l === 'audit' ? 'accent' : 'neutral') as 'danger' | 'warn' | 'accent' | 'neutral';

function ServerLog() {
  const [level, setLevel] = useState('');
  const [event, setEvent] = useState('');
  const [limit, setLimit] = useState(200);
  const [live, setLive] = useState(false);
  const devent = useDebounced(event);
  const logs = useQuery({
    queryKey: ['ops', 'logs', level, devent, limit],
    queryFn: () => api<{ file: string; count: number; entries: LogEntry[] }>(`/api/logs${qs({ level, event: devent, limit })}`),
    refetchInterval: live ? 3000 : false,
  });
  const entries = [...(logs.data?.entries ?? [])].reverse();
  const detail = (e: LogEntry) => {
    const { ts, level: _l, event: _e, pid, ...rest } = e; void ts; void _l; void _e; void pid;
    return Object.keys(rest).length ? JSON.stringify(rest) : '';
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-36" aria-label="Level">
          <option value="">All levels</option>{['info', 'warn', 'error', 'audit'].map((l) => <option key={l} value={l}>{l}</option>)}
        </Select>
        <SearchBox value={event} onChange={setEvent} placeholder="Event name (e.g. http.request)" className="w-64" />
        <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="w-32" aria-label="Limit">
          {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}
        </Select>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-[var(--c-accent)]" />Live tail</label>
        <IconButton label="Refresh" className="ml-auto" onClick={() => logs.refetch()}><RefreshCw className={logs.isFetching ? 'size-4 animate-spin' : 'size-4'} /></IconButton>
      </div>
      <ErrorNote error={logs.error} />
      {logs.data?.file && <p className="text-xs text-muted">Reading <Mono>{logs.data.file}</Mono> · {fmtNum(logs.data.count)} entries · newest first</p>}
      <Card className="overflow-hidden">
        {logs.isLoading ? <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
          : entries.length === 0 ? <EmptyState title="No log entries" description="Nothing matches these filters." />
            : (
              <div className="max-h-[60vh] divide-y divide-border overflow-auto font-mono text-xs">
                {entries.map((e, i) => (
                  <div key={`${e.ts}-${i}`} className="flex items-start gap-3 px-4 py-1.5 hover:bg-surface-2/50">
                    <span className="w-44 shrink-0 text-muted">{e.ts}</span>
                    <span className="w-14 shrink-0"><Badge tone={levelTone(e.level)}>{e.level}</Badge></span>
                    <span className="w-44 shrink-0 truncate font-medium" title={e.event}>{e.event}</span>
                    <span className="min-w-0 flex-1 break-all text-muted">{detail(e)}</span>
                  </div>
                ))}
              </div>
            )}
      </Card>
    </div>
  );
}

function RetentionTab() {
  const [confirm, setConfirm] = useState(false);
  const [days, setDays] = useState('');
  const ret = useQuery({ queryKey: opsKeys.retention, queryFn: () => api<Retention>('/api/retention') });
  const purge = useApiMutation((d: number | undefined) => api('/api/retention/purge', { method: 'POST', body: d ? { days: d } : {} }), {
    invalidate: [opsKeys.retention, opsKeys.runs],
    onSuccess: () => { toast.ok('Purge complete'); setConfirm(false); },
  });
  const s = ret.data?.settings;
  const last = ret.data?.lastRun;
  const override = days.trim() ? Number(days) : undefined;
  const invalid = override !== undefined && !(Number.isInteger(override) && override >= 1 && override <= 3650);
  const effective = override ?? s?.days ?? 0;

  return (
    <div className="space-y-4">
      <ErrorNote error={ret.error} />
      {ret.isLoading && <div className="flex justify-center py-10"><Spinner className="size-5" /></div>}
      {s && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Policy</h3><Link to="/settings" className="flex items-center gap-1 text-xs text-accent hover:underline"><SettingsIcon className="size-3.5" />Configure in Settings</Link></div>
            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Keep data for</dt><dd>{s.days > 0 ? `${s.days} days` : <Badge>keep forever</Badge>}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Scope</dt><dd>{s.scope}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Keep pinned threads</dt><dd>{s.keepPinned ? 'Yes' : 'No'}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-muted">Purges run automatically on a schedule. Dashboard totals survive purges via daily rollups.</p>
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold">Last purge</h3>
            {!last ? <p className="text-sm text-muted">No purge has run yet.</p> : (
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted">When</dt><dd title={fmtDate(last.at)}>{timeAgo(last.at)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Cutoff</dt><dd>{fmtDate(last.result.cutoff)}</dd></div>
                {([['Runs', last.result.runs], ['Threads', last.result.threads], ['Messages', last.result.messages], ['Approvals', last.result.approvals], ['Files removed', last.result.filesRemoved]] as const).map(([k, v]) => (
                  <div key={k} className="flex justify-between"><dt className="text-muted">{k}</dt><dd className="tabular-nums">{fmtNum(v)}</dd></div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div><h3 className="text-sm font-semibold">Purge now</h3><p className="text-xs text-muted">Permanently deletes runs, chats, approvals and files older than the retention window.</p></div>
        <Button variant="danger" onClick={() => setConfirm(true)} disabled={!s}><Trash2 className="size-4" />Run purge now</Button>
      </Card>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Run retention purge?"
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" loading={purge.isPending} disabled={invalid || effective === 0} onClick={() => purge.mutate(override)}>Delete old data</Button></>}>
        <div className="space-y-3 text-sm">
          <p>{effective > 0 ? <>This permanently deletes data older than <strong>{effective} days</strong>{s?.keepPinned && override === undefined ? ' (pinned threads are kept)' : ''}. This cannot be undone.</> : 'Retention is set to keep forever, so there is nothing to purge. Enter a number of days to override.'}</p>
          <Field label="Override days (optional)" hint="Leave blank to use the configured policy." error={invalid ? 'Enter a whole number from 1 to 3650.' : undefined}>
            <Input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} placeholder={s ? String(s.days) : ''} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

export default function Audit() {
  const [tab, setTab] = useState<'trail' | 'approvals' | 'logs' | 'retention'>('trail');
  return (
    <OpsPage title="Audit & logs" description="Complete run history, tool approvals, the server log and data retention.">
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ id: 'trail', label: 'Audit trail' }, { id: 'approvals', label: 'Tool approvals' }, { id: 'logs', label: 'Server log' }, { id: 'retention', label: 'Retention' }]} /></div>
      {tab === 'trail' && <RunsExplorer audit />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'logs' && <ServerLog />}
      {tab === 'retention' && <RetentionTab />}
    </OpsPage>
  );
}
