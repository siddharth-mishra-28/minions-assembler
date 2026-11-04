import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileJson, Play, Wand2 } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { Badge, Button, Card, Field, Input, Select, Tabs, Textarea, toast } from '@/components/ui';
import { ErrorNote, OpsPage } from '@/features/ops/components';
import { opsKeys, qs, type RunRow } from '@/features/ops/lib';

interface AgentDef { metadata?: { name?: string; version?: string }; provider?: { model?: string }; task?: { prompt?: string }; [k: string]: unknown }
interface RunResult { runId: string; sessionId?: string; traceId?: string; text?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function NewRun() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<'agent' | 'inline'>('agent');
  const [agentId, setAgentId] = useState(params.get('agent') ?? '');
  const [task, setTask] = useState('');
  const [taskTouched, setTaskTouched] = useState(false);
  const [inline, setInline] = useState('');
  const [audit, setAudit] = useState('');
  const [timeoutMin, setTimeoutMin] = useState('');
  const [runDir, setRunDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const agents = useQuery({ queryKey: opsKeys.agents, queryFn: () => api<{ agents: { id: string; name: string; version: string; status?: string }[] }>('/api/agents').then((r) => r.agents) });
  const agent = useQuery({
    queryKey: ['ops', 'agent', agentId], enabled: mode === 'agent' && !!agentId,
    queryFn: () => api<{ definition: AgentDef }>(`/api/agents/${encodeURIComponent(agentId)}`),
  });

  useEffect(() => { if (!agentId && agents.data?.length) setAgentId(agents.data[0].id); }, [agents.data, agentId]);
  useEffect(() => { setTaskTouched(false); }, [agentId]);
  const defaultTask = agent.data?.definition?.task?.prompt ?? '';
  useEffect(() => { if (!taskTouched) setTask(defaultTask); }, [defaultTask, taskTouched, agentId]);

  const parsed = (() => {
    if (mode !== 'inline' || !inline.trim()) return { def: null as AgentDef | null, err: null as string | null };
    try { return { def: JSON.parse(inline) as AgentDef, err: null }; } catch (e) { return { def: null, err: (e as Error).message }; }
  })();

  const loadTemplate = async () => {
    try { setInline(JSON.stringify(await api<AgentDef>('/api/templates/default'), null, 2)); } catch (e) { toast.error(errMsg(e)); }
  };

  const submit = async () => {
    setError(null);
    let path: string; let effectiveId: string; const body: Record<string, unknown> = {};
    if (mode === 'agent') {
      if (!agentId) { setError('Choose an agent.'); return; }
      path = `/api/agents/${encodeURIComponent(agentId)}/runs`; effectiveId = agentId;
      if (task.trim() && task.trim() !== defaultTask.trim()) body.taskOverride = task;
    } else {
      if (!parsed.def) { setError(parsed.err ? `Definition is not valid JSON: ${parsed.err}` : 'Paste an agent definition.'); return; }
      path = '/api/agent-definitions/runs';
      effectiveId = `${parsed.def.metadata?.name ?? ''}@${parsed.def.metadata?.version ?? ''}`;
      body.definition = parsed.def;
      if (task.trim()) body.taskOverride = task;
    }
    if (audit) body.auditLevel = audit;
    if (timeoutMin) {
      const ms = Math.round(Number(timeoutMin) * 60000);
      if (!(ms >= 1000 && ms <= 21600000)) { setError('Timeout must be between 1 second and 360 minutes.'); return; }
      body.turnTimeoutMs = ms;
    }
    if (runDir.trim()) body.runDir = runDir.trim();

    setBusy(true);
    const known = new Set<string>();
    const list = () => api<{ runs: RunRow[] }>(`/api/runs${qs({ agentId: effectiveId })}`).then((r) => r.runs).catch(() => [] as RunRow[]);
    (await list()).forEach((r) => known.add(r.id));

    // The POST blocks until the run finishes, so jump to the run as soon as it shows up.
    let navigated = false;
    const go = (runId: string) => { if (!navigated && !cancelled.current) { navigated = true; nav(`/runs/${runId}`); } };
    const poller = (async () => {
      while (!navigated && !cancelled.current) {
        await sleep(1200);
        const fresh = (await list()).find((r) => !known.has(r.id));
        if (fresh) go(fresh.id);
      }
    })();
    try {
      const res = await api<RunResult>(path, { method: 'POST', body });
      go(res.runId);
    } catch (e) {
      if (!navigated) { setError(errMsg(e)); toast.error('Run failed to start'); }
    } finally {
      navigated = true;
      await poller;
      if (!cancelled.current) setBusy(false);
    }
  };

  const selected = agents.data?.find((a) => a.id === agentId);

  return (
    <OpsPage title="New run" description="Execute an agent headlessly with a task prompt. Every run is audited and appears in Runs." narrow>
      <div className="space-y-5">
        <Tabs value={mode} onChange={(m) => setMode(m)} items={[{ id: 'agent', label: 'Registered agent' }, { id: 'inline', label: 'Inline definition' }]} />

        <Card className="space-y-4 p-5">
          {mode === 'agent' ? (
            <Field label="Agent" hint={agents.data?.length === 0 ? 'No agents registered yet — create one in Agents, or use an inline definition.' : undefined}>
              <Select value={agentId} onChange={(e) => { setAgentId(e.target.value); setParams(e.target.value ? { agent: e.target.value } : {}, { replace: true }); }} disabled={busy}>
                {!agentId && <option value="">Select an agent…</option>}
                {agentId && !selected && <option value={agentId}>{agentId}</option>}
                {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.id}{a.status && a.status !== 'active' ? ` (${a.status})` : ''}</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="Agent definition (JSON)" error={parsed.err ? `Invalid JSON: ${parsed.err}` : undefined}
              hint="Runs once without being registered. Must include metadata.name, metadata.version and a task.prompt.">
              <div className="mb-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={loadTemplate} disabled={busy}><Wand2 className="size-3.5" />Load default template</Button>
                <Button size="sm" variant="ghost" disabled={!parsed.def || busy} onClick={() => setInline(JSON.stringify(parsed.def, null, 2))}><FileJson className="size-3.5" />Format</Button>
              </div>
              <Textarea value={inline} onChange={(e) => setInline(e.target.value)} rows={16} spellCheck={false} className="font-mono text-xs" disabled={busy} placeholder='{ "apiVersion": "minions/v1", "metadata": { "name": "my-agent", "version": "1.0.0" }, … }' />
            </Field>
          )}

          {mode === 'agent' && agent.data && (
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <Badge>{agent.data.definition?.provider?.model ?? 'default model'}</Badge>
              {agent.data.definition?.metadata?.version && <Badge>v{agent.data.definition.metadata.version}</Badge>}
            </div>
          )}

          <Field label="Task prompt" hint={mode === 'agent' ? 'Prefilled from the agent definition. Editing sends a one-off override; the registered agent is unchanged.' : 'Optional — overrides task.prompt from the definition.'}>
            <Textarea value={task} onChange={(e) => { setTask(e.target.value); setTaskTouched(true); }} rows={6} disabled={busy} placeholder="What should the agent do?" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Audit level" hint="How much detail is recorded in the event chain.">
              <Select value={audit} onChange={(e) => setAudit(e.target.value)} disabled={busy}>
                <option value="">Default</option><option value="minimal">Minimal</option><option value="full">Full (stream deltas)</option>
              </Select>
            </Field>
            <Field label="Turn timeout (minutes)" hint="Blank uses the server default.">
              <Input type="number" min={0.02} max={360} step="any" value={timeoutMin} onChange={(e) => setTimeoutMin(e.target.value)} disabled={busy} placeholder="server default" />
            </Field>
          </div>

          <Field label="Working directory (optional)" hint="Reuse a folder across runs, for example when a second phase builds on the first. Must be inside the server workspace.">
            <Input value={runDir} onChange={(e) => setRunDir(e.target.value)} disabled={busy} placeholder="default: a fresh run_<id> folder" spellCheck={false} className="font-mono text-xs" />
          </Field>

          <ErrorNote error={error} />
          <div className="flex items-center justify-end gap-2">
            {busy && <span className="text-xs text-muted">Starting run… you'll be taken to it as soon as it begins.</span>}
            <Button variant="ghost" onClick={() => nav('/runs')} disabled={busy}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={submit} disabled={mode === 'agent' ? !agentId : !inline.trim()}><Play className="size-4" />Start run</Button>
          </div>
        </Card>
      </div>
    </OpsPage>
  );
}
