import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { PKG } from '../core/pkg.js';
import { providerAuthHeaders } from '../agents/provider-keys.js';
import { discoverProjectAgents } from '../agents/default-agent.js';
import type { PlatformStore } from '../store/platform.js';
import type { ApprovalBroker } from '../execution/approvals.js';
import type { RetentionService } from '../execution/retention.js';
import { errorSchema } from './route-schemas.js';

const providerBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    type: { type: 'string', enum: ['openai', 'azure', 'anthropic'] },
    baseUrl: { type: 'string', minLength: 1 },
    defaultModel: { type: ['string', 'null'] },
    apiKey: { type: 'string', description: 'Write-only. Stored in the encrypted credential vault; never returned.' },
    wireApi: { type: ['string', 'null'], enum: ['completions', 'responses', null] },
    azureApiVersion: { type: ['string', 'null'] },
    makeDefault: { type: 'boolean' },
  },
} as const;

const modelNames = (j: { data?: unknown[]; models?: unknown[] }): string[] => {
  const items = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return items.map((m) => typeof m === 'string' ? m : (m as { id?: string; name?: string })?.id || (m as { name?: string })?.name).filter((m): m is string => !!m);
};

/** Settings, providers, projects (+ folder browser), approvals, retention and bootstrap status for the web app. */
export async function registerPlatformRoutes(
  app: FastifyInstance,
  ctx: { platform: PlatformStore; broker: ApprovalBroker; retention: RetentionService },
): Promise<void> {
  const { platform, broker, retention } = ctx;

  const probeProvider = async (id: string): Promise<{ ok: boolean; models: string[]; error?: string; status?: number }> => {
    const p = platform.getProvider(id);
    if (!p) return { ok: false, models: [], error: 'provider not found', status: 404 };
    const key = platform.getProviderSecret(id);
    if (!key) return { ok: false, models: [], error: 'No API key saved for this provider.', status: 400 };
    const url = `${p.baseUrl.replace(/\/+$/, '')}/models`;
    try {
      const res = await fetch(url, { headers: providerAuthHeaders(p.type, key), signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) return { ok: false, models: [], error: `Authentication failed (HTTP ${res.status}) - the API key was rejected.`, status: 400 };
      if (!res.ok) return { ok: false, models: [], error: `Provider returned HTTP ${res.status} for GET ${url}`, status: 400 };
      return { ok: true, models: modelNames(await res.json() as { data?: unknown[] }) };
    } catch (e) {
      return { ok: false, models: [], error: `Failed to reach ${url}: ${(e as Error).message}`, status: 400 };
    }
  };

  // ---------- bootstrap ----------
  app.get('/api/bootstrap', { schema: { tags: ['platform'], summary: 'First-load state for the web app (onboarding, default provider, projects)' } }, async () => {
    const settings = platform.getSettings();
    const providers = platform.listProviders();
    const def = platform.getDefaultProvider();
    return {
      version: PKG.version,
      onboardingCompleted: settings.onboarding.completed || providers.length > 0,
      providerCount: providers.length,
      defaultProvider: def ? { id: def.id, name: def.name, defaultModel: def.defaultModel, hasKey: def.hasKey } : null,
      projectCount: platform.listProjects().length,
      settings,
      tokenRequired: !!process.env.MINION_API_TOKEN,
    };
  });

  // ---------- settings ----------
  app.get('/api/settings', { schema: { tags: ['platform'], summary: 'Application settings (retention, approvals, defaults, audit)' } }, async () => platform.getSettings());
  app.patch('/api/settings', {
    schema: {
      tags: ['platform'],
      summary: 'Update settings (partial, per-section merge)',
      body: {
        type: 'object',
        properties: {
          retention: { type: 'object', properties: { days: { type: 'integer', minimum: 0, maximum: 3650 }, scope: { type: 'string', enum: ['everything', 'chats'] }, keepPinned: { type: 'boolean' } } },
          approvals: { type: 'object', properties: { chatMode: { type: 'string', enum: ['interactive', 'autopilot', 'strict'] }, timeoutSec: { type: 'integer', minimum: 10, maximum: 3600 } } },
          defaults: { type: 'object', properties: { providerId: { type: ['string', 'null'] }, model: { type: ['string', 'null'] }, systemPrompt: { type: 'string', maxLength: 20000 } } },
          audit: { type: 'object', properties: { level: { type: 'string', enum: ['minimal', 'standard', 'full'] } } },
          onboarding: { type: 'object', properties: { completed: { type: 'boolean' } } },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => platform.updateSettings(req.body));

  // ---------- providers ----------
  app.get('/api/providers', { schema: { tags: ['platform'], summary: 'List configured providers (keys are never returned; `hasKey` only)' } }, async () => ({ providers: platform.listProviders() }));
  app.post('/api/providers', {
    schema: { tags: ['platform'], summary: 'Add a provider', body: { ...providerBody, required: ['name', 'baseUrl'] }, response: { 400: errorSchema } },
  }, async (req, reply) => {
    const b = req.body as Parameters<PlatformStore['createProvider']>[0];
    try { new URL(b.baseUrl); } catch { return reply.code(400).send({ error: 'baseUrl must be a valid URL' }); }
    return platform.createProvider(b);
  });
  app.patch('/api/providers/:id', { schema: { tags: ['platform'], summary: 'Update a provider (omit apiKey to keep the stored key)', body: providerBody, response: { 404: errorSchema } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = platform.updateProvider(id, req.body as Parameters<PlatformStore['updateProvider']>[1]);
    return p ?? reply.code(404).send({ error: `provider not found: ${id}` });
  });
  app.delete('/api/providers/:id', { schema: { tags: ['platform'], summary: 'Delete a provider and its stored key', response: { 404: errorSchema } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return platform.deleteProvider(id) ? { deleted: true } : reply.code(404).send({ error: `provider not found: ${id}` });
  });
  app.post('/api/providers/:id/default', { schema: { tags: ['platform'], summary: 'Make this the default provider', response: { 404: errorSchema } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return platform.setDefaultProvider(id) ? { ok: true } : reply.code(404).send({ error: `provider not found: ${id}` });
  });
  app.post('/api/providers/:id/test', { schema: { tags: ['platform'], summary: 'Test a saved provider and discover its models' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await probeProvider(id);
    if (!r.ok) return reply.code(r.status ?? 400).send({ ok: false, error: r.error });
    return { ok: true, models: r.models, message: `Connected. ${r.models.length} model(s) available.` };
  });
  app.get('/api/providers/:id/models', { schema: { tags: ['platform'], summary: 'Models offered by a saved provider' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await probeProvider(id);
    if (!r.ok) return reply.code(r.status ?? 400).send({ error: r.error });
    return { models: r.models };
  });

  // ---------- projects ----------
  app.get('/api/projects', { schema: { tags: ['platform'], summary: 'Recent projects (most recently opened first)' } }, async () => ({ projects: platform.listProjects() }));
  app.post('/api/projects', {
    schema: { tags: ['platform'], summary: 'Open a folder as a project', body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 }, name: { type: 'string' } } }, response: { 400: errorSchema } },
  }, async (req, reply) => {
    const b = req.body as { path: string; name?: string };
    try { return platform.openProject(b.path, b.name); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.patch('/api/projects/:id', { schema: { tags: ['platform'], summary: 'Rename a project or edit its settings', body: { type: 'object', properties: { name: { type: 'string' }, settings: { type: 'object' } } }, response: { 404: errorSchema } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return platform.updateProject(id, req.body as { name?: string; settings?: Record<string, unknown> }) ?? reply.code(404).send({ error: `project not found: ${id}` });
  });
  app.delete('/api/projects/:id', { schema: { tags: ['platform'], summary: 'Remove a project from the list (files and chat history are untouched)', response: { 404: errorSchema } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return platform.deleteProject(id) ? { deleted: true } : reply.code(404).send({ error: `project not found: ${id}` });
  });
  app.get('/api/projects/:id/agents', { schema: { tags: ['platform'], summary: 'Agent profiles found in <project>/.github/agents', response: { 404: errorSchema } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = platform.getProject(id);
    if (!p) return reply.code(404).send({ error: `project not found: ${id}` });
    return { agents: discoverProjectAgents(p).map(({ file: _file, ...a }) => a) };
  });

  // Folder picker backing store: lists sub-directories only (never file names or contents).
  app.get('/api/fs/browse', {
    schema: { tags: ['platform'], summary: 'List sub-directories of a folder (server-side folder picker)', querystring: { type: 'object', properties: { path: { type: 'string' }, hidden: { type: 'boolean' } } }, response: { 400: errorSchema } },
  }, async (req, reply) => {
    const q = req.query as { path?: string; hidden?: boolean };
    const home = homedir();
    if (!q.path) {
      const roots = process.platform === 'win32'
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => existsSync(d))
        : ['/'];
      return { path: '', parent: null, home, roots, entries: roots.map((r) => ({ name: r, path: r })) };
    }
    const abs = resolve(q.path);
    try {
      if (!statSync(abs).isDirectory()) return reply.code(400).send({ error: `Not a directory: ${abs}` });
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (q.hidden || !d.name.startsWith('.')) && d.name !== 'node_modules' && !d.name.startsWith('$'))
        .map((d) => ({ name: d.name, path: join(abs, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, 500);
      const parent = parse(abs).root === abs ? '' : dirname(abs);
      return { path: abs, parent, home, isGitRepo: existsSync(join(abs, '.git')), entries };
    } catch (e) {
      return reply.code(400).send({ error: `Cannot open ${abs}: ${(e as Error).message}` });
    }
  });

  // ---------- approvals ----------
  app.get('/api/approvals', { schema: { tags: ['platform'], summary: 'Approval requests (audit trail)', querystring: { type: 'object', properties: { threadId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer' } } } } }, async (req) => {
    const q = req.query as { threadId?: string; status?: string; limit?: number };
    return { approvals: platform.listApprovals(q) };
  });
  app.post('/api/approvals/:id', {
    schema: {
      tags: ['platform'],
      summary: 'Allow or deny a pending tool-approval request',
      body: { type: 'object', required: ['allow'], properties: { allow: { type: 'boolean' }, scope: { type: 'string', enum: ['once', 'chat', 'project'] } } },
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { allow: boolean; scope?: 'once' | 'chat' | 'project' };
    return broker.decide(id, b.allow, b.scope ?? 'once') ? { ok: true } : reply.code(404).send({ error: 'approval not found or already settled' });
  });

  // ---------- retention ----------
  app.get('/api/retention', { schema: { tags: ['platform'], summary: 'Retention settings and the last sweep result' } }, async () => ({ settings: platform.getSettings().retention, lastRun: retention.lastRun ?? null }));
  app.post('/api/retention/purge', {
    schema: { tags: ['platform'], summary: 'Run the retention sweep now', body: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 3650 } } } },
  }, async (req) => {
    const b = (req.body ?? {}) as { days?: number };
    return retention.runOnce(b.days ? { days: b.days } : undefined);
  });

  // ---------- metrics (survive retention purges via daily rollups) ----------
  app.get('/api/metrics/daily', { schema: { tags: ['platform'], summary: 'Per-day run/token totals (live + rolled-up history)', querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 } } } } }, async (req) => {
    const q = req.query as { days?: number };
    return { days: platform.dailyMetrics(q.days ?? 30), purgedTotals: platform.rollupTotals() };
  });

  // ---------- audit ----------
  app.get('/api/audit/runs', {
    schema: { tags: ['platform'], summary: 'Audit trail: every run (chat turns and headless) with filters', querystring: { type: 'object', properties: {
      source: { type: 'string', enum: ['chat', 'run'] }, status: { type: 'string' }, agentId: { type: 'string' }, projectId: { type: 'string' }, threadId: { type: 'string' },
      q: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } } } },
  }, async (req) => platform.listAuditRuns(req.query as Record<string, never>));

  app.get('/api/audit/runs/:id/export', {
    schema: { tags: ['platform'], summary: 'Download the full audit bundle (run, usage, events, approvals) as JSON', response: { 404: { type: 'object', properties: { error: { type: 'string' } } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = platform.auditBundle(id);
    if (!b) return reply.code(404).send({ error: `run not found: ${id}` });
    reply.header('content-disposition', `attachment; filename="audit-${id}.json"`);
    return b;
  });
}
