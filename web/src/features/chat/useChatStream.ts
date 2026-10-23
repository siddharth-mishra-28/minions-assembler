import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/queries';
import type { Approval, ChatEvent, ToolCall } from '@/lib/types';

export interface PendingApproval { approvalId: string; tool: string; args: unknown; source: string; timeoutSec: number; requestedAt: number }
export interface LiveTurn {
  runId?: string; agentId?: string; model?: string;
  text: string; reasoning: string; tools: ToolCall[]; approvals: PendingApproval[];
  usage?: { tokensIn?: number; tokensOut?: number };
  status: 'running' | 'error' | 'cancelled'; error?: string;
}

const fresh = (): LiveTurn => ({ text: '', reasoning: '', tools: [], approvals: [], status: 'running' });

/** Subscribes to a thread's SSE stream and folds events into the in-flight turn; persisted messages come from the thread query. */
export function useChatStream(threadId: string | undefined, seedApprovals: Approval[] = []) {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [connected, setConnected] = useState(false);
  const seeded = useRef<string>('');

  const finish = useCallback((id: string, patch?: Partial<LiveTurn>) => {
    if (patch) setLive((l) => (l ? { ...l, ...patch, approvals: [] } : l));
    void Promise.all([qc.refetchQueries({ queryKey: qk.thread(id) }), qc.invalidateQueries({ queryKey: ['threads'] })]).then(() => { if (!patch) setLive(null); });
  }, [qc]);

  useEffect(() => {
    setLive(null); setConnected(false); seeded.current = '';
    if (!threadId) return;
    const es = new EventSource(`/api/chat/threads/${threadId}/events`);
    const on = (type: ChatEvent['type']) => es.addEventListener(type, (m) => handle(JSON.parse((m as MessageEvent).data) as ChatEvent));
    const upd = (fn: (l: LiveTurn) => LiveTurn) => setLive((l) => fn(l ?? fresh()));
    const handle = (e: ChatEvent) => {
      switch (e.type) {
        case 'turn-start': setLive({ ...fresh(), runId: e.runId, agentId: e.agentId, model: e.model }); void qc.invalidateQueries({ queryKey: ['threads'] }); break;
        case 'delta': upd((l) => ({ ...l, text: l.text + e.text })); break;
        case 'reasoning': upd((l) => ({ ...l, reasoning: l.reasoning + e.delta })); break;
        case 'tool-start': upd((l) => ({ ...l, tools: [...l.tools.filter((t) => t.callId !== e.callId), { callId: e.callId, name: e.name, args: e.args }] })); break;
        case 'tool-complete': upd((l) => ({ ...l, tools: l.tools.map((t) => (t.callId === e.callId ? { ...t, result: e.result, success: e.success, done: true } : t)) })); break;
        case 'approval-request': upd((l) => ({ ...l, approvals: l.approvals.some((a) => a.approvalId === e.approvalId) ? l.approvals : [...l.approvals, { approvalId: e.approvalId, tool: e.tool, args: e.args, source: e.source, timeoutSec: e.timeoutSec, requestedAt: Date.now() }] })); break;
        case 'approval-resolved': upd((l) => ({ ...l, approvals: l.approvals.filter((a) => a.approvalId !== e.approvalId) })); break;
        case 'usage': upd((l) => ({ ...l, usage: { tokensIn: e.tokensIn ?? l.usage?.tokensIn, tokensOut: e.tokensOut ?? l.usage?.tokensOut } })); break;
        case 'done': finish(threadId); break;
        case 'error': finish(threadId, { status: 'error', error: e.message }); break;
        case 'cancelled': finish(threadId, { status: 'cancelled' }); break;
      }
    };
    (['turn-start', 'delta', 'reasoning', 'tool-start', 'tool-complete', 'approval-request', 'approval-resolved', 'usage', 'done', 'error', 'cancelled'] as const).forEach(on);
    es.addEventListener('ready', (m) => {
      setConnected(true);
      const r = JSON.parse((m as MessageEvent).data) as { busy: boolean };
      if (r.busy) setLive((l) => l ?? fresh());
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [threadId, qc, finish]);

  // Approvals pending at page load (before/without SSE replay).
  useEffect(() => {
    const key = `${threadId}:${seedApprovals.map((a) => a.id).join(',')}`;
    if (!seedApprovals.length || seeded.current === key) return;
    seeded.current = key;
    setLive((l) => {
      const base = l ?? fresh();
      const add = seedApprovals.filter((a) => !base.approvals.some((x) => x.approvalId === a.id))
        .map((a) => ({ approvalId: a.id, tool: a.tool, args: a.args, source: 'chat', timeoutSec: 120, requestedAt: new Date(a.requestedAt.endsWith('Z') ? a.requestedAt : a.requestedAt + 'Z').getTime() }));
      return { ...base, approvals: [...base.approvals, ...add] };
    });
  }, [seedApprovals, threadId]);

  const start = useCallback(() => setLive(fresh()), []);
  return { live, connected, start, clear: () => setLive(null) };
}
