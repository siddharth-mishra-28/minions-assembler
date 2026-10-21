import type { FastifyInstance } from 'fastify';
import { PKG } from '../core/pkg.js';
import type { DbAdapter } from '../store/adapter.js';
import { errorSchema } from './route-schemas.js';
import { resolveProviderKey, providerAuthHeaders } from '../agents/provider-keys.js';

/**
 * System route group: health/status, structured audit-log reading, OpenAPI document,
 * provider connectivity probes (models listing + live credential test), stored
 * credentials, and dashboard metrics.
 */
export async function registerSystemRoutes(
  app: FastifyInstance,
  ctx: { db: DbAdapter; dbPath: string; workspace: { root: string; source: string }; serverLog: { path: string | null }; app: FastifyInstance },
): Promise<void> {
  const { db, dbPath, workspace, serverLog, app: fastify } = ctx;

  const statusSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'minions-assembler' },
      version: { type: 'string', example: '1.0.0' },
      sdk: { type: 'string', example: '@github/copilot-sdk' },
      db: { type: 'string', example: './data/minion.db' },
      uptime: { type: 'number', example: 42.5 },
      workspace: { type: 'string', example: 'D:/dev/agent-workspaces' },
      workspaceSource: { type: 'string', example: 'env' },
      logFile: { type: 'string', example: 'D:/dev/agent-workspaces/.minion/server.log.jsonl' },
    },
  };

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

  app.get('/openapi.json', async (_req, reply) => reply.send(fastify.swagger()));

  app.get('/api/providers/models', {
    schema: {
      tags: ['system'],
      summary: 'List available models from provider',
      querystring: {
        type: 'object',
        required: ['baseUrl'],
        properties: {
          baseUrl: { type: 'string' },
          providerApiKey: { type: 'string' },
          credentialEnv: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const q = req.query as { baseUrl?: string; providerApiKey?: string; credentialEnv?: string; type?: string };
    if (!q.baseUrl) return reply.code(400).send({ error: 'baseUrl is required' });
    const resolved = resolveProviderKey(q);
    if (resolved.error) return reply.code(400).send({ error: resolved.error });
    const cleanUrl = q.baseUrl.replace(/\/+$/, '');
    const headers = providerAuthHeaders(q.type, resolved.key);
    try {
      const res = await fetch(`${cleanUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) {
        return reply.code(400).send({ error: `Authentication failed (HTTP ${res.status}) — the API key was rejected by the provider.` });
      }
      if (!res.ok) return reply.code(400).send({ error: `Provider returned HTTP ${res.status} ${res.statusText} for GET ${cleanUrl}/models` });
      const j = await res.json() as { data?: unknown[]; models?: unknown[] };
      const items = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
      const models = items.map((m: unknown) => typeof m === 'string' ? m : (m as { id?: string; name?: string })?.id || (m as { name?: string })?.name).filter(Boolean);
      return { models, count: models.length };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/providers/test', {
    schema: {
      tags: ['system'],
      summary: 'Test provider connection and discover models',
      body: {
        type: 'object',
        required: ['baseUrl'],
        properties: {
          type: { type: 'string' },
          baseUrl: { type: 'string' },
          providerApiKey: { type: 'string', description: 'enc:v1: token, ${ENV_VAR} ref, or literal key' },
          credentialEnv: { type: 'string' },
          apiKey: { type: 'string', description: 'Raw key alias for providerApiKey' },
          model: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as { type?: string; baseUrl: string; providerApiKey?: string; credentialEnv?: string; apiKey?: string; model?: string };

    const resolved = resolveProviderKey(body);
    if (resolved.error) return reply.code(400).send({ error: resolved.error });
    const key = resolved.key;
    const cleanUrl = body.baseUrl.replace(/\/+$/, '');
    const headers = providerAuthHeaders(body.type, key);
    const authFail = (status: number) =>
      reply.code(400).send({ ok: false, error: `Authentication failed (HTTP ${status}) — the API key was rejected by ${cleanUrl}.` });

    // 1. OpenAI/Anthropic-style model discovery
    let modelsStatus = 0;
    try {
      const res = await fetch(`${cleanUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json() as { data?: unknown[]; models?: unknown[] };
        const items = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
        const models = items.map((m: unknown) => typeof m === 'string' ? m : (m as { id?: string; name?: string })?.id || (m as { name?: string })?.name).filter(Boolean);
        return {
          ok: true,
          message: `Connected successfully! Discovered ${models.length} model(s).`,
          models,
        };
      }
      if (res.status === 401 || res.status === 403) return authFail(res.status);
      modelsStatus = res.status;
    } catch (e) {
      return reply.code(400).send({ ok: false, error: `Failed to reach ${cleanUrl}/models: ${(e as Error).message}` });
    }

    // 2. Models listing missing/unavailable — verify the credential with a real
    //    minimal completion when a model is known. Never report bare HTTP
    //    statuses (including 404) as success.
    const model = body.model?.trim();
    if (model) {
      const isAnthropic = body.type === 'anthropic';
      const completeUrl = `${cleanUrl}/${isAnthropic ? 'messages' : 'chat/completions'}`;
      const completeBody = isAnthropic
        ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
        : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      try {
        const res = await fetch(completeUrl, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(completeBody),
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) {
          return {
            ok: true,
            message: `Connected — credential verified with a live completion on "${model}". (Models list endpoint returned HTTP ${modelsStatus || 'unavailable'}, so type models manually if needed.)`,
            models: [],
          };
        }
        if (res.status === 401 || res.status === 403) return authFail(res.status);
        const errText = await res.text().catch(() => '');
        const hint = res.status === 404 ? ' — endpoint not found. Check the Base URL.' : '';
        return reply.code(400).send({
          ok: false,
          error: `Provider rejected the test call (HTTP ${res.status})${hint} ${errText.slice(0, 240)}`.trim(),
        });
      } catch (e) {
        return reply.code(400).send({ ok: false, error: `Completion probe failed: ${(e as Error).message}` });
      }
    }

    // 3. Nothing succeeded and no model to verify against.
    return reply.code(400).send({
      ok: false,
      error: `Models list unavailable (GET ${cleanUrl}/models → HTTP ${modelsStatus}) and no model was set to verify against. Check the Base URL (expected an OpenAI-compatible /models endpoint) or enter a model to run a live credential check.`,
    });
  });

  // ---------- credentials (encrypted at rest) ----------
  app.get('/api/credentials', {
    schema: { tags: ['system'], summary: 'List stored credential names (never secrets)' },
  }, async () => ({ credentials: db.listCredentials() }));

  app.post('/api/credentials', {
    schema: {
      tags: ['system'],
      summary: 'Store a provider API key encrypted in the local DB',
      body: {
        type: 'object',
        required: ['name', 'secret'],
        properties: { name: { type: 'string', minLength: 1 }, secret: { type: 'string', minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    const { name, secret } = req.body as { name: string; secret: string };
    const clean = name.trim();
    if (!clean) return reply.code(400).send({ error: 'credential name is required' });
    if (!secret) return reply.code(400).send({ error: 'secret is required' });
    db.saveCredential(clean, secret);
    return { name: clean, saved: true };
  });

  app.delete('/api/credentials/:name', {
    schema: {
      tags: ['system'],
      summary: 'Delete a stored credential',
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    if (!db.deleteCredential(name)) return reply.code(404).send({ error: `No stored credential named "${name}"` });
    return { name, deleted: true };
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
      totals: {
        type: 'object',
        properties: {
          requests: { type: 'integer', description: 'Cumulative agent requests (runs started)' },
          responses: { type: 'integer', description: 'Cumulative finished responses (done|failed|aborted)' },
          succeeded: { type: 'integer' },
          failed: { type: 'integer' },
        },
      },
      timeline: {
        type: 'array',
        description: 'Hourly request/response buckets for the last 24h (oldest first)',
        items: {
          type: 'object',
          properties: {
            hour: { type: 'string' }, requests: { type: 'integer' }, succeeded: { type: 'integer' },
            failed: { type: 'integer' }, running: { type: 'integer' },
          },
        },
      },
      byModel: {
        type: 'array',
        description: 'Per-model effectiveness rollup',
        items: {
          type: 'object',
          properties: {
            model: { type: 'string' }, requests: { type: 'integer' }, succeeded: { type: 'integer' },
            failed: { type: 'integer' }, avgDurationMs: { type: ['number', 'null'] },
            tokensIn: { type: ['number', 'null'] }, tokensOut: { type: ['number', 'null'] },
          },
        },
      },
    },
  } as const;

  app.get('/api/metrics', {
    schema: { tags: ['system'], summary: 'Dashboard metrics (agents, runs, usage, timeline, model effectiveness)', response: { 200: metricsSchema } },
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
      totals: db.requestTotals(),
      timeline: db.runsTimeline(24),
      byModel: db.runsByModel(),
    };
  });
}
