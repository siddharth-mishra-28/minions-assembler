import { CopilotClient } from '@github/copilot-sdk';
import { toSessionOptions, resolveApiKey } from '../agents/translator.js';
import { resolveBuiltinTools } from '../agents/tools-policy.js';
import { expandMcpRefs } from '../mcp/mcp.js';
import type { McpServerConfig } from '../mcp/mcp.js';
import { compilePermissionHandlers } from '../agents/permissions.js';
import { AuditLog, newTraceId } from '../core/audit.js';
import { redactedForLog } from '../agents/loader.js';
import { resolveChatWorkspace } from '../core/workspace.js';
import { mkdirSync } from 'node:fs';
import { buildHarnessTools, autoMkdirPreTool, harnessEnabled, resolveTurnTimeoutMs } from '../agents/harness-tools.js';
import { joinRunRoot } from './runner.js';
import type { AgentDefinition } from '../core/types.js';
import type { DbAdapter } from '../store/adapter.js';

export interface ChatTurnOptions {
  definition: AgentDefinition;
  agentId: string;
  db: DbAdapter;
  /** Persistent chat session id — MUST stay stable across turns for conversation memory. */
  sessionId?: string;
  sessionIdPrefix?: string;
  /** The user's message for this turn. */
  content: string;
  /**
   * Absolute fallback session root (per-thread folder). Agents that declare
   * `knowledge.workingDirectory` operate in that workspace instead (README 4.2).
   */
  workingDirectory: string;
  /** MCP registry: server configs keyed by name (+ discovered tool names). */
  mcpRegistry?: Map<string, McpServerConfig>;
  mcpRegistryTools?: Map<string, string[]>;
  turnTimeoutMs?: number;
  /** Streaming deltas as they arrive (SSE → browser). */
  onDelta?: (text: string) => void;
  /** Model reasoning/tool activity as it happens — feeds live chat UI (Thinking section). */
  onActivity?: (update: ActivityUpdate) => void;
}

export type ActivityUpdate =
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-start'; callId: string; name: string; args?: unknown }
  | { type: 'tool-complete'; callId: string; name: string; result?: string; success?: boolean };

/** Model's extended-thinking text accumulated during one chat turn. */
export interface ToolActivity { callId: string; name: string; args?: unknown; result?: string; success?: boolean }
export interface ChatTurnResult { runId: string; sessionId: string; traceId: string; text: string; reasoning: string; tools: ToolActivity[] }

/**
 * One chat turn against an agent definition:
 * creates a fresh runner session keyed by the SAME persistent chat sessionId (resume)
 * so all turns in a thread share conversation history with the model, streaming deltas
 * to the caller while the model replies. Re-permissions through the definition policy.
 */
export async function executeChatTurn(opts: ChatTurnOptions): Promise<ChatTurnResult> {
  const { definition: def } = opts;
  const apiKey = resolveApiKey(def);
  const traceId = newTraceId();
  const sessionId = opts.sessionId ?? `${opts.sessionIdPrefix ?? 'chat'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  void traceId;
  // README 4.2: the definition's workspace (wizard "Agent Workspace" step) is where
  // the agent reads/writes files and is the tool-confinement root. The per-thread
  // folder only applies to agents without a declared workspace.
  const workspaceRoot = resolveChatWorkspace(def, opts.workingDirectory);
  mkdirSync(workspaceRoot, { recursive: true });
  const runId = opts.db.createRun(opts.agentId, sessionId, traceId, def.provider.model, def.provider.type, opts.content, 'chat');
  // Per-turn run_<id> folder (joinRunRoot) for the run's audit log.
  const runRoot = joinRunRoot(workspaceRoot, runId);
  mkdirSync(runRoot, { recursive: true });
  const sessionCwd = workspaceRoot;
  const audit = new AuditLog(`${runRoot}/.audit`);
  constRankPersist(audit, opts.db, runId, {
    traceId, sessionId, agentId: opts.agentId, taskPrompt: opts.content.slice(0, 200),
    workspace: sessionCwd, runRoot, chat: true, definition: redactedForLog(def),
  });

  const client = new CopilotClient({
    onListModels: () => [{ id: def.provider.model, name: def.provider.model, capabilities: { supports: { vision: false, reasoningEffort: false } }, limits: { max_context_window_tokens: 128000 } } as never],
  });
  await client.start();
  try {
    const sessionOpts = toSessionOptions(def, apiKey);
    // Absolute working dir (the SDK resolves relative paths against its own cwd).
    // The definition's declared workspace wins so artifacts (app files, sites) land
    // where the wizard promised; otherwise the per-thread folder isolates the chat.
    (sessionOpts as Record<string, unknown>).workingDirectory = sessionCwd;
    const harnessTools = harnessEnabled(def)
      ? buildHarnessTools({ workspaceRoot: sessionCwd })
      : [];
    if (harnessTools.length) {
      const existing = (sessionOpts as { tools?: unknown[] }).tools ?? [];
      const names = new Set(harnessTools.map((t) => t.name));
      (sessionOpts as Record<string, unknown>).tools = [...harnessTools, ...existing.filter((t) => !names.has((t as { name?: string }).name ?? ''))];
    }
    if (def.mcp?.use?.length && opts.mcpRegistry) {
      const { servers, disabled } = expandMcpRefs(def.mcp.servers, def.mcp.use, opts.mcpRegistry, opts.mcpRegistryTools ?? new Map());
      (sessionOpts as Record<string, unknown>).mcpServers = { ...((sessionOpts.mcpServers as Record<string, unknown>) ?? {}), ...servers };
      (sessionOpts as Record<string, unknown>).disabledMcpServers = [...((sessionOpts.disabledMcpServers as string[]) ?? []), ...disabled];
    }
    (sessionOpts as Record<string, unknown>).sessionId = sessionId;
    const { onPermissionRequest, onPreToolUse } = compilePermissionHandlers(def, { ciApproveAll: false, harnessTools: harnessEnabled(def) }, {
      onAskDeferred: (info) => persistChatEvent(audit, opts.db, runId, 'permission.ask_denied', { ...info, reason: "'ask' denied in chat headless mode" }),
      onDestructiveDeny: (info) => persistChatEvent(audit, opts.db, runId, 'permission.destructive_denied', info),
    });
    (sessionOpts as Record<string, unknown>).onPermissionRequest = onPermissionRequest;
    const autoMkdir = autoMkdirPreTool(sessionCwd);
    (sessionOpts as Record<string, unknown>).hooks = {
      onPreToolUse: async (input: { toolName?: string; tool?: string; toolArgs?: unknown }) => {
        const decision = (await onPreToolUse(input)) as { permissionDecision?: string; additionalContext?: string } | undefined;
        if (decision?.permissionDecision === 'deny') return decision;
        const mkdirResult = harnessEnabled(def) ? (await autoMkdir(input)) as { permissionDecision?: string; additionalContext?: string } | undefined : undefined;
        if (mkdirResult?.permissionDecision === 'deny') return mkdirResult;
        if (mkdirResult?.additionalContext) return { ...decision, additionalContext: decision?.additionalContext ? `${decision.additionalContext}\n${mkdirResult.additionalContext}` : mkdirResult.additionalContext };
        return decision;
      },
    };

    let session: Awaited<ReturnType<CopilotClient['createSession']>>;
    try {
      session = await client.resumeSession(sessionId, sessionOpts);
      persistChatEvent(audit, opts.db, runId, 'session.resume', { sessionId });
    } catch {
      session = await client.createSession(sessionOpts as never);
      persistChatEvent(audit, opts.db, runId, 'session.create', { sessionId });
    }
    try { opts.db.upsertSession({ sessionId, runId, agentId: opts.agentId, traceId, status: 'created' }); } catch { /* best-effort */ }

    session.on('assistant.message_delta', (e: unknown) => {
      const text = extractDelta(e);
      if (text && opts.onDelta) opts.onDelta(text);
    });
    // Extended thinking: stream deltas live (browser Thinking section), keep the
    // full text; `assistant.reasoning` (complete block) is only folded in when its
    // reasoningId was NOT already delivered via deltas (avoids duplication).
    const reasoningSeenIds = new Set<string>();
    let reasoning = '';
    const tools: ToolActivity[] = [];
    const pushReasoning = (delta: string): void => {
      if (!delta) return;
      reasoning += delta;
      opts.onActivity?.({ type: 'reasoning', delta });
    };
    session.on('assistant.reasoning_delta', (e: unknown) => {
      const d = (e as { data?: { deltaContent?: string; reasoningId?: string } }).data;
      if (d?.reasoningId) reasoningSeenIds.add(d.reasoningId);
      pushReasoning(d?.deltaContent ?? '');
    });
    session.on('assistant.reasoning', (e: unknown) => {
      const d = (e as { data?: { content?: string; reasoningId?: string } }).data;
      if (!d?.content) return;
      if (d.reasoningId && reasoningSeenIds.has(d.reasoningId)) return;
      // A block we already streamed (anonymous complete event retried) would start with the same text.
      if (!d.reasoningId && reasoning && d.content.startsWith(reasoning.slice(0, 200))) return;
      pushReasoning(d.content);
    });

    session.on('tool.execution_start', (e: unknown) => {
      persistChatEvent(audit, opts.db, runId, 'tool.call', sanitizeEvent(e));
      const d = (e as { data?: { toolName?: string; toolCallId?: string; arguments?: unknown } }).data;
      if (d?.toolName) {
        const act: ToolActivity = { callId: d.toolCallId ?? '', name: d.toolName, args: d.arguments, result: '', success: undefined };
        tools.push(act);
        opts.onActivity?.({ type: 'tool-start', callId: act.callId, name: act.name, args: act.args });
      }
    });
    session.on('tool.execution_complete', (e: unknown) => {
      persistChatEvent(audit, opts.db, runId, 'tool.result', sanitizeEvent(e));
      const d = (e as { data?: { toolName?: string; toolCallId?: string; success?: boolean; result?: { content?: string; detailedContent?: string } } }).data;
      if (d?.toolCallId) {
        const act = tools.find((t) => t.callId === d.toolCallId) ?? { callId: d.toolCallId, name: d.toolName ?? '', args: undefined, result: '', success: undefined };
        const text = d.result?.content ?? d.result?.detailedContent ?? '';
        const existing = tools.indexOf(act);
        if (existing >= 0) { tools[existing] = { ...act, result: text, success: d.success }; }
        else tools.push({ ...act, result: text, success: d.success });
        opts.onActivity?.({ type: 'tool-complete', callId: d.toolCallId, name: d.toolName ?? act.name, result: text, success: d.success });
      }
    });
    session.on('session.error', (e: unknown) => persistChatEvent(audit, opts.db, runId, 'session.error', sanitizeEvent(e)));

    const turnTimeoutMs = opts.turnTimeoutMs ?? resolveTurnTimeoutMs(def, undefined);
    persistChatEvent(audit, opts.db, runId, 'chat.send', { content: opts.content.slice(0, 2000), mode: 'resume' });
    const response = (await (session as { sendAndWait: (a: unknown, t?: number) => Promise<unknown> }).sendAndWait({ prompt: opts.content, mode: 'resume' }, turnTimeoutMs)) as { data?: { content?: string }; content?: string; text?: string };
    const text = response?.data?.content ?? response?.content ?? response?.text ?? '';
    // Persist the turn's reasoning for transcript reloads (collapsed section on the bubble).
    if (reasoning) persistChatEvent(audit, opts.db, runId, 'chat.reasoning', { content: reasoning });
    persistChatEvent(audit, opts.db, runId, 'chat.reply', { chars: text.length });
    opts.db.finishRun(runId, 'done');
    try { opts.db.upsertSession({ sessionId, status: 'idle-done', summary: text.slice(0, 200) }); } catch { /* best-effort */ }
    try { await (session as { disconnect?: () => Promise<void> }).disconnect?.(); } catch { /* noop */ }
    await client.stop();
    return { runId, sessionId, traceId, text, reasoning, tools };
  } catch (err) {
    const message = (err as Error).message;
    persistChatEvent(audit, opts.db, runId, 'chat.error', { error: message });
    opts.db.finishRun(runId, 'failed', message);
    try { await client.stop(); } catch { /* noop */ }
    throw err;
  }
}

function persistChatEvent(audit: AuditLog, db: DbAdapter, runId: string, type: string, payload: Record<string, unknown>, persisted = true): void {
  const ev = audit.append(type, payload, persisted);
  try { db.appendEvent(runId, ev.seq, type, JSON.stringify(ev.payload), persisted); } catch { /* db best-effort */ }
}

function constRankPersist(audit: AuditLog, db: DbAdapter, runId: string, payload: Record<string, unknown>): void {
  persistChatEvent(audit, db, runId, 'chat.turn_start', payload);
}

function extractDelta(e: unknown): string {
  const o = e as { delta?: string; deltaContent?: string; content?: string; data?: { delta?: string; deltaContent?: string; content?: string; text?: string } };
  return o?.delta ?? o?.deltaContent ?? o?.content ?? o?.data?.delta ?? o?.data?.deltaContent ?? o?.data?.content ?? o?.data?.text ?? '';
}

function sanitizeEvent(e: unknown): Record<string, unknown> {
  try { return JSON.parse(JSON.stringify(e)) as Record<string, unknown>; } catch { return { unserializable: true }; }
}
