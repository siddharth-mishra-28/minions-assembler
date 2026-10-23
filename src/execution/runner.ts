import { CopilotClient } from '@github/copilot-sdk';
import { toSessionOptions, toSendArgs, resolveApiKey, resolvePersona } from '../agents/translator.js';
import { resolveBuiltinTools } from '../agents/tools-policy.js';
import { expandMcpRefs } from '../mcp/mcp.js';
import { createUsageProxy, type UsageProxy } from './usage-proxy.js';
import type { McpServerConfig } from '../mcp/mcp.js';
import { compilePermissionHandlers } from '../agents/permissions.js';
import { AuditLog, newTraceId } from '../core/audit.js';
import { redactedForLog } from '../agents/loader.js';
import { resolveWorkspace } from '../core/workspace.js';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildHarnessTools, autoMkdirPreTool, resolveTurnTimeoutMs, harnessEnabled, DEFAULT_TURN_TIMEOUT_MS } from '../agents/harness-tools.js';
import type { AgentDefinition } from '../core/types.js';
import type { DbAdapter } from '../store/adapter.js';

/**
 * Absolute per-run working directory: `<workspaceRoot>/<runId>` (runId already
 * carries the `run_` prefix, e.g. `workspace-agent/run_a4b8b05f`).
 * Agents build inside their own sandbox folder so concurrent/sequential runs
 * never share file locks (Windows EPERM from esbuild/tsx when a workspace root
 * is deleted mid- or post-run).
 */
export function joinRunRoot(workspaceRoot: string, runId: string): string {
  return resolve(join(workspaceRoot, runId.replace(/[^a-zA-Z0-9_-]/g, '_')));
}

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
  /** Headless approval: 'autopilot' auto-approves every ask (and counts as explicit CI approval); 'strict' denies asks. Default keeps the legacy deferred-deny. */
  approvalMode?: 'autopilot' | 'strict';
  streamOut?: (text: string) => void;
  resumeSessionId?: string;
  /** Audit verbosity for this run; falls back to AUDIT_LEVEL env, then 'default'. */
  auditLevel?: AuditLevel;
  /** Registry servers available for mcp.use expansion: name -> full config. */
  mcpRegistry?: Map<string, McpServerConfig>;
  /** Discovered tool names per registry server (for allow/deny filtering). */
  mcpRegistryTools?: Map<string, string[]>;
  /**
   * Per-turn budget for `sendAndWait` in ms. Overrides definition `runtime.turnTimeoutMs`
   * and the `RUN_TURN_TIMEOUT_MS` env. Defaults to 45 minutes for multi-file builds.
   */
  turnTimeoutMs?: number;
}

/**
 * Abort registry: maps runId → stop() for every in-flight SDK session, so callers
 * can kill a run's session (client.stop + session disconnect) through the same stop
 * machinery executeRun already uses in its own cleanup.
 */
const activeStops = new Map<string, () => Promise<void>>();
/** Runs explicitly aborted via abortRun — so the error path records `aborted`, not `failed`. */
const abortedRuns = new Set<string>();

/** Kill (stop) an in-flight run's SDK session; resolves whether or not it was active. */
export async function abortRun(runId: string): Promise<boolean> {
  const stop = activeStops.get(runId);
  if (!stop) return false;
  abortedRuns.add(runId);
  try { await stop(); } catch { /* session may already be dead */ }
  activeStops.delete(runId);
  return true;
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

  // Session/run-scoped isolation: every run gets its own working directory nested
  // inside the selected workspace root (`<workspace>/run_<runId>`). The agent's
  // file writes, NPM installs, dev servers, and esbuild caches all live there, so
  // stale child processes from one run never lock the shared workspace root and
  // previous runs' projects can always be deleted independently.
  const runRoot = opts.runDir ?? joinRunRoot(workspace.root, runId);
  mkdirSync(runRoot, { recursive: true });

  const audit = new AuditLog(`${runRoot}/.audit`);
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

  persist('run.start', { traceId, sessionId, agentId: opts.agentId, auditLevel, definition: redactedForLog(def), workspace: { root: workspace.root, source: workspace.source }, runRoot }, true, AUDIT_RANK.minimal);
  // Persona resolution audit: what the session system prompt will actually be.
  const persona = resolvePersona(def);
  persist('persona.resolved', { defaultPromptIncluded: persona.defaultPromptIncluded, summary: persona.summary, systemMessage: persona.systemMessage ? { mode: (persona.systemMessage as { mode?: string }).mode ?? 'append', contentChars: String((persona.systemMessage as { content?: string }).content ?? '').length } : null }, true, AUDIT_RANK.minimal);
  // Tools resolution audit: builtins posture summary.
  const builtinsResolution = resolveBuiltinTools(def);
  persist('tools.resolved', builtinsResolution as unknown as Record<string, unknown>, true, AUDIT_RANK.minimal);

  // Wire-level usage capture: the Copilot runtime masks per-call token counts for
  // BYOK providers ('***' in assistant.usage events → nulls in the usage table).
  // For openai-completions providers we count exact usage at the wire instead: a
  // one-shot local proxy fronts the real endpoint and reports per-call tokens.
  let usageProxy: UsageProxy | undefined;
  // Key names avoid the substring "token" — the audit layer scrubs any key matching /token/i.
  const usageTotals = { calls: 0, tokIn: 0, tokOut: 0, tokReasoning: 0 };
  if (def.provider.type === 'openai' && (def.provider.wireApi ?? 'completions') === 'completions' && def.provider.baseUrl) {
    try {
      usageProxy = await createUsageProxy({
        upstream: def.provider.baseUrl,
        onUsage: (capture) => {
          usageTotals.calls += 1;
          usageTotals.tokIn += capture.tokIn ?? 0;
          usageTotals.tokOut += capture.tokOut ?? 0;
          usageTotals.tokReasoning += capture.tokReasoning ?? 0;
          persist('usage.capture', { runs: 1, ...capture }, true, AUDIT_RANK.default);
        },
      });
      persist('usage.proxy', { proxyUrl: usageProxy.url, upstream: new URL(def.provider.baseUrl).host }, true, AUDIT_RANK.minimal);
    } catch (e) {
      persist('usage.proxy', { error: `usage capture unavailable: ${(e as Error).message}` }, true, AUDIT_RANK.minimal);
    }
  }

  const recordUsageTotals = () => {
    if (!usageProxy || usageTotals.calls === 0) return;
    try {
      opts.db.recordUsage(runId, { tokensIn: usageTotals.tokIn, tokensOut: usageTotals.tokOut, durationMs: Date.now() - started, endpoint: 'usage-proxy' });
      persist('usage.totals', { ...usageTotals }, true, AUDIT_RANK.default);
    } catch { /* best-effort */ }
  };
  let started = 0;

  const client = new CopilotClient({
    onListModels: () => [{ id: def.provider.model, name: def.provider.model, capabilities: { supports: { vision: false, reasoningEffort: false } }, limits: { max_context_window_tokens: 128000 } } as never],
  });
  await client.start();
  try {
    const sessionOpts = toSessionOptions(def, apiKey);
    // Route model traffic through the one-shot wire proxy when active
    if (usageProxy) {
      const provider = (sessionOpts as { provider?: Record<string, unknown> }).provider;
      if (provider && 'baseUrl' in (provider as Record<string, unknown>)) {
        provider.baseUrl = usageProxy.url;
        persist('usage.proxy', { routed: true, proxyUrl: usageProxy.url }, true, AUDIT_RANK.minimal);
      } else {
        persist('usage.proxy', { routed: false, reason: 'session provider did not accept a baseUrl override' }, true, AUDIT_RANK.minimal);
      }
    }
    // The SDK resolves a relative workingDirectory against its own process cwd (the project
    // root), which would let the agent write outside the agent workspace. Always pass the
    // absolutely-resolved workspace root instead of the raw definition value.
    // Per-run isolation: this is the run's own `run_<id>` folder inside the workspace.
    (sessionOpts as Record<string, unknown>).workingDirectory = runRoot;
    persist('run.workspace', { workspaceRoot: workspace.root, runRoot, source: workspace.source }, true, AUDIT_RANK.minimal);

    // Coding-harness tools: shell, recursive mkdir, parent-dir-safe write/create.
    // These restore what a regular GitHub Copilot coding agent can do, so nested
    // scaffolds (app/, lib/, components/) do not die with "Parent directory does not exist"
    // or "Tool 'bash' does not exist".
    const harnessTools = harnessEnabled(def)
      ? buildHarnessTools({
          workspaceRoot: runRoot,
          onToolEvent: (type, payload) => persist(type, payload, true, AUDIT_RANK.default),
        })
      : [];
    if (harnessTools.length) {
      const existing = (sessionOpts as { tools?: unknown[] }).tools ?? [];
      const names = new Set(harnessTools.map((t) => t.name));
      (sessionOpts as Record<string, unknown>).tools = [...harnessTools, ...existing.filter((t) => !names.has((t as { name?: string }).name ?? ''))];
    }
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
    const { onPermissionRequest, onPreToolUse } = compilePermissionHandlers(def, { ciApproveAll: (opts.ciApproveAll ?? false) || opts.approvalMode === 'autopilot', harnessTools: harnessEnabled(def), approvalMode: opts.approvalMode }, {
      onAskResolved: (info) => persist('permission.ask_resolved', info, true, AUDIT_RANK.default),
      onAskDeferred: (info) => persist('permission.ask_denied', { ...info, reason: "'ask' decisions are not interactively approved in headless runs — tool call denied" }, true, AUDIT_RANK.default),
      onDestructiveDeny: (info) => persist('permission.destructive_denied', info, true, AUDIT_RANK.default),
    });
    (sessionOpts as Record<string, unknown>).onPermissionRequest = onPermissionRequest;
    // Pre-tool chain: permission policy first, then auto-mkdir for nested create/edit paths.
    const autoMkdir = autoMkdirPreTool(runRoot);
    (sessionOpts as Record<string, unknown>).hooks = {
      onPreToolUse: async (input: { toolName?: string; tool?: string; toolArgs?: unknown }) => {
        const decision = await onPreToolUse(input) as { permissionDecision?: string; additionalContext?: string } | undefined;
        if (decision?.permissionDecision === 'deny') return decision;
        const mkdirResult = harnessEnabled(def) ? (await autoMkdir(input)) as { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } | undefined : undefined;
        if (mkdirResult?.permissionDecision === 'deny') return mkdirResult;
        if (mkdirResult?.additionalContext) {
          return { ...decision, additionalContext: decision?.additionalContext ? `${decision.additionalContext}\n${mkdirResult.additionalContext}` : mkdirResult.additionalContext };
        }
        return decision;
      },
    };

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
    // Register the abort handle (same stop machinery executeRun's own cleanup calls).
    activeStops.set(runId, async () => {
      try { await (session as { disconnect?: () => Promise<void> } | undefined)?.disconnect?.(); } catch { /* noop */ }
      try { await client.stop(); } catch { /* noop */ }
    });

    started = Date.now();
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
    });    session.on('assistant.usage', (e: unknown) => {
      persist('assistant.usage', { event: safe(e) }, true, AUDIT_RANK.default);
      // With the wire proxy active, exact accounting comes from usage.capture events
      // (see recordUsageTotals at run end) — the runtime only offers masked values here.
      if (usageProxy) return;

      const u = e as { inputTokens?: number; outputTokens?: number; cost?: number; model?: string; endpoint?: string; requestId?: string };
      try { opts.db.recordUsage(runId, { tokensIn: u.inputTokens, tokensOut: u.outputTokens, credits: u.cost, durationMs: Date.now() - started, endpoint: u.endpoint, requestId: u.requestId }); } catch { /* noop */ }
    });
    session.on('session.idle', () => persist('session.idle', {}, false));

    const sendArgs = toSendArgs(def, opts.taskOverride);
    if (!sendArgs.prompt.trim() && !def.fleet?.enabled) throw new Error('No task to run: the definition has an empty task.prompt and no task override was supplied');
    // Configurable turn budget: API body > definition.runtime.turnTimeoutMs > RUN_TURN_TIMEOUT_MS > 45 min.
    // Multi-file coding builds routinely need far more than the old hard-coded 10 minutes.
    const turnTimeoutMs = resolveTurnTimeoutMs(def, opts.turnTimeoutMs);
    persist('run.turn_budget', { turnTimeoutMs, source: opts.turnTimeoutMs != null ? 'body' : def.runtime?.turnTimeoutMs != null ? 'definition' : process.env.RUN_TURN_TIMEOUT_MS ? 'env' : 'default', default: DEFAULT_TURN_TIMEOUT_MS }, true, AUDIT_RANK.minimal);
    let text = '';

    if (def.fleet?.enabled) {
      const fleetPrompt = def.fleet.prompt?.trim() || sendArgs.prompt;
      persist('fleet.start', { prompt: fleetPrompt.slice(0, 4000), maxConcurrentWorkers: def.fleet.maxConcurrentWorkers ?? 5 }, true, AUDIT_RANK.minimal);
      const sessAny = session as any;
      let fleetResponse: any;
      if (typeof sessAny.rpc?.fleet?.start === 'function') {
        fleetResponse = await sessAny.rpc.fleet.start({ prompt: fleetPrompt });
      } else if (typeof sessAny.fleet?.start === 'function') {
        fleetResponse = await sessAny.fleet.start({ prompt: fleetPrompt });
      } else {
        fleetResponse = await (session as { sendAndWait: (a: unknown, t?: number) => Promise<unknown> }).sendAndWait({ prompt: `/fleet ${fleetPrompt}`, mode: sendArgs.mode }, turnTimeoutMs);
      }
      text = fleetResponse?.data?.content ?? fleetResponse?.content ?? fleetResponse?.text ?? (typeof fleetResponse === 'string' ? fleetResponse : JSON.stringify(safe(fleetResponse)).slice(0, 8000));
    } else {
      persist('prompt.send', { prompt: sendArgs.prompt.slice(0, 4000), mode: sendArgs.mode }, true, AUDIT_RANK.minimal);
      // Generous timeout: multi-turn tool-using turns routinely exceed the SDK's 60s default (UI building, multi-file edits)
      const response = (await (session as { sendAndWait: (a: unknown, t?: number) => Promise<unknown> }).sendAndWait({ prompt: sendArgs.prompt, mode: sendArgs.mode }, turnTimeoutMs)) as { data?: { content?: string }; content?: string; text?: string };
      text = response?.data?.content ?? response?.content ?? response?.text ?? JSON.stringify(safe(response)).slice(0, 8000);
    }
    persist('run.complete', { chars: text.length, durationMs: Date.now() - started }, true, AUDIT_RANK.minimal);
    opts.db.finishRun(runId, 'done');
    try { opts.db.upsertSession({ sessionId, status: 'idle-done', summary: text.slice(0, 200) }); } catch { /* best-effort */ }
    try { await (session as { disconnect: () => Promise<void> }).disconnect(); } catch { /* noop */ }
    activeStops.delete(runId);
    abortedRuns.delete(runId);
    await client.stop();
    recordUsageTotals();
    await usageProxy?.close();
    return { runId, sessionId, traceId, text };
  } catch (err) {
    const message = (err as Error).message;
    activeStops.delete(runId);
    const aborted = abortedRuns.delete(runId);
    persist(aborted ? 'run.aborted' : 'run.error', aborted ? { reason: message } : { error: message }, true, AUDIT_RANK.minimal);
    opts.db.finishRun(runId, aborted ? 'aborted' : 'failed', message);
    try { opts.db.upsertSession({ sessionId: (typeof sessionId === 'string' ? sessionId : 'unknown'), status: aborted ? 'aborted' : 'failed', summary: message.slice(0, 200) }); } catch { /* best-effort */ }
    try { await client.stop(); } catch { /* noop */ }
    recordUsageTotals();
    await usageProxy?.close();
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
