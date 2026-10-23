import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Bot, FolderOpen, KeyRound, Square, Wand2 } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { qk, useBootstrap, useChatAgents, useProjects, useThread } from '@/lib/queries';
import { useApp } from '@/lib/store';
import { Badge, Button, EmptyState, IconButton, Select, Spinner, cn, toast } from '@/components/ui';
import { useChatStream } from '@/features/chat/useChatStream';
import { AssistantBlock, MessageView } from '@/features/chat/MessageView';
import { ApprovalCard } from '@/features/chat/ApprovalCard';
import type { ApprovalMode } from '@/lib/types';

const DEFAULT_AGENT = 'copilot-default@builtin';
const STARTERS = [
  'Give me an overview of this project’s architecture',
  'Find and explain any failing tests',
  'Review the latest changes for bugs',
  'Suggest refactors that reduce complexity',
];

export default function Chat() {
  const { threadId } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const boot = useBootstrap();
  const projects = useProjects();
  const storeProject = useApp((s) => s.projectId);
  const thread = useThread(threadId);
  const t = thread.data;
  const projectId = threadId ? (t?.project_id ?? null) : storeProject;
  const project = projects.data?.find((p) => p.id === projectId);
  const agents = useChatAgents(projectId);
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const { live, connected, start } = useChatStream(threadId, t?.pendingApprovals);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  const agentList = agents.data ?? [];
  const requested = sp.get('agent');
  const agentId = threadId ? (t?.agent_id ?? DEFAULT_AGENT) : (pickedAgent ?? requested ?? DEFAULT_AGENT);
  const agentName = useMemo(() => agentList.find((a) => a.id === agentId)?.name ?? (agentId === DEFAULT_AGENT ? 'GitHub Copilot' : agentId.split('@')[0]), [agentList, agentId]);
  const busy = !!live && live.status === 'running';
  const noProvider = boot.data && boot.data.providerCount === 0;

  useEffect(() => { setPickedAgent(null); setText(''); stick.current = true; input.current?.focus(); }, [threadId]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [t?.messages.length, live?.text, live?.tools.length, live?.approvals.length, live?.reasoning]);

  const send = async (override?: string) => {
    const content = (override ?? text).trim();
    if (!content || sending || busy) return;
    setSending(true);
    try {
      let id = threadId;
      if (!id) {
        const created = await api<{ id: string }>('/api/chat/threads', { method: 'POST', body: { agentId, projectId: projectId ?? undefined } });
        id = created.id;
      }
      start();
      await api(`/api/chat/threads/${id}/messages`, { method: 'POST', body: { content } });
      setText('');
      stick.current = true;
      void qc.invalidateQueries({ queryKey: ['threads'] });
      if (threadId) await qc.refetchQueries({ queryKey: qk.thread(id) });
      else nav(`/chat/${id}`);
    } catch (e) {
      toast.error(errMsg(e));
      if (threadId) void qc.refetchQueries({ queryKey: qk.thread(threadId) });
    } finally { setSending(false); }
  };

  const stop = () => { if (threadId) void api(`/api/chat/threads/${threadId}/cancel`, { method: 'POST' }).catch((e) => toast.error(errMsg(e))); };

  const patch = async (body: Record<string, unknown>) => {
    if (!threadId) return;
    try { await api(`/api/chat/threads/${threadId}`, { method: 'PATCH', body }); await qc.refetchQueries({ queryKey: qk.thread(threadId) }); void qc.invalidateQueries({ queryKey: ['threads'] }); }
    catch (e) { toast.error(errMsg(e)); }
  };

  if (noProvider) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState icon={<KeyRound className="size-8" />} title="Connect a model provider to start chatting"
          description="Add an OpenAI, Anthropic, Azure or OpenAI-compatible provider and the default Copilot agent is ready to use."
          action={<Link to="/settings"><Button variant="primary">Open settings</Button></Link>} />
      </div>
    );
  }

  const messages = t?.messages ?? [];
  const showLive = !!live && (busy || live.status !== 'running');
  const empty = !threadId || (messages.length === 0 && !showLive);

  const header = (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{threadId ? (t?.title ?? '…') : 'New chat'}</div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <FolderOpen className="size-3" />{project ? <span title={project.path} className="truncate">{project.name}</span> : <span>No project</span>}
          {threadId && !connected && <Badge tone="warn">reconnecting</Badge>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Bot className="size-4 text-muted" />
        <Select aria-label="Agent" className="w-56" value={agentId} disabled={busy}
          onChange={(e) => (threadId ? void patch({ agentId: e.target.value }) : setPickedAgent(e.target.value))}>
          {!agentList.some((a) => a.id === DEFAULT_AGENT) && <option value={DEFAULT_AGENT}>GitHub Copilot</option>}
          {agentList.map((a) => <option key={a.id} value={a.id}>{a.name}{a.kind === 'project' ? ' (project)' : ''}</option>)}
          {!agentList.some((a) => a.id === agentId) && agentId !== DEFAULT_AGENT && <option value={agentId}>{agentName}</option>}
        </Select>
        {threadId && (
          <Select aria-label="Approval mode" className="w-36" title="How tool permissions are handled in this chat" value={t?.approval_mode ?? boot.data?.settings.approvals.chatMode ?? 'interactive'} disabled={busy}
            onChange={(e) => void patch({ approvalMode: e.target.value as ApprovalMode })}>
            <option value="interactive">Ask me</option>
            <option value="autopilot">Autopilot</option>
            <option value="strict">Read-only</option>
          </Select>
        )}
        <Link to="/agents/new" title="Create a custom agent"><IconButton label="Create agent"><Wand2 className="size-4" /></IconButton></Link>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {header}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {threadId && thread.isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
          {empty && !thread.isLoading && (
            <div className="flex flex-col items-center gap-6 py-16 text-center fade-in">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/15 text-accent"><Bot className="size-7" /></div>
              <div>
                <h1 className="text-xl font-semibold">Chat with {agentName}</h1>
                <p className="mt-1 text-sm text-muted">{project ? <>Working in <span className="font-mono">{project.path}</span></> : 'Select a project in the sidebar to give the agent access to your code.'}</p>
              </div>
              <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => <button key={s} onClick={() => void send(s)} className="rounded-xl border border-border bg-surface p-3 text-left text-sm text-muted transition hover:border-accent/50 hover:text-fg">{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m) => <MessageView key={m.id} m={m} agentLabel={agentName} />)}
          {showLive && live && (
            <AssistantBlock label={live.agentId ? (agentList.find((a) => a.id === live.agentId)?.name ?? agentName) : agentName} streaming={busy}
              a={{ text: live.text, reasoning: live.reasoning, tools: live.tools, model: live.model, usage: live.usage, status: live.status === 'running' ? undefined : live.status, error: live.error }}
              extra={live.approvals.length > 0 ? <div className="space-y-2">{live.approvals.map((a) => <ApprovalCard key={a.approvalId} a={a} hasProject={!!projectId} />)}</div> : undefined} />
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className={cn('mx-auto max-w-3xl rounded-2xl border border-border bg-surface p-2 shadow-sm transition focus-within:border-accent/60')}>
          <textarea ref={input} value={text} rows={1} aria-label="Message" placeholder={`Message ${agentName}…  (Enter to send, Shift+Enter for a new line)`}
            onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            className="max-h-56 w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted" />
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[11px] text-muted">{project ? project.name : 'No project'} · {agentName}</span>
            {busy
              ? <Button size="sm" variant="danger" onClick={stop}><Square className="size-3.5" />Stop</Button>
              : <Button size="sm" variant="primary" loading={sending} disabled={!text.trim()} onClick={() => void send()}><ArrowUp className="size-4" />Send</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
