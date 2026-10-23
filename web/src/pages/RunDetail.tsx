import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { ArrowLeft, Copy, Download, MessageSquare, Play, RefreshCw, Square } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';
import { Badge, Button, Card, EmptyState, Spinner, toast } from '@/components/ui';
import { CodeBlock, CopyButton, ErrorNote, Mono, OpsPage, RunStatus, SourceBadge, Td, Th } from '@/features/ops/components';
import { Timeline, finalOutput, usageFromEvents } from '@/features/ops/Timeline';
import { copyText, downloadBlob, fmtDate, fmtDuration, fmtNum, opsKeys, pretty, runDuration, type AuditBundle } from '@/features/ops/lib';
import { runTone } from '@/features/ops/components';

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

export default function RunDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const bundle = useQuery({
    queryKey: opsKeys.bundle(id),
    queryFn: () => api<AuditBundle>(`/api/audit/runs/${encodeURIComponent(id)}/export`),
    refetchInterval: (q) => (['running', 'queued'].includes(q.state.data?.run.status ?? '') ? 2000 : false),
    retry: (n, e) => n < 2 && !/404|not found/i.test(errMsg(e)),
  });
  const run = bundle.data?.run;
  const threadId = run?.thread_id ?? null;
  const live = run?.status === 'running' || run?.status === 'queued';

  const stop = useApiMutation(() => api(`/api/chat/threads/${encodeURIComponent(threadId ?? '')}/cancel`, { method: 'POST' }), {
    onSuccess: () => { toast.ok('Stop requested'); qc.invalidateQueries({ queryKey: opsKeys.bundle(id) }); },
  });

  const events = bundle.data?.events ?? [];
  const output = useMemo(() => finalOutput(events), [events]);
  const derived = useMemo(() => usageFromEvents(events), [events]);
  const usage = bundle.data?.usage;
  const tokensIn = usage?.tokens_in ?? derived?.tokensIn ?? null;
  const tokensOut = usage?.tokens_out ?? derived?.tokensOut ?? null;
  const approvals = bundle.data?.approvals ?? [];

  const json = () => JSON.stringify(bundle.data, null, 2);
  const actions = (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={() => nav('/runs')}><ArrowLeft className="size-4" />Runs</Button>
      {run && (
        <>
          {live && threadId && <Button variant="danger" loading={stop.isPending} onClick={() => stop.mutate(undefined)}><Square className="size-3.5" />Stop</Button>}
          {threadId && <Button variant="secondary" onClick={() => nav(`/chat/${threadId}`)}><MessageSquare className="size-4" />Open chat</Button>}
          {run.agent_id && !threadId && <Button variant="secondary" onClick={() => nav(`/runs/new?agent=${encodeURIComponent(run.agent_id ?? '')}`)}><Play className="size-4" />Run again</Button>}
          <Button variant="secondary" onClick={() => copyText(json(), 'Bundle copied')}><Copy className="size-4" />Copy JSON</Button>
          <Button variant="primary" onClick={() => downloadBlob(new Blob([json()], { type: 'application/json' }), `audit-${id}.json`)}><Download className="size-4" />Export</Button>
        </>
      )}
    </div>
  );

  if (bundle.isLoading) return <OpsPage title="Run"><div className="flex justify-center py-24"><Spinner className="size-6" /></div></OpsPage>;
  if (bundle.error || !run) {
    return (
      <OpsPage title="Run" actions={<Button variant="ghost" onClick={() => nav('/runs')}><ArrowLeft className="size-4" />Runs</Button>}>
        <EmptyState title="Run not found" description={bundle.error ? errMsg(bundle.error) : `No run with id ${id}.`}
          action={<Button variant="secondary" onClick={() => bundle.refetch()}><RefreshCw className="size-4" />Retry</Button>} />
      </OpsPage>
    );
  }

  return (
    <OpsPage title={run.agent_id ?? 'Run'} description={run.id} actions={actions}>
      <div className="space-y-5">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <RunStatus status={run.status} /><SourceBadge source={run.source} />
            {run.provider_type && <Badge>{run.provider_type}</Badge>}
            {run.status === 'idle' && <span className="text-xs text-muted">Waiting for the next message in its chat thread.</span>}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <Meta label="Agent">{run.agent_id ? <Link to={`/runs/new?agent=${encodeURIComponent(run.agent_id)}`} className="text-accent hover:underline">{run.agent_id}</Link> : '—'}</Meta>
            <Meta label="Model">{run.model || '—'}</Meta>
            <Meta label="Started">{fmtDate(run.created_at)}</Meta>
            <Meta label="Duration">{fmtDuration(runDuration(run, usage?.duration_ms))}{live && ' (running)'}</Meta>
            <Meta label="Tokens in">{fmtNum(tokensIn)}</Meta>
            <Meta label="Tokens out">{fmtNum(tokensOut)}</Meta>
            <Meta label="Credits">{usage?.credits != null ? usage.credits.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}</Meta>
            <Meta label="Finished">{run.finished_at ? fmtDate(run.finished_at) : '—'}</Meta>
            <Meta label="Session">{run.session_id ? <Mono>{run.session_id}</Mono> : '—'}</Meta>
            <Meta label="Trace">{run.trace_id ? <Mono>{run.trace_id}</Mono> : '—'}</Meta>
            <Meta label="Chat thread">{threadId ? <Link to={`/chat/${threadId}`} className="text-accent hover:underline">{threadId}</Link> : '—'}</Meta>
            <Meta label="Definition hash">{run.definition_hash ? <Mono>{run.definition_hash.slice(0, 16)}</Mono> : '—'}</Meta>
          </div>
          {run.error && (
            <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-danger">Error</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-danger">{run.error}</pre>
            </div>
          )}
        </Card>

        {run.task_prompt && (
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Task prompt</h3><CopyButton text={run.task_prompt} /></div>
            <CodeBlock text={run.task_prompt} maxHeight="max-h-48" />
          </Card>
        )}

        {output && (
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Output</h3><CopyButton text={output} /></div>
            <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown>{output}</ReactMarkdown></div>
          </Card>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold">Event timeline</h3>
          <ErrorNote error={bundle.isRefetchError ? 'Refresh failed — showing the last loaded data.' : null} />
          <Timeline events={events} live={live} />
        </section>

        {approvals.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Tool approvals <span className="font-normal text-muted">({approvals.length})</span></h3>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-surface-2/50"><tr><Th>Tool</Th><Th>Status</Th><Th>Scope</Th><Th>Decided by</Th><Th>Reason</Th><Th>Requested</Th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {approvals.map((a) => (
                      <tr key={a.id}>
                        <Td><Mono>{a.tool}</Mono>{a.args != null && <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted">args</summary><CodeBlock text={pretty(a.args)} maxHeight="max-h-40" /></details>}</Td>
                        <Td><Badge tone={runTone(a.status)}>{a.status}</Badge></Td>
                        <Td className="text-muted">{a.scope ?? '—'}</Td>
                        <Td className="text-muted">{a.decidedBy ?? '—'}</Td>
                        <Td className="max-w-xs truncate text-muted" title={a.reason ?? ''}>{a.reason ?? '—'}</Td>
                        <Td className="whitespace-nowrap text-muted">{fmtDate(a.requestedAt)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        )}
      </div>
    </OpsPage>
  );
}
