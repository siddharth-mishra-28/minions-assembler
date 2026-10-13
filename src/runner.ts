import { CopilotClient } from '@github/copilot-sdk';
import { toSessionOptions, toSendArgs, resolveApiKey } from './translator.js';
import { expandMcpRefs } from './mcp.js';
import type { McpServerConfig } from './mcp.js';
import { compilePermissionHandlers } from './permissions.js';
import { AuditLog, newTraceId } from './audit.js';
import { redactedForLog } from './loader.js';
import { resolveWorkspace } from './workspace.js';
import type { AgentDefinition } from './types.js';
import type { DbAdapter } from './store/adapter.js';

export type AuditLevel = 'minimal' | 'default' | 'full';

const AUDIT_RANK: Record<AuditLevel, number> = { minimal: 0, default: 1, full: 2 };

/** Resolve audit verbosity: explicit option > AUDIT_LEVEL env > 'default'. */
export function resolveAuditLevel(want?: AuditLevel): AuditLevel {
  const raw = want ?? (process.env.AUDIT_LEVEL as AuditLevel | undefined) ?? 'default';
  if (raw !== 'minimal' && raw !== 'default' && raw !== 'full') {
    throw new Error(`invalid audit level '${String(raw)}' (expected minimal|default|full via AUDIT_LEVEL)`);
  }
  return raw;
}

export interface RunOptions {
  definition: AgentDefinition;
  agentId: string;
  definitionHash: string;
  db: DbAdapter;
  /** Explicit override for the run-transcript directory (rare; workspace is auto-resolved otherwise). */
  runDir?: string;
  taskOverride?: string;
  ciApproveAll?: boolean;
  streamOut?: (text: string) => void;
  resumeSessionId?: string;
  /** Audit verbosity for this run; falls back to AUDIT_LEVEL env, then 'default'. */
  auditLevel?: AuditLevel;
  /** Registry servers available for mcp.use expansion: name -> full config. */
  mcpRegistry?: Map<string, McpServerConfig>;
  /** Discovered tool names per registry server (for allow/deny filtering). */
  mcpRegistryTools?: Map<string, string[]>;
}

export async function executeRun(opts: RunOptions): Promise<{ runId: string; sessionId: string; traceId: string; text: string }> {
  const { definition: def } = opts;
  const apiKey = resolveApiKey(def);
  const traceId = newTraceId();
  const workspace = resolveWorkspace(def.knowledge?.workingDirectory);
  const sessionId = opts.resumeSessionId ?? def.runtime?.sessionId ?? `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const runId = opts.db.createRun(opts.agentId, sessionId, traceId, def.provider.model, def.provider.type, opts.taskOverride ?? def.task.prompt, opts.definitionHash);
  const auditLevel = resolveAuditLevel(opts.auditLevel);
  const rank = AUDIT_RANK[auditLevel];
  const audit = new AuditLog(opts.runDir ?? `${workspace.root}/runs/${runId}`);
  /**
   * Persist an audit event if its minimum verbosity rank fits the configured level.
   * Levels: minimal(0) — lifecycle only; default(1) — + tool calls/results + permission decisions + usage; full(2) — + reasoning, partial results, progress, raw deltas.
   */
  const persist = (type: string, payload: Record<string, unknown>, persisted = true, minLevel = AUDIT_RANK.default) => {
    if (rank < minLevel) return undefined;
    const ev = audit.append(type, payload, persisted);
    try { opts.db.appendEvent(runId, ev.seq, type, JSON.stringify(ev.payload), persisted); } catch { /* db best-effort */ }
    return ev;
  };

  persist('run.start', { traceId, sessionId, agentId: opts.agentId, auditLevel, definition: redactedForLog(def), workspace: { root: workspace.root, source: workspace.source } }, true, AUDIT_RANK.minimal);
  const client = new CopilotClient({
    onListModels: () => [{ id: def.provider.model, name: def.provider.model, capabilities: { supports: { vision: false, reasoningEffort: false } }, limits: { max_context_window_tokens: 128000 } } as never],
  });
  await client.start();
  try {
    const sessionOpts = toSessionOptions(def, apiKey);
    // The SDK resolves a relative workingDirectory against its own process cwd (the project
    // root), which would let the agent write outside the agent workspace. Always pass the
    // absolutely-resolved workspace root instead of the raw definition value.
    (sessionOpts as Record<string, unknown>).workingDirectory = workspace.root;
    // Merge MCP registry references (mcp.use) into concrete session server configs
    if (def.mcp?.use?.length && opts.mcpRegistry) {
      const { servers, disabled } = expandMcpRefs(def.mcp.servers, def.mcp.use, opts.mcpRegistry, opts.mcpRegistryTools ?? new Map());
      (sessionOpts as Record<string, unknown>).mcpServers = { ...((sessionOpts.mcpServers as Record<string, unknown>) ?? {}), ...servers };
      (sessionOpts as Record<string, unknown>).disabledMcpServers = [...((sessionOpts.disabledMcpServers as string[]) ?? []), ...disabled];
      persist('mcp.expand', { refs: def.mcp.use, servers: Object.keys(servers), disabled });
    } else if (def.mcp?.use?.length) {
      // Refs present but no registry supplied (e.g. programmatic use) — fail loudly rather than silently dropping tools
      throw new Error('Definition uses mcp.use but no MCP registry was provided to the runner');
    }
    (sessionOpts as Record<string, unknown>).sessionId = sessionId;
    const { onPermissionRequest, onPreToolUse } = compilePermissionHandlers(def, { ciApproveAll: opts.ciApproveAll ?? false });
    (sessionOpts as Record<string, unknown>).onPermissionRequest = onPermissionRequest;
    (sessionOpts as Record<string, unknown>).hooks = { onPreToolUse };

    let session: Awaited<ReturnType<CopilotClient['createSession']>>;
    if (def.runtime?.resume || opts.resumeSessionId) {
      try {
        session = await client.resumeSession(sessionId, sessionOpts);
        persist('session.resume', { sessionId }, true, AUDIT_RANK.minimal);
        try { opts.db.upsertSession({ sessionId, status: 'resumed' }); } catch { /* best-effort */ }
      } catch {
        session = await client.createSession(sessionOpts as never);
        persist('session.create', { sessionId, resumed: false }, true, AUDIT_RANK.minimal);
      }
    } else {
      session = await client.createSession(sessionOpts as never);
      persist('session.create', { sessionId }, true, AUDIT_RANK.minimal);
    }
    try { opts.db.upsertSession({ sessionId, runId, agentId: opts.agentId, traceId, status: 'created' }); } catch { /* best-effort */ }

    const started = Date.now();
    // --- Audit event capture -------------------------------------------------
    // Tool calls (which tool, what arguments) — visible from 'default'
    session.on('tool.execution_start', (e: unknown) => {
      const ev = e as { id?: string; agentId?: string; data?: Record<string, unknown> };
      persist('tool.call', { eventId: ev.id, subAgent: ev.agentId, data: safe(ev.data) }, true, AUDIT_RANK.default);
    });
    // Tool results (full output incl. text/structured content, success flag) — visible from 'default'
    session.on('tool.execution_complete', (e: unknown) => {
      const ev = e as { id?: string; agentId?: string; data?: Record<string, unknown> };
      persist('tool.result', { eventId: ev.id, subAgent: ev.agentId, data: safe(ev.data) }, true, AUDIT_RANK.default);
    });
    // Partial results / progress flashes — full verbosity only (ephemeral in the SDK)
    session.on('tool.execution_partial_result', (e: unknown) => {
      const ev = e as { id?: string; data?: Record<string, unknown> };
      persist('tool.partial_result', { eventId: ev.id, data: safe(ev.data) }, false, AUDIT_RANK.full);
    });
    session.on('tool.execution_progress', (e: unknown) => {
      const ev = e as { id?: string; data?: Record<string, unknown> };
      persist('tool.progress', { eventId: ev.id, data: safe(ev.data) }, false, AUDIT_RANK.full);
    });
    // Permission decisions (policy + resolved outcome per tool call) — visible from 'default'
    session.on('permission.requested', (e: unknown) => {
      const ev = e as { id?: string; data?: Record<string, unknown> };
      persist('permission.request', { eventId: ev.id, data: safe(ev.data) }, true, AUDIT_RANK.default);
    });
    session.on('permission.completed', (e: unknown) => {
      const ev = e as { id?: string; data?: Record<string, unknown> };
      persist('permission.decision', { eventId: ev.id, data: safe(ev.data) }, true, AUDIT_RANK.default);
    });
    // Hook lifecycle — visible from 'default'
    session.on('hook.start', (e: unknown) => {
      const ev = e as { data?: Record<string, unknown> };
      persist('hook.start', { data: safe(ev.data) }, true, AUDIT_RANK.default);
    });
    session.on('hook.end', (e: unknown) => {
      const ev = e as { data?: Record<string, unknown> };
      persist('hook.end', { data: safe(ev.data) }, true, AUDIT_RANK.default);
    });

    session.on('assistant.message_delta', (e: unknown) => {
      const text = extractDelta(e);
      if (text && opts.streamOut) opts.streamOut(text);
      persist('assistant.message_delta', { delta: text?.slice(0, 2000) }, false, AUDIT_RANK.full);
    });
    session.on('assistant.message', (e: unknown) => persist('assistant.message', { event: safe(e) }, true, AUDIT_RANK.minimal));
    session.on('assistant.reasoning', (e: unknown) => {
      const ev = e as { data?: Record<string, unknown> };
      persist('assistant.reasoning', { data: safe(ev.data) }, true, AUDIT_RANK.full);
    });
    session.on('assistant.turn_start', () => persist('assistant.turn_start', {}, true, AUDIT_RANK.default));
    session.on('assistant.turn_end', () => persist('assistant.turn_end', {}, true, AUDIT_RANK.default));
    session.on('session.error', (e: unknown) => {
      const ev = e as { data?: Record<string, unknown> };
      persist('session.error', { data: safe(ev.data) }, true, AUDIT_RANK.minimal);
    });
    session.on('assistant.usage', (e: unknown) => {
      persist('assistant.usage', { event: safe(e) }, true, AUDIT_RANK.default);
      const u = e as { inputTokens?: number; outputTokens?: number; cost?: number; model?: string; endpoint?: string; requestId?: string };
      try { opts.db.recordUsage(runId, { tokensIn: u.inputTokens, tokensOut: u.outputTokens, credits: u.cost, durationMs: Date.now() - started, endpoint: u.endpoint, requestId: u.requestId }); } catch { /* noop */ }
    });
    session.on('session.idle', () => persist('session.idle', {}, false));

    const sendArgs = toSendArgs(def, opts.taskOverride);
    persist('prompt.send', { prompt: sendArgs.prompt.slice(0, 4000), mode: sendArgs.mode }, true, AUDIT_RANK.minimal);
    // Generous timeout: multi-turn tool-using turns routinely exceed the SDK's 60s default (UI building, multi-file edits)
    const turnTimeoutMs = 10 * 60 * 1000;
    const response = (await (session as { sendAndWait: (a: unknown, t?: number) => Promise<unknown> }).sendAndWait({ prompt: sendArgs.prompt, mode: sendArgs.mode }, turnTimeoutMs)) as { data?: { content?: string }; content?: string; text?: string };
    const text = response?.data?.content ?? response?.content ?? response?.text ?? JSON.stringify(safe(response)).slice(0, 8000);
    persist('run.complete', { chars: text.length, durationMs: Date.now() - started }, true, AUDIT_RANK.minimal);
    opts.db.finishRun(runId, 'done');
    try { opts.db.upsertSession({ sessionId, status: 'idle-done', summary: text.slice(0, 200) }); } catch { /* best-effort */ }
    try { await (session as { disconnect: () => Promise<void> }).disconnect(); } catch { /* noop */ }
    await client.stop();
    return { runId, sessionId, traceId, text };
  } catch (err) {
    const message = (err as Error).message;
    persist('run.error', { error: message }, true, AUDIT_RANK.minimal);
    opts.db.finishRun(runId, 'failed', message);
    try { opts.db.upsertSession({ sessionId: (typeof sessionId === 'string' ? sessionId : 'unknown'), status: 'failed', summary: message.slice(0, 200) }); } catch { /* best-effort */ }
    try { await client.stop(); } catch { /* noop */ }
    throw err;
  }
}

function extractDelta(e: unknown): string {
  const o = e as { delta?: string; deltaContent?: string; content?: string; data?: { delta?: string; deltaContent?: string; content?: string; text?: string } };
  return o?.delta ?? o?.deltaContent ?? o?.content ?? o?.data?.delta ?? o?.data?.deltaContent ?? o?.data?.content ?? o?.data?.text ?? '';
}

function safe(e: unknown): Record<string, unknown> {
  try { return JSON.parse(JSON.stringify(e)) as Record<string, unknown>; } catch { return { unserializable: true }; }
}
