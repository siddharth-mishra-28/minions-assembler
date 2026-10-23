import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { loadAgentDefinition, validateDefinitionObject, redactedForLog } from '../agents/loader.js';
import type { DbAdapter } from '../store/adapter.js';
import { errorSchema } from './route-schemas.js';
import { sealDefinitionSecrets, resolveProviderKey, providerAuthHeaders } from '../agents/provider-keys.js';
import { BUILTIN_TOOLS, BUILTIN_TOOLS_SOURCE } from '../agents/tools-policy.js';
import type { PlatformStore } from '../store/platform.js';
import { SECTION_CATALOG, captureDefaultSystemMessage } from '../agents/default-prompt.js';
import { parseAgentMarkdown, mdProfileToDefinition, loadAgentMarkdown, scanInstructionFiles } from '../agents/md-profile.js';

/**
 * Agents route group: validate/register/edit/delete agent definitions, drafts,
 * definition export, the wizard's Elaborate/Builtin-tools/Template helpers.
 * Provider-key sealing/resolution lives in provider-keys.ts.
 */
export async function registerAgentRoutes(app: FastifyInstance, ctx: { db: DbAdapter; platform?: PlatformStore }): Promise<void> {
  const { db } = ctx;

  const FIXTURE_PATH = './examples/expense-tracker-dev.agent.json';

  const intEnv = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  const floatEnv = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
  };

  const agentSummarySchema = {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'expense-tracker-dev@1.0.0' },
      name: { type: 'string', example: 'expense-tracker-dev' },
      version: { type: 'string', example: '1.0.0' },
      created_at: { type: 'string', example: '2026-10-11T13:23:16.580Z' },
    },
  };

  app.post('/api/agents', {
    schema: {
      tags: ['agents'],
      summary: 'Validate + register an agent definition',
      description:
        'Give either `definitionPath` (server-side file path — useful with curl) or `definition` (inline JSON object — used by the UI). ' +
        'Persists on success and returns the id (`name@version`), content hash, and warnings. ' +
        'A literal `provider.providerApiKey` is sealed to an AES-256-GCM `enc:v1:` token before storage; `${ENV_VAR}` refs are kept as-is.',
      body: {
        type: 'object',
        properties: {
          definitionPath: { type: 'string', description: 'Server-side path to a definition JSON file (mutually exclusive with `definition`)', example: './examples/expense-tracker-dev.agent.json' },
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
      // Seal literal secrets before they touch the DB. The persisted hash is the canonical
      // content hash of the UNSEALED definition (same value CLI validate reports) — hashing
      // the sealed form made it nondeterministic (AES-GCM random IV => new hash per registration).
      const sealed = sealDefinitionSecrets(load.definition);
      const sealedHash = load.definitionHash;
      const id = db.saveAgent(sealed.metadata.name, sealed.metadata.version, JSON.stringify(sealed), sealedHash);
      return { id, hash: sealedHash, warnings: load.warnings, definition: redactedForLog(sealed) };
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

  app.post('/api/agents/draft', {
    schema: {
      tags: ['agents'],
      summary: 'Save an agent definition as draft for re-use without publishing',
      description: 'Persists partial or complete agent definition with status draft. Does not appear on /ui/agents until published.',
      body: {
        type: 'object',
        required: ['definition'],
        properties: { definition: { type: 'object' } },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { definition?: Record<string, unknown> };
    if (!body.definition) return reply.code(400).send({ error: 'Body must include a definition object' });
    const sealed = sealDefinitionSecrets(body.definition) as { metadata?: { name?: string; version?: string } };
    const name = sealed.metadata?.name?.trim() || 'untitled-draft';
    const version = sealed.metadata?.version?.trim() || '0.1.0-draft';
    // Deterministic content hash of the unsealed definition (sealed form has a random-IV ciphertext).
    const hash = createHash('sha256').update(JSON.stringify(body.definition)).digest('hex').slice(0, 16);
    const id = db.saveAgent(name, version, JSON.stringify(sealed), hash, 'draft');
    return { id, name, version, hash, status: 'draft' };
  });

  app.get('/api/agents/drafts', {
    schema: {
      tags: ['agents'],
      summary: 'List saved draft agent definitions',
    },
  }, async () => ({ drafts: db.listAgents('draft') }));

  app.post('/api/templates/upload', {
    schema: {
      tags: ['agents'],
      summary: 'Validate uploaded definition JSON and return parsed fields',
      body: { type: 'object' },
    },
  }, async (req, reply) => {
    try {
      const load = validateDefinitionObject(req.body);
      return { definition: redactedForLog(load.definition), warnings: load.warnings, hash: load.definitionHash, valid: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/agents/elaborate', {
    schema: {
      tags: ['agents'],
      summary: 'Elaborate instructions, persona, prompt, or skills using configured LLM',
      description: 'Uses the configured provider to expand a field. `maxTokens`/`timeoutMs`/`temperature` override the ELABORATE_MAX_TOKENS / ELABORATE_TIMEOUT_MS / ELABORATE_TEMPERATURE env defaults.',
      body: {
        type: 'object',
        required: ['field', 'content', 'provider'],
        properties: {
          field: { type: 'string' },
          content: { type: 'string' },
          context: { type: 'object' },
          maxTokens: { type: 'integer', minimum: 16, maximum: 65536 },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          provider: {
            type: 'object',
            properties: {
              providerRef: { type: 'string', description: 'Id of a provider configured in Settings; supplies baseUrl, key and (if omitted) model' },
              type: { type: 'string' },
              baseUrl: { type: 'string' },
              model: { type: 'string' },
              providerApiKey: { type: 'string' },
              credentialEnv: { type: 'string' },
              apiKey: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as {
      field: string; content: string; context?: Record<string, unknown>;
      maxTokens?: number; timeoutMs?: number; temperature?: number;
      provider: { providerRef?: string; type?: string; baseUrl?: string; model?: string; providerApiKey?: string; credentialEnv?: string; apiKey?: string };
    };
    const { field, content, context, maxTokens, timeoutMs, temperature } = body;
    let provider = body.provider;
    if (provider.providerRef) {
      const p = ctx.platform?.getProvider(provider.providerRef);
      const secret = p ? ctx.platform?.getProviderSecret(p.id) : undefined;
      if (!p) return reply.code(400).send({ error: `Cannot elaborate: provider '${provider.providerRef}' not found` });
      if (!secret) return reply.code(400).send({ error: `Cannot elaborate: provider '${p.name}' has no API key` });
      provider = { ...provider, type: p.type, baseUrl: p.baseUrl, model: provider.model || p.defaultModel || undefined, apiKey: secret };
    }
    if (!provider.baseUrl || !provider.model) return reply.code(400).send({ error: 'Cannot elaborate: provider.baseUrl and provider.model are required (or pass provider.providerRef)' });
    const resolved = resolveProviderKey(provider as Parameters<typeof resolveProviderKey>[0]);
    if (resolved.error) return reply.code(400).send({ error: `Cannot elaborate: ${resolved.error}` });
    const key = resolved.key;
    const cleanUrl = provider.baseUrl.replace(/\/+$/, '');
    const agentName = (context as { metadata?: { name?: string } })?.metadata?.name || 'custom-agent';

    // Tunables: request body > env > default. Elaboration is a long-form generation,
    // so the defaults are generous — the old hard 30s cap killed every slow model.
    const effectiveMaxTokens = maxTokens ?? intEnv('ELABORATE_MAX_TOKENS', 4096);
    const effectiveTimeoutMs = timeoutMs ?? intEnv('ELABORATE_TIMEOUT_MS', 180000);
    const effectiveTemperature = temperature ?? floatEnv('ELABORATE_TEMPERATURE', 0.7);

    const systemPrompt = `You are an expert AI system architect and prompt engineer helping design a custom GitHub Copilot agent named "${agentName}".\nYour task is to take a draft or seed for a field (${field}) and expand/elaborate it into a highly detailed, professional, structured, production-ready version.\nKeep formatting clean using standard Markdown. Do not include meta-chatter or surrounding quotes; output ONLY the refined content for this field.`;

    const userPrompt = `Field: ${field}\nCurrent draft/instructions:\n${content || '(Empty - please generate a comprehensive starter template based on context)'}\n\nAgent Context:\n${JSON.stringify(context ?? {}, null, 2)}\n\nPlease elaborate and enhance this content for maximum clarity, depth, and actionable guidance for the agent.`;

    const isAnthropic = provider.type === 'anthropic';
    const requestUrl = `${cleanUrl}/${isAnthropic ? 'messages' : 'chat/completions'}`;
    const completeBody = isAnthropic
      ? {
          model: provider.model,
          max_tokens: effectiveMaxTokens,
          temperature: effectiveTemperature,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }
      : {
          model: provider.model,
          max_tokens: effectiveMaxTokens,
          temperature: effectiveTemperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        };

    // Transient-failure retry: network blips, 429s, and 5xx are common with slow
    // BYOK endpoints. Retry up to 2 times with backoff; never retry 4xx auth/input errors.
    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers = providerAuthHeaders(provider.type, key);
        headers['Content-Type'] = 'application/json';

        const res = await fetch(requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(completeBody),
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          const status = res.status;
          const snippet = errText.slice(0, 300);
          const retryable = status === 408 || status === 429 || status >= 500;
          const err = new Error(
            status === 401 || status === 403
              ? `Provider rejected the credential (HTTP ${status}). Check providerApiKey. ${snippet}`
              : status === 404
                ? `Provider endpoint not found (HTTP ${status}) at ${requestUrl}. Check Base URL (it should end in /v1 for OpenAI-compatible APIs) and that the model name is correct. ${snippet}`
                : status === 429
                  ? `Provider rate-limited the request (HTTP 429). Wait a moment and try again, or lower Max output tokens. ${snippet}`
                  : `LLM call failed (HTTP ${status}): ${snippet}`
          );
          (err as Error & { retryable?: boolean }).retryable = retryable;
          throw err;
        }
        const data = await res.json() as {
          choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
          content?: { type: string; text?: string }[];
        };
        let elaborated = '';
        if (isAnthropic) {
          elaborated = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
        } else {
          const raw = data.choices?.[0]?.message?.content;
          elaborated = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? raw.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join('\n').trim() : '';
        }
        if (!elaborated) {
          const err = new Error('Provider returned no text content. The model may have hit the max-token limit mid-generation, filtered the output, or returned only reasoning tokens. Raise Max output tokens or lower Temperature and try again.');
          (err as Error & { retryable?: boolean }).retryable = true;
          throw err;
        }
        return {
          elaborated,
          maxTokens: effectiveMaxTokens,
          timeoutMs: effectiveTimeoutMs,
          temperature: effectiveTemperature,
          attempts: attempt,
        };
      } catch (e) {
        const err = e as Error & { retryable?: boolean };
        lastError = err;
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        const retryable = err.retryable === true || isTimeout || (err as { cause?: { code?: string } }).cause?.code === 'ECONNRESET' || (err as { cause?: { code?: string } }).cause?.code === 'ETIMEDOUT' || /fetch failed|network|socket/i.test(err.message);
        if (attempt < maxAttempts && retryable) {
          // Back off briefly before the next try; long generations deserve a second chance.
          await new Promise((r) => setTimeout(r, attempt * 800));
          continue;
        }
        if (isTimeout) {
          return reply.code(400).send({
            error: `Elaboration timed out after ${effectiveTimeoutMs}ms (attempt ${attempt}/${maxAttempts}). Raise ELABORATE_TIMEOUT_MS (or pass timeoutMs), lower ELABORATE_MAX_TOKENS, or pick a faster model.`,
          });
        }
        return reply.code(400).send({ error: err.message, attempts: attempt });
      }
    }
    return reply.code(400).send({ error: lastError?.message || 'Elaboration failed' });
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

  app.get('/api/agents/:id/definition', {
    schema: {
      tags: ['agents'],
      summary: 'Export the raw definition JSON of a stored agent',
      description:
        'Returns exactly the stored definition JSON (byte-identical to what was saved, sealed enc:v1 tokens included so it round-trips locally). ' +
        '`?download=1` adds Content-Disposition attachment so browsers save it as `<name>-definition.json`. ' +
        'Note: enc:v1 tokens decrypt only with this machine\'s master key — the export is not portable across machines. Pass `?redact=1` to strip sealed tokens instead.',
      response: { 404: { ...errorSchema, description: 'Unknown agent id' }, 500: errorSchema },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });
    let def: Record<string, unknown>;
    try { def = JSON.parse(agent.definition_json as string) as Record<string, unknown>; } catch {
      return reply.code(500).send({ error: 'stored definition is not valid JSON (corrupt row)' });
    }
    const q = req.query as { download?: string; redact?: string };
    if (q.redact) {
      const strip = (v: unknown): unknown => {
        if (typeof v === 'string') return v.startsWith('enc:v1:') ? '<redacted>' : v;
        if (Array.isArray(v)) return v.map(strip);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, strip(x)]));
        return v;
      };
      def = strip(def) as Record<string, unknown>;
    }
    const json = JSON.stringify(def, null, 2) + '\n';
    if (q.download) {
      const name = String(agent.name || id).replace(/[^a-z0-9._-]+/gi, '-') || 'agent';
      reply.header('Content-Disposition', `attachment; filename="${name}-definition.json"`);
    }
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return reply.send(json);
  });

  app.put('/api/agents/:id', {
    schema: {
      tags: ['agents'],
      summary: 'Replace an agent definition in place (edit)',
      description:
        'Validates and seals the new definition exactly like POST /api/agents, then overwrites the stored row for this id. ' +
        'The id is `name@version` and is preserved — rename or re-version via POST /api/agents instead. ' +
        'Draft and published agents are both editable. Active runs keep the definition hash they started with.',
      body: {
        type: 'object',
        required: ['definition'],
        properties: { definition: { type: 'object', description: 'Full AgentDefinition v1.0 object' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            hash: { type: 'string' },
            status: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        400: { ...errorSchema, description: 'Invalid definition' },
        404: { ...errorSchema, description: 'Unknown agent id' },
      },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const existing = db.getAgent(id);
    if (!existing) return reply.code(404).send({ error: `agent not found: ${id}` });
    const body = (req.body ?? {}) as { definition?: unknown };
    if (!body.definition) return reply.code(400).send({ error: 'Body must include a definition object' });
    try {
      const load = validateDefinitionObject(body.definition);
      const sealed = sealDefinitionSecrets(load.definition);
      // Canonical unsealed content hash — identical to CLI validate / POST /api/agents for the same content.
      const sealedHash = load.definitionHash;
      // Id is fixed to the stored name@version so runs stay linked.
      db.updateAgentDefinition(id, JSON.stringify(sealed), sealedHash);
      return { id, hash: sealedHash, status: existing.status ?? 'published', warnings: load.warnings };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete('/api/agents/:id', {
    schema: {
      tags: ['agents'],
      summary: 'Delete an agent definition (draft or published)',
      description:
        'Safety check: refuses while the agent has active runs (status=running) or active sessions, returning 409 with the counts. ' +
        'Finished run/session history is left intact (it is the audit trail) — only the definition row is removed. ' +
        'Pass `?force=true` only when you are certain nothing is still executing.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { force: { type: 'boolean', default: false, description: 'Bypass the active-run/session safety check' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean', example: true },
            id: { type: 'string' },
            removedRuns: { type: 'integer', description: 'Historical run rows left in place (audit trail)' },
          },
        },
        404: { ...errorSchema, description: 'Unknown agent id' },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            activeRuns: { type: 'integer' },
            activeSessions: { type: 'integer' },
            totalRuns: { type: 'integer' },
            totalSessions: { type: 'integer' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });
    const force = (req.query as { force?: boolean }).force === true;
    const activity = db.agentActivity(id);
    if (!force && (activity.activeRuns > 0 || activity.activeSessions > 0)) {
      const parts: string[] = [];
      if (activity.activeRuns > 0) parts.push(`${activity.activeRuns} active run${activity.activeRuns === 1 ? '' : 's'}`);
      if (activity.activeSessions > 0) parts.push(`${activity.activeSessions} active session${activity.activeSessions === 1 ? '' : 's'}`);
      return reply.code(409).send({
        error: `Cannot delete "${id}" — it still has ${parts.join(' and ')}. Wait for them to finish (or abort them) and try again. Pass force=true to delete anyway.`,
        ...activity,
      });
    }
    db.deleteAgent(id);
    return { deleted: true, id, removedRuns: activity.totalRuns };
  });

  // ---------- builtin tools (for the wizard checkbox grid) ----------
  app.get('/api/builtin-tools', {
    schema: {
      tags: ['agents'],
      summary: 'Curated built-in CLI tool registry for the wizard',
      description: BUILTIN_TOOLS_SOURCE + ' Effective control uses source-qualified availableTools/excludedTools patterns; unlisted names are accepted as freeform.',
    },
  }, async () => ({ source: BUILTIN_TOOLS_SOURCE, tools: BUILTIN_TOOLS }));

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

  // ---------- workspace instruction files + markdown agent profiles ----------
  app.get('/api/workspace/instruction-files', {
    schema: {
      tags: ['agents'],
      summary: 'Detect AGENTS.md-style instruction files and .agent.md profiles in a workspace',
      description:
        'Read-only scan of the target working directory for the files regular GitHub Copilot picks up automatically: ' +
        'AGENTS.md / AGENTS.local.md / CLAUDE.md / .github/copilot-instructions.md (custom instructions — discovered natively by the Copilot CLI, no configuration needed) ' +
        'and custom agent profiles in .github/agents/*.agent.md (importable via POST /api/agents/import).',
      querystring: {
        type: 'object',
        properties: { workdir: { type: 'string', description: 'Directory to scan (defaults to the server working directory)' } },
      },
    },
  }, async (req) => {
    const q = req.query as { workdir?: string };
    return { workdir: q.workdir || process.cwd(), files: scanInstructionFiles(q.workdir || process.cwd()) };
  });

  app.post('/api/agents/import', {
    schema: {
      tags: ['agents'],
      summary: 'Import a markdown agent profile (.agent.md) and register it',
      description:
        'Regular GitHub Copilot custom-agent format: YAML frontmatter (name, description, version, model, tools, workingDirectory) + markdown body as the task prompt. ' +
        'The persona is left untouched so the agent runs on the default Copilot system prompt. Give either `markdown` (inline text) or `path` (server-side file).',
      body: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Inline .agent.md content (mutually exclusive with path)' },
          path: { type: 'string', description: 'Server-side path to a .agent.md file (mutually exclusive with markdown)' },
          register: { type: 'boolean', description: 'Persist the mapped definition (default true)', default: true },
        },
      },
      response: { 400: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { markdown?: string; path?: string; register?: boolean };
    if (body.markdown && body.path) return reply.code(400).send({ error: 'Provide either markdown or path, not both' });
    try {
      const { definition, profile } = body.path
        ? loadAgentMarkdown(body.path)
        : (() => { const p = parseAgentMarkdown(body.markdown ?? ''); return { definition: mdProfileToDefinition(p), profile: p }; })();
      const validated = validateDefinitionObject(definition);
      const defJson = JSON.stringify(sealDefinitionSecrets(validated.definition));
      // Canonical unsealed content hash (matches the CLI import-md command for the same profile).
      const hash = validated.definitionHash;
      let id: string | null = null;
      if (body.register !== false) {
        id = db.saveAgent(validated.definition.metadata.name, validated.definition.metadata.version, defJson, hash);
      }
      return { id, definitionHash: hash, warnings: validated.warnings, profile: { name: profile.name, description: profile.description, model: profile.model, tools: profile.tools }, definition: redactedForLog(validated.definition) };
    } catch (e) {
      return reply.code(400).send({ error: `import failed: ${(e as Error).message}` });
    }
  });

  // ---------- default Copilot system prompt (Persona wizard "customize" mode) ----------
  app.get('/api/persona/default-system-prompt', {
    schema: {
      tags: ['agents'],
      summary: 'Original default Copilot system prompt + section catalog',
      description:
        'Shows what the SDK-managed default Copilot CLI system prompt actually is, so `persona.systemMessage.mode: "customize"` can target its sections sighted. ' +
        '`sections` is the SYSTEM_MESSAGE_SECTIONS catalog from the installed @github/copilot-sdk (the anatomy of the default prompt). ' +
        '`capture` is the exact composed prompt a session WITHOUT persona.systemMessage receives on this machine — captured live by pointing a probe session ' +
        'at a loopback stub provider (no API key used, nothing leaves the machine; results cached ~5 min per working directory). ' +
        'Pass `capture=0` for a fast catalog-only response.',
      querystring: {
        type: 'object',
        properties: {
          workdir: { type: 'string', description: 'Working directory the probe session should run in (defaults to the server cwd) — environment_context reflects it' },
          capture: { type: 'string', enum: ['0', '1', 'false', 'true'], description: 'Set 0/false to skip the live capture and return only the section catalog', default: '1' },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { workdir?: string; capture?: string };
    const doCapture = q.capture !== '0' && q.capture !== 'false';
    const capture = doCapture ? await captureDefaultSystemMessage({ workdir: q.workdir }) : null;
    return {
      sections: SECTION_CATALOG,
      capture,
      note: 'The default prompt text is composed at runtime by the bundled Copilot CLI (sections vary slightly with tools/MCP/skills and environment). Section ids match SYSTEM_MESSAGE_SECTIONS and are exactly the keys `persona.systemMessage.sections` accepts.',
    };
  });
}
