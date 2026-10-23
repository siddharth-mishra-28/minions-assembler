import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { abortRun, executeRun } from '../execution/runner.js';
import { validateDefinitionObject } from '../agents/loader.js';
import type { DbAdapter } from '../store/adapter.js';
import type { McpServerConfig } from '../mcp/mcp.js';
import type { RunQueue } from '../core/run-queue.js';
import { errorSchema } from './route-schemas.js';

/**
 * Runs route group: synchronous agent execution (stored id + inline definition), and
 * read access to runs, their audit event chains, SSE replay, and SDK sessions.
 * All execution funnels through the same executeRun machinery and the shared RunQueue,
 * so concurrent POSTs execute in submission order.
 */
export async function registerRunRoutes(app: FastifyInstance, ctx: { db: DbAdapter; runQueue: RunQueue }): Promise<void> {
  const { db, runQueue } = ctx;

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
        },
      },
      response: { 200: runResultSchema, 404: { ...errorSchema, description: 'Unknown agent id' }, 500: { ...errorSchema, description: 'Run failed (missing credential, provider error, runtime error)' } },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });
    const definition = JSON.parse(agent.definition_json as string);
    const { taskOverride, auditLevel, turnTimeoutMs, approvalMode } = (req.body ?? {}) as { taskOverride?: string; auditLevel?: 'minimal' | 'default' | 'full'; turnTimeoutMs?: number; approvalMode?: 'autopilot' | 'strict' };
    mkdirSync('./runs', { recursive: true });
    try {
      const { registry, tools } = mcpRegistryFromDb();
      // Serialize: chain each run onto the previous one so concurrent POSTs queue cleanly.
      const queued = runQueue.run(() => executeRun({ definition, agentId: id, definitionHash: 'serve', db, taskOverride, auditLevel, turnTimeoutMs, approvalMode, streamOut: () => {}, mcpRegistry: registry, mcpRegistryTools: tools }));
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
        },
      },
      response: { 200: runResultSchema, 400: { ...errorSchema, description: 'Invalid definition' }, 500: { ...errorSchema, description: 'Run failed' } },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { definition?: unknown; taskOverride?: string; auditLevel?: 'minimal' | 'default' | 'full'; turnTimeoutMs?: number; approvalMode?: 'autopilot' | 'strict' };
    if (!body.definition) return reply.code(400).send({ error: 'Body must include a definition object' });
    let definition: import('../core/types.js').AgentDefinition;
    let definitionHash: string;
    try {
      // Same validation path as `npm run dev validate` — schema rules, hash, warnings.
      const parsed = validateDefinitionObject(body.definition);
      definition = parsed.definition;
      definitionHash = parsed.definitionHash;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const agentId = db.saveAgent(definition.metadata.name, definition.metadata.version, JSON.stringify(definition), definitionHash);
    mkdirSync('./runs', { recursive: true });
    try {
      const { registry, tools } = mcpRegistryFromDb();
      const queued = runQueue.run(() => executeRun({ definition, agentId, definitionHash, db, taskOverride: body.taskOverride, auditLevel: body.auditLevel, turnTimeoutMs: body.turnTimeoutMs, approvalMode: body.approvalMode, streamOut: () => {}, mcpRegistry: registry, mcpRegistryTools: tools }));
      return await queued;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.get('/api/runs', {
    schema: {
      tags: ['runs'],
      summary: 'List recent runs',
      description: 'Newest first, max 100. Filter by `?agentId=`. No response schema: run rows are free-form.',        querystring: { type: 'object', properties: { agentId: { type: 'string', example: 'expense-tracker-dev@1.0.0' } } },
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
