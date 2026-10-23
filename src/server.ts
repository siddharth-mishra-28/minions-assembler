import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { SqliteAdapter } from './store/sqlite.js';
import { resolveWorkspace, ServerLog } from './core/workspace.js';
import { PKG } from './core/pkg.js';
import { RunQueue } from './core/run-queue.js';
import { registerSystemRoutes } from './http/routes-system.js';
import { registerAgentRoutes } from './http/routes-agents.js';
import { registerRunRoutes } from './http/routes-runs.js';
import { registerMcpRoutes } from './http/routes-mcp.js';
import { registerChatRoutes } from './http/routes-chat.js';
import { registerUiRoutes } from './http/routes-ui.js';
import { registerWebApp } from './http/web-static.js';
import { registerPlatformRoutes } from './http/routes-platform.js';
import { registerSecurity } from './http/security.js';
import { PlatformStore } from './store/platform.js';
import { ChatHub } from './execution/chat-hub.js';
import { ApprovalBroker } from './execution/approvals.js';
import { ChatEngine } from './execution/chat-engine.js';
import { RetentionService } from './execution/retention.js';
import type { McpServerConfig } from './mcp/mcp.js';
import { dirname, join, resolve } from 'node:path';

export type { DbAdapter } from './store/adapter.js';

/**
 * Composition root. Builds the Fastify app, wires cross-cutting concerns (audit hook,
 * validation-error shaping, Swagger), then registers each route group from its own
 * clearly-owned module:
 *
 *   routes-system.ts    — health, audit logs, OpenAPI doc, provider probes, credentials, metrics
 *   routes-agents.ts    — agent definitions: CRUD, drafts, export, Elaborate, wizard helpers
 *   routes-runs.ts      — agent execution (stored id + inline) and run/session audit reads
 *   routes-mcp.ts       — MCP registry, live probes (+ LLM diagnose/auto-fix), browser OAuth
 *   routes-chat.ts      — persistent chat threads with registered agents (multi-turn)
 *   routes-ui.ts        — server-rendered HTML screens
 *
 * Shared state has one owner: the SQLite adapter lives in `db`, all SDK run
 * serialization goes through the RunQueue, per-flow state (pending OAuth) is owned by
 * its route module closure. Data flows: HTTP route module → adapter — nothing else.
 */
export async function buildServer(dbPath = './data/minion.db') {
  const db = new SqliteAdapter(dbPath);
  // One SDK session executes at a time (each run spawns a Go child); every run
  // route chains through the RunQueue in submission order.
  const runQueue = new RunQueue();

  const workspace = resolveWorkspace(); // server-wide: MINION_WORKSPACE env > cwd (definition override is per-run, applied in the runner)
  const serverLog = new ServerLog(workspace.root);
  serverLog.write('info', 'server.start', { db: dbPath, workspace: workspace.root, workspaceSource: workspace.source });
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { strict: false } /* allow example/summary keywords in route schemas */ },
    // Cap request payloads (definitions are small JSON; transcripts spill to disk not bodies)
    bodyLimit: 2 * 1024 * 1024,
    // Long-running work (Elaborate LLM calls, multi-turn agent runs) must NOT have the
    // socket yanked out from under them. A 30s connectionTimeout was killing every
    // generation slower than ~30s — that was the residual "Elaborate fails at times" flake.
    // 0 disables the inactivity kill; per-request budgets are enforced by
    // AbortSignal.timeout in the elaborate handler and turnTimeoutMs in the runner.
    connectionTimeout: 0,
    requestTimeout: 0,
    keepAliveTimeout: 120_000,
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

  registerSecurity(app);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Minions Assembler API',
        version: PKG.version,
        description:
          'Define, run, and audit custom GitHub Copilot agents from versioned JSON definitions.\n\n' +
          '**Auth:** none (loopback-only by default; front with a proxy + token before shared exposure).\n' +
          '**Credentials:** `provider.providerApiKey` is the fixed credential attribute. Literal keys are sealed to AES-256-GCM `enc:v1:` tokens before they are stored; `${ENV_VAR}` references resolve at run time. Legacy `credentialEnv` is still accepted.\n' +
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

  await registerSystemRoutes(app, { db, dbPath, workspace, serverLog, app });
  await registerRunRoutes(app, { db, runQueue });
  await registerMcpRoutes(app, { db });
  const mcpRegistry = (): { registry: Map<string, McpServerConfig>; tools: Map<string, string[]> } => {
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
  const platform = new PlatformStore(db);
  await registerAgentRoutes(app, { db, platform });
  const hub = new ChatHub();
  const broker = new ApprovalBroker(platform, hub);
  const auditRoot = resolve(join(dirname(resolve(dbPath)), 'audit'));
  const retention = new RetentionService(platform, { auditRoot, workspaceRoot: workspace.root });
  const engine = new ChatEngine({ db, platform, hub, broker, workspaceRoot: workspace.root, auditRoot, mcpRegistry });
  await registerPlatformRoutes(app, { platform, broker, retention });
  await registerChatRoutes(app, { db, platform, engine, hub, broker });
  await registerUiRoutes(app, { db });
  await registerWebApp(app);

  retention.start();
  app.addHook('onClose', async () => { retention.stop(); });

  return { app, db, platform, hub, broker, engine, retention };
}
