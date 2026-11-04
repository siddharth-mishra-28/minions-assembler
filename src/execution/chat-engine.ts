import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DbAdapter } from '../store/adapter.js';
import type { PlatformStore, ProjectRow } from '../store/platform.js';
import type { AgentDefinition } from '../core/types.js';
import type { McpServerConfig } from '../mcp/mcp.js';
import { executeChatTurn, TurnAborted, type ToolActivity } from './chat-runner.js';
import type { ChatHub } from './chat-hub.js';
import type { ApprovalBroker } from './approvals.js';
import {
  DEFAULT_AGENT_ID, PROJECT_AGENT_PREFIX, buildDefaultAgent, buildProjectAgent, resolveProviderRef,
} from '../agents/default-agent.js';
import type { ApprovalMode } from '../agents/permissions.js';
import { hydrateAgentDefinition } from '../agents/loader.js';
import { resolveMemoryConfig } from '../memory/config.js';
import { createMemoryRuntime } from '../memory/runtime.js';
import type { MemoryStore } from '../memory/store.js';

export class ChatEngineError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'ChatEngineError'; }
}

class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => { if (released) return; released = true; this.active--; this.waiters.shift()?.(); };
  }
}

interface ActiveTurn { abort: AbortController; runId?: string; startedAt: number }

export interface ChatEngineDeps {
  db: DbAdapter;
  platform: PlatformStore;
  hub: ChatHub;
  broker: ApprovalBroker;
  /** Per-thread scratch folder root for threads without a project (`<workspace>/.chats/<threadId>`). */
  workspaceRoot: string;
  /** Audit logs live here (outside project folders): `<auditRoot>/<runId>`. */
  auditRoot: string;
  mcpRegistry: () => { registry: Map<string, McpServerConfig>; tools: Map<string, string[]> };
  /** Long-term memory store; when present every chat turn recalls and captures. */
  memoryStore?: MemoryStore;
  maxConcurrent?: number;
}

/**
 * Runs chat turns in the background and reports progress through the ChatHub, so the HTTP
 * request that starts a turn returns immediately (202) and the browser follows along over SSE.
 * One turn per thread at a time; a global cap bounds concurrent SDK sessions.
 */
export class ChatEngine {
  private active = new Map<string, ActiveTurn>();
  private readonly sem: Semaphore;

  constructor(private readonly d: ChatEngineDeps) {
    this.sem = new Semaphore(d.maxConcurrent ?? Number(process.env.MINION_CHAT_CONCURRENCY ?? 3));
  }

  isBusy(threadId: string): boolean { return this.active.has(threadId); }
  busyThreads(): string[] { return [...this.active.keys()]; }

  threadDir(threadId: string): string { return resolve(join(this.d.workspaceRoot, '.chats', threadId)); }

  /** Build the concrete definition for a thread's selected agent (default, project profile, or registered). */
  resolveAgent(thread: Record<string, unknown>): { def: AgentDefinition; agentId: string; project?: ProjectRow; snapshot?: string } {
    const { platform, db } = this.d;
    const projectId = (thread.project_id as string | null) ?? null;
    const project = projectId ? platform.getProject(projectId) : undefined;
    if (projectId && !project) throw new ChatEngineError('The project for this chat no longer exists. Re-open the folder or start a new chat.', 409);
    const modelOverride = (thread.model_override as string | null) ?? null;
    const agentId = (thread.agent_id as string | null) || DEFAULT_AGENT_ID;
    const settings = platform.getSettings();

    const needProvider = () => {
      const p = platform.getDefaultProvider();
      if (!p) throw new ChatEngineError('No model provider is configured yet. Add one in Settings → Providers.', 412);
      if (!p.hasKey) throw new ChatEngineError(`Provider "${p.name}" has no API key. Add one in Settings → Providers.`, 412);
      return p;
    };

    if (agentId === DEFAULT_AGENT_ID) {
      const p = needProvider();
      const base = buildDefaultAgent(p, { projectPath: project?.path, model: modelOverride || settings.defaults.model, systemPrompt: settings.defaults.systemPrompt });
      return { def: this.finish(base, modelOverride), agentId, project };
    }
    if (agentId.startsWith(PROJECT_AGENT_PREFIX)) {
      const rest = agentId.slice(PROJECT_AGENT_PREFIX.length);
      const sep = rest.indexOf(':');
      const pid = rest.slice(0, sep);
      const file = rest.slice(sep + 1);
      const proj = platform.getProject(pid);
      if (!proj) throw new ChatEngineError('Project agent belongs to a project that no longer exists.', 404);
      const p = needProvider();
      try {
        return { def: this.finish(buildProjectAgent(proj, file, p, modelOverride), modelOverride), agentId, project: proj };
      } catch (e) {
        throw new ChatEngineError(`Cannot load project agent: ${(e as Error).message}`, 400);
      }
    }
    const row = db.getAgent(agentId);
    if (!row) throw new ChatEngineError(`agent not found: ${agentId}`, 404);
    let def: AgentDefinition;
    try {
      def = hydrateAgentDefinition(row.definition_json as string).resolved;
    } catch (e) {
      throw new ChatEngineError(`agent ${agentId} has an invalid definition: ${(e as Error).message}`, 400);
    }
    return { def: this.finish(def, modelOverride), agentId, project, snapshot: row.definition_json as string };
  }

  private finish(def: AgentDefinition, modelOverride: string | null): AgentDefinition {
    try { return resolveProviderRef(def, this.d.platform, modelOverride); } catch (e) {
      throw new ChatEngineError((e as Error).message, 412);
    }
  }

  /**
   * Persist the user message, then run the turn in the background.
   * Resolves as soon as the turn is accepted; everything after that is reported through the hub.
   */
  start(threadId: string, content: string, opts: { agentId?: string } = {}): { userMessageId: number; agentId: string; model: string } {
    const { db, hub } = this.d;
    const thread = db.getChatThread(threadId);
    if (!thread) throw new ChatEngineError(`chat thread not found: ${threadId}`, 404);
    if (this.active.has(threadId)) throw new ChatEngineError('This chat is still working on the previous message. Wait for it or press Stop.', 409);
    const { def, agentId, project, snapshot } = this.resolveAgent(opts.agentId ? { ...thread, agent_id: opts.agentId } : thread);

    const userMessageId = db.addChatMessage(threadId, { role: 'user', author: 'user', content });
    const firstTitle = /^(New chat|Chat with .*)$/.test(String(thread.title ?? ''));
    if (firstTitle) db.updateChatThread(threadId, { title: content.replace(/\s+/g, ' ').slice(0, 60) });

    const turn: ActiveTurn = { abort: new AbortController(), startedAt: Date.now() };
    this.active.set(threadId, turn);
    hub.publish(threadId, { type: 'turn-start', runId: '', agentId, model: def.provider.model });
    void this.run(threadId, content, def, agentId, project, turn, snapshot);
    return { userMessageId, agentId, model: def.provider.model };
  }

  cancel(threadId: string): boolean {
    const turn = this.active.get(threadId);
    if (!turn) return false;
    turn.abort.abort();
    this.d.broker.cancelThread(threadId, 'turn cancelled by user');
    return true;
  }

  private async run(threadId: string, content: string, def: AgentDefinition, agentId: string, project: ProjectRow | undefined, turn: ActiveTurn, snapshot?: string): Promise<void> {
    const { db, hub, platform, broker } = this.d;
    const thread = db.getChatThread(threadId)!;
    const mode = ((thread.approval_mode as string | null) || platform.getSettings().approvals.chatMode) as ApprovalMode;
    let text = '';
    let reasoning = '';
    const tools = new Map<string, ToolActivity>();
    let usage: { tokensIn: number; tokensOut: number } | undefined;

    // Coalesce token deltas so the SSE stream and replay buffer stay small.
    let pending = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = (): void => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      if (pending) { hub.publish(threadId, { type: 'delta', text: pending }); pending = ''; }
    };

    const release = await this.sem.acquire();
    try {
      if (turn.abort.signal.aborted) throw new TurnAborted('');
      const { registry, tools: mcpTools } = this.d.mcpRegistry();
      const workingDirectory = project ? project.path : this.threadDir(threadId);
      if (!project) mkdirSync(workingDirectory, { recursive: true });
      const memory = this.d.memoryStore
        ? (() => {
            const config = resolveMemoryConfig(this.d.memoryStore!, def);
            return config.enabled
              ? createMemoryRuntime({ store: this.d.memoryStore!, config, definition: def, agentId, task: content, threadId })
              : undefined;
          })()
        : undefined;
      const result = await executeChatTurn({
        definition: def, agentId, db,
        definitionSnapshot: snapshot,
        sessionId: (thread.session_id as string | null) ?? undefined,
        sessionIdPrefix: 'chat',
        content,
        workingDirectory,
        projectBound: !!project,
        projectId: project?.id,
        threadId,
        auditRoot: this.d.auditRoot,
        approvalMode: mode,
        signal: turn.abort.signal,
        mcpRegistry: registry, mcpRegistryTools: mcpTools,
        memory,
        requestApproval: (info) => {
          turn.runId = info.runId;
          return broker.request({ threadId, runId: info.runId, projectId: project?.id ?? null, tool: info.tool, args: info.args, source: info.source });
        },
        onDelta: (d) => {
          text += d; pending += d;
          if (!flushTimer) flushTimer = setTimeout(flush, 40);
        },
        onActivity: (u) => {
          if (u.type === 'reasoning') { reasoning += u.delta; hub.publish(threadId, { type: 'reasoning', delta: u.delta }); }
          else if (u.type === 'tool-start') { flush(); tools.set(u.callId, { callId: u.callId, name: u.name, args: u.args }); hub.publish(threadId, u); }
          else if (u.type === 'tool-complete') { flush(); tools.set(u.callId, { ...(tools.get(u.callId) ?? { callId: u.callId, name: u.name }), result: u.result, success: u.success }); hub.publish(threadId, u); }
          else if (u.type === 'usage') { usage = { tokensIn: u.tokensIn, tokensOut: u.tokensOut }; hub.publish(threadId, { type: 'usage', tokensIn: u.tokensIn, tokensOut: u.tokensOut }); }
        },
      });
      flush();
      const finalText = text || result.text;
      db.updateChatThread(threadId, { sessionId: result.sessionId });
      const messageId = db.addChatMessage(threadId, {
        role: 'assistant', author: agentId, content: finalText, runId: result.runId,
        meta: { model: def.provider.model, reasoning: reasoning || result.reasoning, tools: [...tools.values()], usage, status: 'done' },
      });
      hub.publish(threadId, { type: 'done', runId: result.runId, messageId, text: finalText });
    } catch (err) {
      flush();
      const cancelled = err instanceof TurnAborted || turn.abort.signal.aborted;
      const runId = err instanceof TurnAborted ? err.runId || turn.runId : turn.runId;
      const message = cancelled ? 'Stopped by user' : (err as Error).message;
      db.addChatMessage(threadId, {
        role: 'assistant', author: agentId, content: text, runId: runId ?? null,
        meta: { model: def.provider.model, reasoning, tools: [...tools.values()], usage, status: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : message },
      });
      hub.publish(threadId, cancelled ? { type: 'cancelled', runId } : { type: 'error', runId, message });
    } finally {
      release();
      this.active.delete(threadId);
      broker.cancelThread(threadId, 'turn ended');
      const t = setTimeout(() => { if (!this.active.has(threadId)) hub.clear(threadId); }, 60_000);
      t.unref?.();
    }
  }
}
