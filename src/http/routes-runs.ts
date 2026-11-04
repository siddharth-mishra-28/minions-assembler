import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveWorkspace } from '../core/workspace.js';
import { abortRun, executeRun } from '../execution/runner.js';
import { validateDefinitionObject, hydrateAgentDefinition, hydrateDefinitionObject, redactedForLog } from '../agents/loader.js';
import { sealDefinitionSecrets } from '../agents/provider-keys.js';
import type { AgentDefinition } from '../core/types.js';
import type { DbAdapter } from '../store/adapter.js';
import type { McpServerConfig } from '../mcp/mcp.js';
import type { RunQueue } from '../core/run-queue.js';
import { resolveMemoryConfig } from '../memory/config.js';
import { createMemoryRuntime } from '../memory/runtime.js';
import type { MemoryStore } from '../memory/store.js';
import { errorSchema } from './route-schemas.js';

/**
 * Runs route group: synchronous agent execution (stored id + inline definition), and
 * read access to runs, their audit event chains, SSE replay, and SDK sessions.
 * All execution funnels through the same executeRun machinery and the shared RunQueue,
 * so concurrent POSTs execute in submission order.
 */
export async function registerRunRoutes(app: FastifyInstance, ctx: { db: DbAdapter; runQueue: RunQueue; memoryStore?: MemoryStore }): Promise<void> {
  const { db, runQueue, memoryStore } = ctx;

  /**
   * Optional per-run working directory. HTTP callers may reuse the directory a previous
   * run produced (phase builds), but the path is confined to the server workspace so a
   * request cannot point a run at an arbitrary filesystem location.
   */
  const resolveRunDir = (raw?: string): { runDir?: string; error?: string } => {
    if (!raw?.trim()) return {};
    const root = resolve(resolveWorkspace().root);
    const dir = resolve(raw.trim());
    const rel = relative(root, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) return { error: `runDir must be inside the server workspace (${root})` };
    return { runDir: dir };
  };

  /**
   * Per-run memory runtime. Config resolves from the agent's DB row over the
   * platform defaults row, so behavior is fully database-driven.
   */
  const memoryFor = (definition: AgentDefinition, agentId: string, task: string) => {
    if (!memoryStore) return undefined;
    const config = resolveMemoryConfig(memoryStore, definition);
    if (!config.enabled) return undefined;
    return createMemoryRuntime({ store: memoryStore, config, definition, agentId, task });
  };

  const runResultSchema = {
    type: 'object',
    properties: {
      runId: { type: 'string', example: 'run_4ca069a3' },
      sessionId: { type: 'string', example: 'sess_mv3utt1r_nxux6q' },
      traceId: { type: 'string', example: 'tr_mv3utt1r_91bs37zv' },
      text: { type: 'string', example: 'MIMO-OK — I am an AI coding agent powered by mimo-v2.6-flash.' },
    },
  };

  /** Build the runtime MCP registry from the DB: registered configs + discovered tool names. */
  const mcpRegistryFromDb = (): { registry: Map<string, McpServerConfig>; tools: Map<string, string[]> } => {
    const registry = new Map<string, McpServerConfig>();
    const tools = new Map<string, string[]>();
    for (const row of db.listMcpServers()) {
      try {
        registry.set(row.name, JSON.parse((db.getMcpServer(row.name) as { config_json: string }).config_json) as McpServerConfig);
        const tj = row.tools_json ? JSON.parse(row.tools_json) as { name: string }[] : [];
        tools.set(row.name, tj.map((t) => t.name));
      } catch { /* skip malformed rows */ }
    }
    return { registry, tools };
  };

  app.post('/api/agents/:id/runs', {
    schema: {
      tags: ['runs'],
      summary: 'Run an agent synchronously',
      description:
        'Executes via the Copilot SDK (`sendAndWait`). Optional `taskOverride` replaces the definition task prompt. ' +
        'Definitions that use `mcp.use` pull their servers from the MCP registry (`/api/mcp`) at run time — a missing registry entry fails the run with a clear error (persisted as `run.error`). ' +
        'Returns when the turn finishes; the full event chain (prompt, deltas, tool/permission decisions, usage) is persisted and queryable. ' +
        'Requires a resolvable `provider.providerApiKey` (enc:v1 token, ${ENV_VAR} ref, or literal key).',
      body: {
        type: 'object',
        properties: {
          taskOverride: { type: 'string', description: 'Overrides task.prompt from the definition', example: 'Reply with exactly: SERVE-API-OK' },
          auditLevel: { type: 'string', enum: ['minimal', 'default', 'full'], description: 'Audit verbosity for this run (default from AUDIT_LEVEL env)', default: 'default' },
          approvalMode: { type: 'string', enum: ['autopilot', 'strict'], description: 'autopilot auto-approves every ask decision (destructive gate still applies); strict denies them. Default: ask decisions are denied.' },
          turnTimeoutMs: { type: 'integer', minimum: 1000, maximum: 21600000, description: 'Per-turn budget in ms (overrides definition runtime.turnTimeoutMs / RUN_TURN_TIMEOUT_MS; default 2700000 = 45 min)' },
          runDir: { type: 'string', description: 'Optional working directory for this run (must be inside the server workspace). Reuse the same directory for phase builds.', example: './runs/phase-build' },
        },
      },
      response: { 200: runResultSchema, 400: { ...errorSchema, description: 'Stored agent definition failed validation' }, 404: { ...errorSchema, description: 'Unknown agent id' }, 500: { ...errorSchema, description: 'Run failed (missing credential, provider error, runtime error)' } },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });
    // Single hydration path: validate + env-resolve the stored (portable) definition.
    let definition: AgentDefinition;
    let definitionHash: string;
    try {
      const hydrated = hydrateAgentDefinition(agent.definition_json as string);
      definition = hydrated.resolved;
      definitionHash = (agent.definition_hash as string | null) || hydrated.definitionHash;
    } catch (e) {
      return reply.code(400).send({ error: `agent ${id} has an invalid definition: ${(e as Error).message}` });
    }
    const { taskOverride, auditLevel, turnTimeoutMs, approvalMode, runDir } = (req.body ?? {}) as { taskOverride?: string; auditLevel?: 'minimal' | 'default' | 'full'; turnTimeoutMs?: number; approvalMode?: 'autopilot' | 'strict'; runDir?: string };
    const rd = resolveRunDir(runDir);
    if (rd.error) return reply.code(400).send({ error: rd.error });
    mkdirSync('./runs', { recursive: true });
    try {
      const { registry, tools } = mcpRegistryFromDb();
      // Serialize: chain each run onto the previous one so concurrent POSTs queue cleanly.
      const queued = runQueue.run(() => executeRun({
        definition, definitionSnapshot: agent.definition_json as string, agentId: id, definitionHash, db,
        taskOverride, auditLevel, turnTimeoutMs, approvalMode, runDir: rd.runDir, streamOut: () => {}, mcpRegistry: registry, mcpRegistryTools: tools,
        memory: memoryFor(definition, id, taskOverride ?? definition.task.prompt),
      }));
      return await queued;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // Inline definition execution: run a PASTED agent definition without pre-registering it.
  // Validates with the same loader the CLI uses, upserts under its own name@version
  // (idempotent — the agent stays updatable via POST /api/agents), then runs through the
  // SAME executeRun machinery and run-queue serialization as /api/agents/:id/runs.
  // Returns the exact runResultSchema shape — the run id is 100% compatible with GET /api/runs/:id.
  app.post('/api/agent-definitions/runs', {
    schema: {
      tags: ['runs'],
      summary: 'Run an agent definition passed inline (no stored id needed)',
      description:
        'Body: { definition: AgentDefinition, taskOverride?, auditLevel?, turnTimeoutMs? }. Validated with the CLI\'s loader, upserted under name@version, executed via the same runner as POST /api/agents/:id/runs. Returns the same shape — `runId` works with GET /api/runs/:id and the UI runs pages.',
      body: {
        type: 'object',
        required: ['definition'],
        properties: {
          definition: { type: 'object', description: 'Full AgentDefinition v1.0 object' },
          taskOverride: { type: 'string', description: 'Overrides task.prompt from the definition', example: 'Reply with exactly: INLINE-DEF-OK' },
          auditLevel: { type: 'string', enum: ['minimal', 'default', 'full'], default: 'default' },
          approvalMode: { type: 'string', enum: ['autopilot', 'strict'], description: 'autopilot auto-approves every ask decision (destructive gate still applies); strict denies them.' },
          turnTimeoutMs: { type: 'integer', minimum: 1000, maximum: 21600000, description: 'Per-turn budget in ms (default 2700000 = 45 min)' },
          runDir: { type: 'string', description: 'Optional working directory for this run (must be inside the server workspace). Reuse the same directory for phase builds.' },
        },
      },
      response: { 200: runResultSchema, 400: { ...errorSchema, description: 'Invalid definition' }, 500: { ...errorSchema, description: 'Run failed' } },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { definition?: unknown; taskOverride?: string; auditLevel?: 'minimal' | 'default' | 'full'; turnTimeoutMs?: number; approvalMode?: 'autopilot' | 'strict'; runDir?: string };
    if (!body.definition) return reply.code(400).send({ error: 'Body must include a definition object' });
    const rd = resolveRunDir(body.runDir);
    if (rd.error) return reply.code(400).send({ error: rd.error });
    let definition: AgentDefinition;
    let definitionHash: string;
    let portableJson: string;
    try {
      // Same validation path as `npm run dev validate` — schema rules, hash, warnings.
      const parsed = validateDefinitionObject(body.definition);
      // Seal literal secrets before anything is persisted or snapshotted; ${ENV} refs stay portable.
      const sealed = sealDefinitionSecrets(parsed.definition);
      const sealedLoad = hydrateDefinitionObject(sealed);
      definition = sealedLoad.resolved;
      definitionHash = sealedLoad.definitionHash;
      portableJson = JSON.stringify(sealed);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const agentId = db.saveAgent(definition.metadata.name, definition.metadata.version, portableJson, definitionHash);
    mkdirSync('./runs', { recursive: true });
    try {
      const { registry, tools } = mcpRegistryFromDb();
      const queued = runQueue.run(() => executeRun({
        definition, definitionSnapshot: portableJson, agentId, definitionHash, db,
        taskOverride: body.taskOverride, auditLevel: body.auditLevel, turnTimeoutMs: body.turnTimeoutMs, approvalMode: body.approvalMode, runDir: rd.runDir,
        streamOut: () => {}, mcpRegistry: registry, mcpRegistryTools: tools,
        memory: memoryFor(definition, agentId, body.taskOverride ?? definition.task.prompt),
      }));
      return await queued;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.get('/api/runs', {
    schema: {
      tags: ['runs'],
      summary: 'List recent runs',
      description: 'Newest first, max 100. Filter by `?agentId=`. No response schema: run rows are free-form.',        querystring: { type: 'object', properties: { agentId: { type: 'string', example: 'full-stack-engineer@1.0.0' } } },
    },
  }, async (req) => {
    const q = req.query as { agentId?: string };
    return { runs: db.listRuns(q.agentId) };
  });

  app.get('/api/runs/:id', {
    schema: {
      tags: ['runs'],
      summary: 'Fetch one run',
      response: { 404: { ...errorSchema, description: 'Unknown run id' } },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = db.getRun(id);
    if (!run) return reply.code(404).send({ error: `run not found: ${id}` });
    return run;
  });

  app.post('/api/runs/:id/stop', {
    schema: {
      tags: ['runs'],
      summary: 'Stop an in-flight run',
      description: 'Kills the run\'s SDK session. The run is then persisted as failed/aborted by the runner. Returns stopped:false if the run is not currently executing.',
      response: { 404: { ...errorSchema, description: 'Unknown run id' } },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!db.getRun(id)) return reply.code(404).send({ error: `run not found: ${id}` });
    return { runId: id, stopped: await abortRun(id) };
  });

  app.get('/api/runs/:id/definition', {
    schema: {
      tags: ['runs'],
      summary: 'The exact agent definition a run executed',
      description:
        'Returns the sealed, portable definition snapshot recorded at run start (secrets redacted). ' +
        'Hydrating this snapshot reproduces the run configuration exactly, even after the agent was edited or deleted.',
      response: { 404: { ...errorSchema, description: 'Unknown run id, or a run started before snapshots were recorded' }, 500: { ...errorSchema, description: 'Corrupt definition snapshot' } },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = db.getRun(id);
    if (!run) return reply.code(404).send({ error: `run not found: ${id}` });
    const raw = db.getRunDefinition(id);
    if (!raw) return reply.code(404).send({ error: `run ${id} has no definition snapshot (snapshots are recorded for runs started after this feature)` });
    try {
      return { runId: id, definition_hash: run.definition_hash ?? null, definition: redactedForLog(JSON.parse(raw)) };
    } catch (e) {
      return reply.code(500).send({ error: `corrupt definition snapshot: ${(e as Error).message}` });
    }
  });

  app.get('/api/runs/:id/events', {
    schema: {
      tags: ['runs'],
      summary: 'Audit events for a run',
      description:
        'Ordered event chain: run.start, session.create, prompt.send, assistant.turn_start, assistant.message_delta, assistant.message, assistant.turn_end, assistant.usage, session.idle, run.complete (or run.error). ' +
        'Use `?afterSeq=` for incremental polling — returns only events with a higher seq.',
      querystring: { type: 'object', properties: { afterSeq: { type: 'integer', description: 'Return only events after this seq (0 = all)', example: 0 } } },
      // no 200 response schema: `run` row is free-form; events items include free-form payload_json intermediates
      response: {
        404: { ...errorSchema, description: 'Unknown run id' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = db.getRun(id);
    if (!run) return reply.code(404).send({ error: `run not found: ${id}` });
    const q = req.query as { afterSeq?: string };
    return { run, events: db.getEvents(id, Number(q.afterSeq ?? 0)) };
  });

  app.get('/api/runs/:id/stream', {
    schema: {
      tags: ['runs'],
      summary: 'SSE event stream for a run',
      description: 'Replays all persisted events as `data: {"seq":n,"type":"…"}` lines, then `data: {"done":true}` and closes.',
      response: { 404: { ...errorSchema, description: 'Unknown run id' } },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = db.getRun(id);
    if (!run) return reply.code(404).send({ error: `run not found: ${id}` });
    reply.header('Content-Type', 'text/event-stream');
    reply.header('Cache-Control', 'no-cache');
    reply.header('Connection', 'keep-alive');
    for (const e of db.getEvents(id)) reply.raw.write(`data: ${JSON.stringify({ seq: e.seq, type: e.type })}\n\n`);
    reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    reply.raw.end();
  });

  app.get('/api/sessions', {
    schema: {
      tags: ['runs'],
      summary: 'List SDK sessions (audit)',
      description: 'Every SDK session with its run, agent, trace id, status, and final summary — auditable end to end.',
    },
  }, async () => ({ sessions: db.listSessions() }));

  app.get('/api/sessions/:sid', {
    schema: {
      tags: ['runs'],
      summary: 'Inspect one SDK session',
      response: { 404: { ...errorSchema, description: 'Unknown session id' } },
    },
  }, async (req, reply) => {
    const sid = decodeURIComponent((req.params as { sid: string }).sid);
    const s = db.getSession(sid);
    if (!s) return reply.code(404).send({ error: `session not found: ${sid}` });
    return s;
  });
}
