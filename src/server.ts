import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { validateDefinitionObject, loadAgentDefinition, redactedForLog } from './loader.js';
import { executeRun } from './runner.js';
import { validateMcpConfig, probeMcpTools } from './mcp.js';
import type { McpServerConfig, McpTool } from './mcp.js';
import { SqliteAdapter } from './store/sqlite.js';
import { mkdirSync } from 'node:fs';
import { dashboardPage, editorPage, agentsPage, agentDetailPage, runsPage, runDetailPage, sessionsPage, sessionDetailPage, mcpPage, mcpDetailPage } from './ui-pages.js';
import { pageShell } from './ui-kit.js';
import { esc } from './ui-util.js';
import { resolveWorkspace, ServerLog } from './workspace.js';

export const PKG = { name: 'minion-assembler', version: '1.0.0' };

const FIXTURE_PATH = './fixtures/mimo-smoke-test.agent.json';

const runResultSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', example: 'run_4ca069a3' },
    sessionId: { type: 'string', example: 'sess_mv3utt1r_nxux6q' },
    traceId: { type: 'string', example: 'tr_mv3utt1r_91bs37zv' },
    text: { type: 'string', example: 'MIMO-OK — I am an AI coding agent powered by mimo-v2.6-flash.' },
  },
};

const errorSchema = { type: 'object', properties: { error: { type: 'string', example: 'agent not found' } } };

const agentSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'mimo-smoke-test@1.0.0' },
    name: { type: 'string', example: 'mimo-smoke-test' },
    version: { type: 'string', example: '1.0.0' },
    created_at: { type: 'string', example: '2026-10-11T13:23:16.580Z' },
  },
};

const statusSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', example: 'minion-assembler' },
    version: { type: 'string', example: '1.0.0' },
    sdk: { type: 'string', example: '@github/copilot-sdk' },
    db: { type: 'string', example: './data/minion.db' },
    uptime: { type: 'number', example: 42.5 },
    workspace: { type: 'string', example: 'D:/dev/agent-workspaces' },
    workspaceSource: { type: 'string', example: 'env' },
    logFile: { type: 'string', example: 'D:/dev/agent-workspaces/.minion/server.log.jsonl' },
  },
};

export async function buildServer(dbPath = './data/minion.db') {
  const db = new SqliteAdapter(dbPath);
  // One SDK session executes at a time (each run spawns a Go child); queue concurrent
  // run requests so the server stays responsive and runs execute in submission order.
  let runChain: Promise<unknown> = Promise.resolve();
  const workspace = resolveWorkspace(); // server-wide: MINION_WORKSPACE env > cwd (definition override is per-run, applied in the runner)
  const serverLog = new ServerLog(workspace.root);
  serverLog.write('info', 'server.start', { db: dbPath, workspace: workspace.root, workspaceSource: workspace.source });
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { strict: false } /* allow example/summary keywords in route schemas */ },
    // Cap request payloads (definitions are small JSON; transcripts spill to disk not bodies)
    bodyLimit: 2 * 1024 * 1024,
    // Keep the HTTP layer responsive under long agent runs: a client vanishing mid-run
    // must not crash the request promise chain.
    connectionTimeout: 30_000,
  });
  app.addHook('onResponse', (req, reply, done) => {
    serverLog.write('audit', 'http.request', { method: req.method, url: req.url, statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) });
    done();
  });
  // Meaningful validation errors: Fastify's default body for schema failures is an opaque "Bad Request"
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { validation?: { instancePath?: string; message?: string }[]; statusCode?: number; message: string };
    if (e.validation) {
      const detail = e.validation.map((v) => `${v.instancePath ?? ''} ${v.message ?? ''}`.trim()).join('; ');
      return reply.code(400).send({ error: `Invalid request body: ${detail}` });
    }
    const status = e.statusCode ?? 500;
    serverLog.write(status >= 500 ? 'error' : 'warn', 'http.error', { status, message: e.message });
    return reply.code(status).send({ error: e.message });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Minion Assembler API',
        version: PKG.version,
        description:
          'Define, run, and audit custom GitHub Copilot agents from versioned JSON definitions.\n\n' +
          '**Auth:** none (loopback-only by default; front with a proxy + token before shared exposure).\n' +
          '**Credentials:** provider API keys are read from the server process env (see `credentialEnv` in a definition) — never send keys in requests.\n' +
          '**IDs:** agent ids are `name@version`; URL-encode `@` as `%40`.',
      },
      tags: [
        { name: 'system', description: 'Health and status' },
        { name: 'agents', description: 'Agent definitions: validate, register, list, inspect' },
        { name: 'runs', description: 'Execute agents and inspect run status, audit events, streams' },
        { name: 'mcp', description: 'MCP server registry: register, list, probe tools, delete' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // ---------- system ----------
  app.get('/api/status', {
    schema: {
      tags: ['system'],
      summary: 'Server health',
      description: 'Package name/version, SDK, db path, uptime, workspace root (definition override > MINION_WORKSPACE env > cwd) and structured log file.',
      response: { 200: statusSchema },
    },
  }, async () => ({
    name: PKG.name, version: PKG.version, sdk: '@github/copilot-sdk', db: dbPath, uptime: process.uptime(),
    workspace: workspace.root, workspaceSource: workspace.source, logFile: serverLog.path,
  }));

  app.get('/api/logs', {
    schema: {
      tags: ['system'],
      summary: 'Structured audit logs (JSONL)',
      description:
        'Reads the server audit log (`.minion/server.log.jsonl` inside the workspace): every HTTP request with status + duration, plus server lifecycle events. ' +
        'Query params: `level` (info|warn|error|audit), `event` substring, `limit` (max 1000, newest last). Use `?level=error` for failures only.',
      querystring: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warn', 'error', 'audit'], description: 'Filter by level' },
          event: { type: 'string', description: 'Substring match on event name, e.g. http.request' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            count: { type: 'integer' },
            entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (req) => {
    const q = (req.query ?? {}) as { level?: string; event?: string; limit?: string };
    let entries: Record<string, unknown>[] = [];
    try {
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(serverLog.path!, 'utf8');
      entries = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { parse_error: l.slice(0, 200) }; } });
    } catch { /* no log file yet -> empty */ }
    if (q.level) entries = entries.filter((e) => e.level === q.level);
    if (q.event) entries = entries.filter((e) => String(e.event ?? '').includes(q.event!));
    const limit = Math.min(Number(q.limit ?? 200) || 200, 1000);
    return { file: serverLog.path, count: entries.length, entries: entries.slice(-limit) };
  });

  app.get('/openapi.json', async (_req, reply) => reply.send(app.swagger()));

  // ---------- agents ----------
  app.post('/api/agents', {
    schema: {
      tags: ['agents'],
      summary: 'Validate + register an agent definition',
      description:
        'Give either `definitionPath` (server-side file path — useful with curl) or `definition` (inline JSON object — used by the UI). ' +
        'Persists on success and returns the id (`name@version`), content hash, and warnings. ' +
        'Credentials are never accepted here; the definition only names the env var to use at run time.',
      body: {
        type: 'object',
        properties: {
          definitionPath: { type: 'string', description: 'Server-side path to a definition JSON file (mutually exclusive with `definition`)', example: './fixtures/mimo-smoke-test.agent.json' },
          definition: { type: 'object', description: 'Inline AgentDefinition v1.0 object (mutually exclusive with `definitionPath`)' },
        },
      },
      // NOTE: no `response` schema here — the response embeds the free-form definition object,
      // and Fastify's response serializer strips undeclared nested objects (would emit {}).
      // 400s keep their schema for docs + typed error serialization.
      response: {
        400: { ...errorSchema, description: 'Both sources given, neither given, invalid JSON, or schema validation failure' },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { definitionPath?: string; definition?: unknown };
    if (body.definitionPath && body.definition) return reply.code(400).send({ error: 'Provide either definitionPath or definition, not both' });
    if (!body.definitionPath && !body.definition) return reply.code(400).send({ error: 'Body must include definitionPath or definition' });
    try {
      const load = body.definitionPath ? loadAgentDefinition(body.definitionPath) : validateDefinitionObject(body.definition);
      const id = db.saveAgent(load.definition.metadata.name, load.definition.metadata.version, JSON.stringify(load.definition), load.definitionHash);
      return { id, hash: load.definitionHash, warnings: load.warnings, definition: redactedForLog(load.definition) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/agents/validate', {
    schema: {
      tags: ['agents'],
      summary: 'Validate an inline definition without saving',
      description: 'Dry-run validation used by the UI editor. Returns validity + warnings but does not persist.',
      body: {
        type: 'object',
        required: ['definition'],
        properties: { definition: { type: 'object', description: 'Inline AgentDefinition v1.0 object' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean', example: true },
            hash: { type: 'string', example: '4d7ee2e206e150bf' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        400: { ...errorSchema, description: 'Missing definition, or schema/semantic validation failure' },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { definition?: unknown };
    if (!body.definition) return reply.code(400).send({ error: 'Body must include a definition object' });
    try {
      const load = validateDefinitionObject(body.definition);
      return { valid: true, hash: load.definitionHash, warnings: load.warnings };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/agents', {
    schema: {
      tags: ['agents'],
      summary: 'List registered agents',
      response: { 200: { type: 'object', properties: { agents: { type: 'array', items: agentSummarySchema } } } },
    },
  }, async () => ({ agents: db.listAgents() }));

  app.get('/api/agents/:id', {
    schema: {
      tags: ['agents'],
      summary: 'Fetch one agent',
      description: 'Returns the stored row plus the parsed definition. `id` is `name@version` (encode `@` as `%40`). No 200 response schema: `definition` is free-form (Fastify must not serialize it).',
      response: {
        404: { ...errorSchema, description: 'Unknown id' },
      },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });
    return { ...agent, definition: JSON.parse(agent.definition_json as string) };
  });

  // ---------- runs ----------
  app.post('/api/agents/:id/runs', {
    schema: {
      tags: ['runs'],
      summary: 'Run an agent synchronously',
      description:
        'Executes via the Copilot SDK (`sendAndWait`). Optional `taskOverride` replaces the definition task prompt. ' +
        'Definitions that use `mcp.use` pull their servers from the MCP registry (`/api/mcp`) at run time — a missing registry entry fails the run with a clear error (persisted as `run.error`). ' +
        'Returns when the turn finishes; the full event chain (prompt, deltas, tool/permission decisions, usage) is persisted and queryable. ' +
        'Requires the provider env credential (`credentialEnv`) to be present in the server process env.',
      body: {
        type: 'object',
        properties: {
          taskOverride: { type: 'string', description: 'Overrides task.prompt from the definition', example: 'Reply with exactly: SERVE-API-OK' },
          auditLevel: { type: 'string', enum: ['minimal', 'default', 'full'], description: 'Audit verbosity for this run (default from AUDIT_LEVEL env)', default: 'default' },
        },
      },
      response: { 200: runResultSchema, 404: { ...errorSchema, description: 'Unknown agent id' }, 500: { ...errorSchema, description: 'Run failed (missing credential, provider error, runtime error)' } },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });
    const definition = JSON.parse(agent.definition_json as string);
    const { taskOverride, auditLevel } = (req.body ?? {}) as { taskOverride?: string; auditLevel?: 'minimal' | 'default' | 'full' };
    mkdirSync('./runs', { recursive: true });
    try {
      const { registry, tools } = mcpRegistryFromDb(db);
      // Serialize: chain each run onto the previous one so concurrent POSTs queue cleanly.
      const queued = runChain.then(() => executeRun({ definition, agentId: id, definitionHash: 'serve', db, taskOverride, auditLevel, streamOut: () => {}, mcpRegistry: registry, mcpRegistryTools: tools }));
      runChain = queued.catch(() => {}); // keep the chain alive after failures
      return await queued;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.get('/api/runs', {
    schema: {
      tags: ['runs'],
      summary: 'List recent runs',
      description: 'Newest first, max 100. Filter by `?agentId=`. No response schema: run rows are free-form.',
      querystring: { type: 'object', properties: { agentId: { type: 'string', example: 'mimo-smoke-test@1.0.0' } } },
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

  // ---------- MCP registry ----------
  const mcpBodySchema = {
    type: 'object',
    required: ['name', 'config'],
    properties: {
      name: { type: 'string', minLength: 1, description: 'Registry key referenced by definitions (mcp.use).', example: 'inventory-echo' },
      description: { type: 'string', example: 'Echo server for testing MCP integrations' },
      config: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['local', 'stdio', 'http', 'sse'] },
          command: { type: 'string', example: 'node' },
          args: { type: 'array', items: { type: 'string' }, example: ['-e', 'console.log(1)'] },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          cwd: { type: 'string' },
          url: { type: 'string', example: 'https://api.githubcopilot.com/mcp/' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' }, example: ['*'] },
          timeoutMs: { type: 'integer', minimum: 1, example: 10000 },
        },
      },
      probe: { type: 'boolean', description: 'If true, connect now and store the discovered tool list.', default: false },
    },
  } as const;

  app.post('/api/mcp', {
    schema: {
      tags: ['mcp'],
      summary: 'Register / update an MCP server',
      description:
        'Persists the config in the registry. Definitions then reference it by name via `mcp.use: ["name"]` or `{"name":"…","allow":[…],"deny":[…],"disabled":true}`. ' +
        '`probe:true` validates config shape AND connects now (stdio handshake or HTTP initialize+tools/list), storing the tool list. Uperting keeps the existing tool list unless a new probe replaces it.',
      body: mcpBodySchema,
      // no 200 response schema: config/tools are free-form (serializer would strip them)
      response: {
        400: { ...errorSchema, description: 'Missing name/config, invalid type, command/url missing, probe failed' },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string; config?: unknown; probe?: boolean };
    if (!body.name) return reply.code(400).send({ error: 'name is required' });
    if (!body.config) return reply.code(400).send({ error: 'config is required' });
    try {
      const { config } = await validateMcpConfig(body.config);
      let toolsJson: string | undefined;
      let tools: McpTool[] = [];
      if (body.probe) {
        tools = await probeMcpTools(config);
        toolsJson = JSON.stringify(tools);
        db.updateMcpServerTools(body.name, toolsJson);
      }
      const status = `registered${body.probe ? ` (tools discovered: ${tools.length})` : ''}`;
      if (!body.probe) {
        // preserve any previously stored tools on plain re-register
        const existing = db.getMcpServer(body.name);
        toolsJson = existing?.tools_json ?? undefined;
      }
      db.saveMcpServer({ name: body.name, config_json: JSON.stringify(config), description: body.description, tools_json: toolsJson });
      return { name: body.name, status, config, tools: (toolsJson ? JSON.parse(toolsJson) : []).map((t: { name: string }) => ({ name: t.name })) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/mcp/probe', {
    schema: {
      tags: ['mcp'],
      summary: 'Probe tool discovery for an inline config (not persisted)',
      description: 'Connects live using the posted config and returns the discovered tools. Used by the MCP UI page for preview before registering.',
      body: { type: 'object', required: ['config'], properties: { config: { type: 'object' } } },
      response: {
        400: { ...errorSchema, description: 'Invalid config or connection failure' },
      },
    },
  }, async (req, reply) => {
    const { config } = (req.body ?? {}) as { config?: unknown };
    if (!config) return reply.code(400).send({ error: 'config is required' });
    try {
      const tools = await probeMcpTools(config);
      return { count: tools.length, tools };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/mcp', {
    schema: {
      tags: ['mcp'],
      summary: 'List registered MCP servers',
      description: 'Each entry includes its stored tool list (if probed).',
      response: {
        200: {
          type: 'object',
          properties: {
            servers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'inventory-echo' },
                  description: { type: 'string' },
                  tools_json: { type: 'string' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => ({ servers: db.listMcpServers() }));

  app.get('/api/mcp/:name', {
    schema: {
      tags: ['mcp'],
      summary: 'Inspect one registered MCP server',
      description: 'Returns config JSON, description, and the stored (discovered) tool list with input schemas. No 200 response schema: tools are free-form.',
      response: {
        404: { ...errorSchema, description: 'Unknown server name' },
      },
    },
  }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const srv = db.getMcpServer(name);
    if (!srv) return reply.code(404).send({ error: `mcp server not found: ${name}` });
    const tools: unknown[] = srv.tools_json ? JSON.parse(srv.tools_json) : [];
    return { name: srv.name, description: srv.description, config_json: srv.config_json, tools, created_at: srv.created_at };
  });

  app.post('/api/mcp/:name/tools', {
    schema: {
      tags: ['mcp'],
      summary: 'Probe (discover) tools for a registered server',
      description: 'Connects live (stdio handshake or HTTP initialize+tools/list), refreshes the stored tool list, and returns it. No 200 response schema: tool inputSchema is free-form.',
      response: {
        404: { ...errorSchema, description: 'Unknown server name' },
        400: { ...errorSchema, description: 'Probe failed (spawn error, timeout, HTTP error)' },
      },
    },
  }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const srv = db.getMcpServer(name);
    if (!srv) return reply.code(404).send({ error: `mcp server not found: ${name}` });
    try {
      const tools = await probeMcpTools(JSON.parse(srv.config_json));
      db.updateMcpServerTools(name, JSON.stringify(tools));
      return { name, count: tools.length, tools };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete('/api/mcp/:name', {
    schema: {
      tags: ['mcp'],
      summary: 'Delete a registered MCP server',
      description: 'Removes it from the registry. Definitions still referencing it via mcp.use will fail at run time with a clear error.',
      response: { 200: { type: 'object', properties: { deleted: { type: 'boolean', example: true }, name: { type: 'string' } } }, 404: errorSchema },
    },
  }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!db.deleteMcpServer(name)) return reply.code(404).send({ error: `mcp server not found: ${name}` });
    return { deleted: true, name };
  });

  // ---------- templates (UI helper) ----------
  app.get('/api/templates/default', {
    schema: {
      tags: ['agents'],
      summary: 'Fixture definition template',
      description: 'Returns the bundled working example so the UI can preload it. 404 if the fixture file is missing. No 200 response schema: definitions are free-form.',
      response: { 404: errorSchema },
    },
  }, async (_req, reply) => {
    try {
      const { definition } = loadAgentDefinition(FIXTURE_PATH);
      return redactedForLog(definition);
    } catch {
      return reply.code(404).send({ error: 'fixture template not found' });
    }
  });

  // ---------- metrics (dashboard) ----------
  const metricsSchema = {
    type: 'object',
    properties: {
      agents: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          latest: { type: 'string' },
          byRuns: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, runs: { type: 'integer' } } } },
        },
      },
      runs: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          last24h: { type: 'integer' },
          finished: { type: 'integer' },
          succeeded: { type: 'integer' },
          byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
      usage: {
        type: 'object',
        properties: {
          tokensIn: { type: ['integer', 'null'] },
          tokensOut: { type: ['integer', 'null'] },
          credits: { type: ['number', 'null'] },
          avgDurationMs: { type: ['number', 'null'] },
          rows: { type: 'integer' },
        },
      },
      mcp: { type: 'object', properties: { total: { type: 'integer' } } },
      recentRuns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, agent_id: { type: 'string' }, status: { type: 'string' },
            model: { type: 'string' }, created_at: { type: 'string' }, durationMs: { type: ['number', 'null'] },
          },
        },
      },
    },
  } as const;

  app.get('/api/metrics', {
    schema: { tags: ['system'], summary: 'Dashboard metrics (agents, runs, usage, recents)', response: { 200: metricsSchema } },
  }, async () => {
    const agents = db.listAgents();
    const runs = db.listRuns() as { id: string; agent_id: string; status: string; model: string; created_at: string }[];
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const last24h = runs.filter((r) => Date.parse(r.created_at) >= cutoff).length;
    const byStatus: Record<string, number> = {};
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const finished = runs.filter((r) => r.status === 'done' || r.status === 'failed' || r.status === 'aborted').length;
    const succeeded = runs.filter((r) => r.status === 'done').length;
    const byRuns = new Map<string, number>();
    for (const r of runs) byRuns.set(r.agent_id, (byRuns.get(r.agent_id) ?? 0) + 1);
    const usage = db.usageSummary();
    const recentRuns = runs.slice(0, 8).map((r) => ({ id: r.id, agent_id: r.agent_id, status: r.status, model: r.model, created_at: r.created_at }));
    return {
      agents: {
        total: agents.length,
        latest: agents[0]?.id,
        byRuns: [...byRuns.entries()].map(([id, n]) => ({ id, runs: n })).sort((a, b) => b.runs - a.runs),
      },
      runs: { total: runs.length, last24h, finished, succeeded, byStatus },
      usage: usage,
      mcp: { total: db.listMcpServers().length },
      recentRuns,
    };
  });

  // ---------- UI ----------
  const notFoundPage = (what: string, backHref: string, backLabel: string) =>
    pageShell({
      title: 'Not found', crumb: 'Not found', path: '',
      body: `<div class="card"><div class="alert err"><b>✕</b><div><b>${esc(what)} not found.</b> <a href="${backHref}">${backLabel} →</a></div></div></div>`,
    });
  app.get('/', async (_req, reply) => reply.type('text/html').send(dashboardPage(db)));
  app.get('/ui', async (_req, reply) => reply.type('text/html').send(editorPage(db)));
  app.get('/ui/agents', async (_req, reply) => reply.type('text/html').send(agentsPage(db)));
  app.get('/ui/agents/:id', async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).type('text/html').send(notFoundPage(`Agent ${id}`, '/ui/agents', 'All agents'));
    reply.type('text/html').send(agentDetailPage(agent as { id: string; name: string; version: string; definition_json: string; created_at: string }, db));
  });
  app.get('/ui/runs', async (_req, reply) => reply.type('text/html').send(runsPage(db)));
  app.get('/ui/runs/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = db.getRun(id);
    if (!run) return reply.code(404).type('text/html').send(notFoundPage(`Run ${id}`, '/ui/runs', 'All runs'));
    reply.type('text/html').send(runDetailPage(run as Record<string, unknown>, db));
  });
  app.get('/ui/sessions', async (_req, reply) => reply.type('text/html').send(sessionsPage(db)));
  app.get('/ui/sessions/:sid', async (req, reply) => {
    const sid = decodeURIComponent((req.params as { sid: string }).sid);
    const s = db.getSession(sid);
    if (!s) return reply.code(404).type('text/html').send(notFoundPage(`Session ${sid}`, '/ui/sessions', 'All sessions'));
    reply.type('text/html').send(sessionDetailPage(s as Record<string, unknown>, db));
  });
  app.get('/ui/mcp', async (_req, reply) => reply.type('text/html').send(mcpPage(db)));
  app.get('/ui/mcp/:name', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const srv = db.getMcpServer(name);
    if (!srv) return reply.code(404).type('text/html').send(notFoundPage(`MCP server ${name}`, '/ui/mcp', 'All servers'));
    reply.type('text/html').send(mcpDetailPage(name, srv, db));
  });

  return { app, db };
}

// ---------- UI helpers kept server-side ----------
/** Build the runtime MCP registry from the DB: registered configs + discovered tool names. */
function mcpRegistryFromDb(db: SqliteAdapter): { registry: Map<string, McpServerConfig>; tools: Map<string, string[]> } {
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
}
