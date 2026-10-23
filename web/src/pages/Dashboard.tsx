import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, Coins, Cpu, Gauge, Timer, TrendingUp, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Card, EmptyState, Select, Spinner, timeAgo } from '@/components/ui';
import { ErrorNote, Mono, OpsPage, RunStatus, Stat, Td, Th } from '@/features/ops/components';
import { fmtCompact, fmtDuration, fmtNum } from '@/features/ops/lib';

interface Daily { day: string; runs: number; succeeded: number; failed: number; tokensIn: number; tokensOut: number; credits: number }
interface DailyResp { days: Daily[]; purgedTotals?: Record<string, number> }
interface Metrics {
  agents: { total: number; latest: number; byRuns: { id: string; runs: number }[] };
  runs: { total: number; last24h: number; finished: number; succeeded: number; byStatus: Record<string, number> };
  usage: { tokensIn: number; tokensOut: number; credits: number; avgDurationMs: number | null };
  mcp: { total: number };
  recentRuns: { id: string; agent_id: string; status: string; model: string | null; created_at: string }[];
  timeline: { hour: string; requests: number; succeeded: number; failed: number; running: number }[];
  byModel: { model: string; requests: number; succeeded: number; failed: number; avgDurationMs: number | null; tokensIn: number; tokensOut: number }[];
}
interface Status { name: string; version: string; sdk: string; db: string; uptime: number; workspace: string; workspaceSource: string; logFile: string }

const C = { accent: 'var(--c-accent)', ok: 'var(--c-ok)', danger: 'var(--c-danger)', warn: 'var(--c-warn)', muted: 'var(--c-muted)', border: 'var(--c-border)', surface: 'var(--c-surface)', fg: 'var(--c-fg)' };

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
function fillDays(days: Daily[], n: number): Daily[] {
  const map = new Map(days.map((d) => [d.day.slice(0, 10), d]));
  const out: Daily[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(new Date(today.getTime() - i * 86400000));
    out.push(map.get(k) ?? { day: k, runs: 0, succeeded: 0, failed: 0, tokensIn: 0, tokensOut: 0, credits: 0 });
  }
  return out;
}
const fmtUptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);

const tooltipStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.fg };
const axis = { stroke: C.muted, fontSize: 11, tickLine: false, axisLine: false } as const;

function ChartCard({ title, subtitle, empty, children }: { title: string; subtitle?: string; empty: boolean; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3"><h3 className="text-sm font-semibold">{title}</h3>{subtitle && <p className="text-xs text-muted">{subtitle}</p>}</div>
      <div className="h-56">
        {empty ? <div className="flex h-full items-center justify-center text-sm text-muted">No data in this range yet.</div>
          : <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const nav = useNavigate();
  const [days, setDays] = useState(14);

  const daily = useQuery({ queryKey: ['ops', 'daily', days], queryFn: () => api<DailyResp>(`/api/metrics/daily?days=${days}`), refetchInterval: 15000 });
  const metrics = useQuery({ queryKey: ['ops', 'metrics'], queryFn: () => api<Metrics>('/api/metrics'), refetchInterval: 10000 });
  const status = useQuery({ queryKey: ['ops', 'status'], queryFn: () => api<Status>('/api/status'), refetchInterval: 30000 });

  const series = useMemo(() => fillDays(daily.data?.days ?? [], days).map((d) => ({ ...d, label: d.day.slice(5) })), [daily.data, days]);
  const totals = useMemo(() => series.reduce((a, d) => ({ runs: a.runs + d.runs, ok: a.ok + d.succeeded, bad: a.bad + d.failed, tin: a.tin + d.tokensIn, tout: a.tout + d.tokensOut, credits: a.credits + d.credits }), { runs: 0, ok: 0, bad: 0, tin: 0, tout: 0, credits: 0 }), [series]);
  const m = metrics.data;
  const finished = totals.ok + totals.bad;
  const rate = finished > 0 ? Math.round((totals.ok / finished) * 100) : null;
  const active = m?.runs.byStatus.running ?? 0;
  const hours = (m?.timeline ?? []).map((h) => ({ ...h, label: h.hour.slice(11, 13) + ':00' }));
  const agentBars = (m?.agents.byRuns ?? []).slice(0, 8).map((a) => ({ name: a.id, runs: a.runs }));
  const noData = totals.runs === 0;

  return (
    <OpsPage title="Dashboard" description="Fleet activity, usage and health at a glance."
      actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36" aria-label="Range">{[7, 14, 30].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select>}>
      <div className="space-y-5">
        <ErrorNote error={daily.error ?? metrics.error} />
        {(daily.isLoading || metrics.isLoading) && <div className="flex justify-center py-6"><Spinner className="size-5" /></div>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={`Runs · ${days}d`} value={fmtNum(totals.runs)} hint={m ? `${fmtNum(m.runs.last24h)} in the last 24h` : undefined} icon={<Activity className="size-4" />} />
          <Stat label="Success rate" value={rate === null ? '—' : `${rate}%`} hint={finished ? `${totals.ok} ok · ${totals.bad} failed` : 'no finished runs'} icon={<TrendingUp className="size-4" />} />
          <Stat label="Active runs" value={fmtNum(active)} hint={active ? 'running now' : 'idle'} icon={<Zap className="size-4" />} />
          <Stat label="Avg duration" value={fmtDuration(m?.usage.avgDurationMs)} hint="recent runs" icon={<Timer className="size-4" />} />
          <Stat label="Tokens in" value={fmtCompact(totals.tin)} hint={`${fmtNum(totals.tin)} total`} icon={<Cpu className="size-4" />} />
          <Stat label="Tokens out" value={fmtCompact(totals.tout)} hint={`${fmtNum(totals.tout)} total`} icon={<Cpu className="size-4" />} />
          <Stat label="Credits" value={totals.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} hint="premium requests" icon={<Coins className="size-4" />} />
          <Stat label="Agents" value={fmtNum(m?.agents.total)} hint={m ? `${m.agents.latest ?? 0} latest · ${m.mcp.total} MCP servers` : undefined} icon={<Gauge className="size-4" />} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Runs per day" subtitle="Succeeded vs failed" empty={noData}>
            <BarChart data={series} margin={{ left: -20, right: 4, top: 4 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" {...axis} /><YAxis allowDecimals={false} {...axis} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.border, opacity: 0.3 }} />
              <Bar dataKey="succeeded" name="Succeeded" stackId="r" fill={C.ok} radius={[0, 0, 0, 0]} />
              <Bar dataKey="failed" name="Failed" stackId="r" fill={C.danger} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Tokens per day" subtitle="Input and output" empty={noData}>
            <AreaChart data={series} margin={{ left: -10, right: 4, top: 4 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" {...axis} /><YAxis tickFormatter={(v: number) => fmtCompact(v)} {...axis} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNum(Number(v))} />
              <Area type="monotone" dataKey="tokensIn" name="Tokens in" stroke={C.accent} fill={C.accent} fillOpacity={0.18} strokeWidth={2} />
              <Area type="monotone" dataKey="tokensOut" name="Tokens out" stroke={C.warn} fill={C.warn} fillOpacity={0.15} strokeWidth={2} />
            </AreaChart>
          </ChartCard>
          <ChartCard title="Last 24 hours" subtitle="Requests per hour" empty={!hours.some((h) => h.requests > 0)}>
            <BarChart data={hours} margin={{ left: -20, right: 4, top: 4 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval={3} {...axis} /><YAxis allowDecimals={false} {...axis} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.border, opacity: 0.3 }} />
              <Bar dataKey="succeeded" name="Succeeded" stackId="h" fill={C.ok} />
              <Bar dataKey="failed" name="Failed" stackId="h" fill={C.danger} />
              <Bar dataKey="running" name="Running" stackId="h" fill={C.warn} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Busiest agents" subtitle="Runs among the most recent executions" empty={agentBars.length === 0}>
            <BarChart data={agentBars} layout="vertical" margin={{ left: 8, right: 12, top: 4 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} {...axis} />
              <YAxis type="category" dataKey="name" width={130} {...axis} tickFormatter={(v: string) => (v.length > 20 ? v.slice(0, 19) + '…' : v)} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.border, opacity: 0.3 }} />
              <Bar dataKey="runs" name="Runs" fill={C.accent} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
        </div>

        {daily.data?.purgedTotals && daily.data.purgedTotals.runs > 0 && (
          <p className="text-xs text-muted">Retention has purged {fmtNum(daily.data.purgedTotals.runs)} older runs; their totals are retained in daily rollups and not shown in this range.</p>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="overflow-hidden lg:col-span-2">
            <div className="flex items-center justify-between border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">Recent runs</h3><Link to="/runs" className="text-xs text-accent hover:underline">View all</Link></div>
            {!m || m.recentRuns.length === 0 ? <EmptyState title="No runs yet" description="Runs will show up here as soon as an agent executes." /> : (
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/50"><tr><Th>Run</Th><Th>Agent</Th><Th>Status</Th><Th>Model</Th><Th>Started</Th></tr></thead>
                <tbody className="divide-y divide-border">
                  {m.recentRuns.slice(0, 8).map((r) => (
                    <tr key={r.id} onClick={() => nav(`/runs/${r.id}`)} className="cursor-pointer hover:bg-surface-2/50">
                      <Td><Mono className="text-accent">{r.id}</Mono></Td>
                      <Td className="max-w-40 truncate">{r.agent_id}</Td>
                      <Td><RunStatus status={r.status} /></Td>
                      <Td className="max-w-32 truncate text-muted">{r.model || '—'}</Td>
                      <Td className="whitespace-nowrap text-muted">{timeAgo(r.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">System status</h3>
            {status.error ? <ErrorNote error={status.error} /> : !status.data ? <Spinner className="size-4" /> : (
              <dl className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between"><dt className="text-muted">Server</dt><dd><Badge tone="ok">online</Badge></dd></div>
                {([['Name', status.data.name], ['Version', status.data.version], ['SDK', status.data.sdk], ['Uptime', fmtUptime(status.data.uptime)]] as const).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="truncate">{v}</dd></div>
                ))}
                {([['Database', status.data.db], ['Workspace', status.data.workspace], ['Log file', status.data.logFile]] as const).map(([k, v]) => (
                  <div key={k}><dt className="text-muted">{k}</dt><dd className="break-all font-mono text-[11px]">{v}</dd></div>
                ))}
              </dl>
            )}
          </Card>
        </div>

        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">By model</h3><p className="text-xs text-muted">Across the most recent executions</p></div>
          {!m || m.byModel.length === 0 ? <EmptyState title="No model usage yet" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/50"><tr><Th>Model</Th><Th className="text-right">Requests</Th><Th className="text-right">Succeeded</Th><Th className="text-right">Failed</Th><Th className="text-right">Avg duration</Th><Th className="text-right">Tokens in</Th><Th className="text-right">Tokens out</Th></tr></thead>
                <tbody className="divide-y divide-border">
                  {m.byModel.map((r) => (
                    <tr key={r.model}>
                      <Td className="font-medium">{r.model || 'default'}</Td>
                      <Td className="text-right tabular-nums">{fmtNum(r.requests)}</Td>
                      <Td className="text-right tabular-nums text-ok">{fmtNum(r.succeeded)}</Td>
                      <Td className="text-right tabular-nums text-danger">{fmtNum(r.failed)}</Td>
                      <Td className="text-right tabular-nums text-muted">{fmtDuration(r.avgDurationMs)}</Td>
                      <Td className="text-right tabular-nums text-muted">{fmtCompact(r.tokensIn)}</Td>
                      <Td className="text-right tabular-nums text-muted">{fmtCompact(r.tokensOut)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </OpsPage>
  );
}
