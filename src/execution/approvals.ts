import type { PlatformStore } from '../store/platform.js';
import type { ChatHub } from './chat-hub.js';

export type ApprovalScope = 'once' | 'chat' | 'project';

interface Pending {
  threadId: string;
  runId: string | null;
  tool: string;
  projectId: string | null;
  resolve: (r: { allow: boolean; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

/**
 * Human-in-the-loop gate for chat turns. A request is persisted (audit), pushed to the browser over
 * the chat hub, and the SDK hook awaits the answer. Timeout / cancel / restart all resolve as DENY.
 */
export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  private chatGrants = new Map<string, Set<string>>();

  constructor(private readonly platform: PlatformStore, private readonly hub: ChatHub) {}

  private projectGrants(projectId: string | null): string[] {
    if (!projectId) return [];
    const s = this.platform.getProject(projectId)?.settings.approvedTools;
    return Array.isArray(s) ? (s as string[]) : [];
  }

  isPreApproved(threadId: string, projectId: string | null, tool: string): boolean {
    return !!this.chatGrants.get(threadId)?.has(tool) || this.projectGrants(projectId).includes(tool);
  }

  request(input: { threadId: string; runId: string | null; projectId: string | null; tool: string; args: unknown; source: string }): Promise<{ allow: boolean; reason?: string }> {
    const row = this.platform.createApproval({ threadId: input.threadId, runId: input.runId, tool: input.tool, args: input.args });
    if (this.isPreApproved(input.threadId, input.projectId, input.tool)) {
      this.platform.resolveApproval(row.id, 'approved', { scope: 'remembered', decidedBy: 'policy', reason: 'previously approved for this chat/project' });
      return Promise.resolve({ allow: true, reason: `'${input.tool}' remembered as approved` });
    }
    const timeoutSec = this.platform.getSettings().approvals.timeoutSec;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(row.id)) return;
        this.platform.resolveApproval(row.id, 'expired', { reason: 'no response before timeout' });
        this.hub.publish(input.threadId, { type: 'approval-resolved', approvalId: row.id, status: 'expired' });
        resolve({ allow: false, reason: `approval for '${input.tool}' timed out after ${timeoutSec}s — denied` });
      }, timeoutSec * 1000);
      timer.unref?.();
      this.pending.set(row.id, { threadId: input.threadId, runId: input.runId, tool: input.tool, projectId: input.projectId, resolve, timer });
      this.hub.publish(input.threadId, { type: 'approval-request', approvalId: row.id, tool: input.tool, args: input.args, source: input.source, timeoutSec });
    });
  }

  /** Returns false if the approval is unknown or already settled. */
  decide(id: string, allow: boolean, scope: ApprovalScope = 'once', decidedBy = 'user'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.platform.resolveApproval(id, allow ? 'approved' : 'denied', { scope, decidedBy });
    if (allow && scope === 'chat') {
      const set = this.chatGrants.get(p.threadId) ?? new Set<string>();
      set.add(p.tool);
      this.chatGrants.set(p.threadId, set);
    }
    if (allow && scope === 'project' && p.projectId) {
      const proj = this.platform.getProject(p.projectId);
      if (proj) {
        const cur = this.projectGrants(p.projectId);
        if (!cur.includes(p.tool)) this.platform.updateProject(p.projectId, { settings: { ...proj.settings, approvedTools: [...cur, p.tool] } });
      }
    }
    this.hub.publish(p.threadId, { type: 'approval-resolved', approvalId: id, status: allow ? 'approved' : 'denied', scope });
    p.resolve({ allow, reason: allow ? `approved by ${decidedBy} (${scope})` : `denied by ${decidedBy}` });
    return true;
  }

  /** Cancelling a turn (or deleting a thread) denies everything it is still waiting on. */
  cancelThread(threadId: string, reason = 'turn cancelled'): number {
    let n = 0;
    for (const [id, p] of [...this.pending]) {
      if (p.threadId !== threadId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      this.platform.resolveApproval(id, 'denied', { decidedBy: 'system', reason });
      this.hub.publish(threadId, { type: 'approval-resolved', approvalId: id, status: 'denied' });
      p.resolve({ allow: false, reason });
      n++;
    }
    return n;
  }

  pendingFor(threadId: string): string[] {
    return [...this.pending].filter(([, p]) => p.threadId === threadId).map(([id]) => id);
  }
}
