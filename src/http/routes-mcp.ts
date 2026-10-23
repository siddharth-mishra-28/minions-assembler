import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { validateMcpConfig, probeMcpTools, sealMcpSecrets } from '../mcp/mcp.js';
import type { McpTool, AuthHint, McpServerConfig } from '../mcp/mcp.js';
import type { DbAdapter } from '../store/adapter.js';
import { encryptToToken, resolveProviderApiKeyValue } from '../core/crypto.js';
import { errorSchema } from './route-schemas.js';
import { esc } from '../ui/ui-util.js';

/**
 * MCP registry route group: register/list/probe/delete MCP servers, LLM-assisted probe
 * diagnosis + auto-fix, and browser OAuth authorization for http/sse servers.
 * The pending-OAuth flow map is owned by this module's closure (per-server lifetime,
 * exactly what the in-file map had inside buildServer).
 */
export async function registerMcpRoutes(app: FastifyInstance, ctx: { db: DbAdapter }): Promise<void> {
  const { db } = ctx;

  const mcpBodySchema = {
    type: 'object',
    required: ['name', 'config'],
    properties: {
      name: { type: 'string', minLength: 1, description: 'Registry key referenced by definitions (mcp.use).', example: 'inventory-echo' },
      description: { type: 'string', example: 'Echo server for testing MCP integrations' },
      config: {
        type: 'object',
        properties: {
          // `type` is optional: inferred from shape (command → local, url → http) when omitted.
          type: { type: 'string', enum: ['local', 'stdio', 'http', 'sse'] },
          command: { type: 'string', example: 'node' },
          args: { type: 'array', items: { type: 'string' }, example: ['-e', 'console.log(1)'] },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          cwd: { type: 'string' },
          workingDirectory: { type: 'string' },
          url: { type: 'string', example: 'https://api.githubcopilot.com/mcp/' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' }, example: ['*'] },
          timeoutMs: { type: 'integer', minimum: 1, example: 10000 },
          timeout: { type: 'integer', minimum: 1 },
          // Claude Desktop / Cursor style wrapper: {"mcpServers": {name: cfg}} — unwrapped server-side.
          mcpServers: { type: 'object', additionalProperties: true, description: 'Optional wrapper form; single-entry wrappers are unwrapped automatically.' },
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
      const config = sealMcpSecrets((await validateMcpConfig(body.config)).config);
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
        400: { type: 'object', properties: { error: { type: 'string' }, diagnosis: { type: 'string' }, diagnosisModel: { type: 'string' }, autoFix: { type: 'object', additionalProperties: true }, authHint: { type: 'object', additionalProperties: true } }, description: 'Probe failure; may carry authHint, an LLM diagnosis, and an autoFix (LLM-repaired config, re-probed; persisted on re-probe success for registered servers)' },
      },
    },
  }, async (req, reply) => {
    const { config } = (req.body ?? {}) as { config?: unknown };
    if (!config) return reply.code(400).send({ error: 'config is required' });
    try {
      const tools = await probeMcpTools(config);
      return { count: tools.length, tools };
    } catch (e) {
      const hint = (e as { authHint?: AuthHint }).authHint;
      const msg = (e as Error).message;
      const diag = await llmDiagnoseProbeFailure(db, config, msg, hint).catch(() => null);
      let autoFix: { config: unknown; probed: boolean; count: number; model: string; error?: string } | undefined;
      // Agent-style repair loop: let the LLM propose a corrected config, then validate + re-probe it.
      const fix = await llmAutoFixConfig(db, config, msg, hint).catch(() => null);
      if (fix) {
        let probed = false, count = 0, probeError: string | undefined;
        try {
          const { config: validatedFix } = await validateMcpConfig(fix.config);
          const tools2 = await probeMcpTools(validatedFix);
          probed = true; count = tools2.length;
        } catch (pe) { probeError = (pe as Error).message; }
        autoFix = { config: fix.config, probed, count, model: fix.model, ...(probeError ? { error: probeError } : {}) };
      }
      return reply.code(400).send({ error: msg, ...(hint ? { authHint: hint } : {}), ...(diag ? { diagnosis: diag.diagnosis, diagnosisModel: diag.model } : {}), ...(autoFix ? { autoFix } : {}) });
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
        400: { type: 'object', properties: { error: { type: 'string' }, diagnosis: { type: 'string' }, diagnosisModel: { type: 'string' }, autoFix: { type: 'object', additionalProperties: true }, authHint: { type: 'object', additionalProperties: true } }, description: 'Probe failure; may carry authHint, an LLM diagnosis, and an autoFix (LLM-repaired config, re-probed; persisted on re-probe success for registered servers)' },
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
      const hint = (e as { authHint?: AuthHint }).authHint;
      const msg = (e as Error).message;
      let parsedConfig: unknown = null;
      try { parsedConfig = JSON.parse(srv.config_json); } catch { /* unparseable stored config */ }
      const diag = await llmDiagnoseProbeFailure(db, parsedConfig, msg, hint).catch(() => null);
      let autoFix: { config: unknown; probed: boolean; count: number; model: string; error?: string; saved?: boolean } | undefined;
      const fix = await llmAutoFixConfig(db, parsedConfig, msg, hint).catch(() => null);
      if (fix) {
        let probed = false, count = 0, probeError: string | undefined;
        try {
          const { config: validatedFix } = await validateMcpConfig(fix.config);
          const tools2 = await probeMcpTools(validatedFix);
          probed = true; count = tools2.length;
          // Success: persist the repaired config + freshly discovered tools automatically.
          db.saveMcpServer({ name, config_json: JSON.stringify(validatedFix) });
          db.updateMcpServerTools(name, JSON.stringify(tools2));
        } catch (pe) { probeError = (pe as Error).message; }
        autoFix = { config: fix.config, probed, count, model: fix.model, saved: probed, ...(probeError ? { error: probeError } : {}) };
      }
      return reply.code(400).send({ error: msg, ...(hint ? { authHint: hint } : {}), ...(diag ? { diagnosis: diag.diagnosis, diagnosisModel: diag.model } : {}), ...(autoFix ? { autoFix } : {}) });
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

  // ---------- OAuth browser authorization for http/sse MCP servers ----------
  // Pending browser flows: state → context (memory only; the verifier never touches disk unsealed).
  const pendingOauth = new Map<string, {
    verifier: string; resource: string; issuer: string; serverUrl: string;
    clientId: string; clientSecret?: string; redirectUri: string; scopes: string[];
    registerAs?: string; description?: string; created: number;
  }>();

  app.post('/api/mcp/oauth/start', {
    schema: {
      tags: ['mcp'],
      summary: 'Begin browser OAuth for an http/sse MCP server',
      description:
        'Discovers RFC 9728 protected-resource + RFC 8414 authorization-server metadata for `url`, then returns the authorization URL to open in a browser. ' +
        'Authorization Code + PKCE (S256) with the MCP `resource` parameter; completes at GET /api/mcp/oauth/callback. ' +
        '`clientId` is required for servers without dynamic client registration (GitHub has none): paste a preshared OAuth client id. `registerAs` stores the resulting token, sealed, in the MCP registry under that name.',
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'MCP server endpoint (http/sse)', example: 'https://api.githubcopilot.com/mcp/' },
          registerAs: { type: 'string', description: 'Registry name to save the sealed token into on success', example: 'github-mcp' },
          description: { type: 'string', description: 'Optional description used when registering' },
          clientId: { type: 'string', description: 'Preshared OAuth client id (required when the server lacks DCR)' },
          clientSecret: { type: 'string', description: 'Optional client secret (confidential client)' },
          scopes: { type: 'array', items: { type: 'string' }, description: 'Overrides discovered scopes_supported' },
          redirectUri: { type: 'string', description: 'Overrides the default loopback callback URI' },
        },
      },
      response: { 400: errorSchema },
    },
  }, async (req, reply) => {
    const b = (req.body ?? {}) as { url?: string; registerAs?: string; description?: string; clientId?: string; clientSecret?: string; scopes?: string[]; redirectUri?: string };
    if (!b.url) return reply.code(400).send({ error: 'url is required' });
    try {
      const u = new URL(b.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('url must be http(s)');
      const { discoverProtectedResourceMetadata, fetchAuthorizationServerMetadata, makePkcePair, buildAuthorizeUrl } = await import('../mcp/oauth.js');
      // 1) protected-resource metadata (fall back to root path-specific without a challenge)
      const prm = await discoverProtectedResourceMetadata(b.url);
      const issuer = prm?.authorization_servers?.[0];
      if (!issuer) {
        throw new Error(`No OAuth authorization server discovered for ${b.url} (no /.well-known/oauth-protected-resource metadata). This server likely needs a static token: set headers.Authorization in its config instead.`);
      }
      // 2) authorization-server metadata (PKCE required by the MCP spec)
      const as = await fetchAuthorizationServerMetadata(issuer);
      if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256')) {
        throw new Error(`Authorization server does not advertise S256 PKCE (methods: ${as.code_challenge_methods_supported.join(', ')}) — MCP requires S256`);
      }
      // 3) client id: preshared, else RFC 7591 dynamic registration when advertised
      let clientId = b.clientId?.trim() || '';
      let clientSecret = b.clientSecret?.trim() || undefined;
      if (!clientId && as.registration_endpoint) {
        const dcr = await fetch(as.registration_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_name: 'Minions Cockpit (minions-assembler)',
            redirect_uris: [b.redirectUri || callbackOrigin(req)],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: clientSecret ? 'client_secret_basic' : 'none',
          }),
        });
        if (dcr.ok) {
          const j = await dcr.json() as { client_id?: string; client_secret?: string };
          if (j.client_id) { clientId = j.client_id; clientSecret = j.client_secret ?? clientSecret; }
        }
      }
      if (!clientId) {
        throw new Error(`No client id available. ${as.registration_endpoint ? 'Dynamic registration was attempted but failed' : 'This authorization server does not support dynamic client registration (e.g. GitHub)'} — pass clientId (a preshared OAuth app client id) in the request body.`);
      }
      const redirectUri = b.redirectUri?.trim() || callbackOrigin(req);
      const { verifier, challenge } = makePkcePair();
      const state = randomUUID();
      const resource = prm?.resource as string | undefined || u.origin + u.pathname.replace(/\/+$/, '');
      const scopes = b.scopes?.length ? b.scopes : (prm?.scopes_supported as string[] | undefined) ?? [];
      const authorizeUrl = buildAuthorizeUrl({ authorizationEndpoint: as.authorization_endpoint, clientId, redirectUri, resource, scopes, state, codeChallenge: challenge });
      pendingOauth.set(state, {
        verifier, resource, issuer, serverUrl: b.url,
        clientId, clientSecret, redirectUri, scopes,
        ...(b.registerAs ? { registerAs: b.registerAs.trim() } : {}),
        ...(b.description ? { description: b.description } : {}),
        created: Date.now(),
      });
      // GC stale pending flows after 15 minutes.
      for (const [k, v] of pendingOauth) if (Date.now() - v.created > 15 * 60_000) pendingOauth.delete(k);
      return {
        authorizeUrl,
        state,
        issuer,
        resource,
        scopes,
        clientId,
        registered_via_dcr: !b.clientId,
        ...(prm?.resource_name ? { resource_name: prm.resource_name } : {}),
      };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/mcp/oauth/callback', {
    schema: { tags: ['mcp'], summary: 'OAuth redirect target (browser return)', description: 'Exchanges the authorization code (PKCE) and stores the token sealed in the registry when registerAs was provided. Returns a tiny self-closing page.' },
  }, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const fail = (msg: string) => reply.code(400).type('text/html').send(`<html><body style="font-family:sans-serif;padding:2rem"><b>OAuth failed:</b> ${esc(msg)}<br><script>setTimeout(function(){window.close()},4000)</script></body></html>`);
    if (q.error) return fail(`${q.error}${q.error_description ? ' — ' + q.error_description : ''}`);
    if (!q.code || !q.state) return fail('missing code/state in callback');
    const flow = pendingOauth.get(q.state);
    if (!flow) return fail('unknown or expired OAuth flow (state) — start again from the MCP page');
    pendingOauth.delete(q.state);
    try {
      const { requestToken, fetchAuthorizationServerMetadata } = await import('../mcp/oauth.js');
      const as = await fetchAuthorizationServerMetadata(flow.issuer);
      const tok = await requestToken({
        tokenEndpoint: as.token_endpoint,
        grantType: 'authorization_code',
        clientId: flow.clientId,
        ...(flow.clientSecret ? { clientSecret: flow.clientSecret } : {}),
        redirectUri: flow.redirectUri,
        resource: flow.resource,
        ...(flow.scopes.length ? { scopes: flow.scopes } : {}),
        code: q.code,
        codeVerifier: flow.verifier,
      });
      // Store sealed: Authorization: Bearer enc:v1:… never persists in plaintext.
      const sealed = `Bearer ${encryptToToken(tok.access_token)}`;
      let savedAs: string | null = null;
      if (flow.registerAs) {
        db.saveMcpServer({
          name: flow.registerAs,
          config_json: JSON.stringify({ type: 'http', url: flow.serverUrl, headers: { Authorization: sealed } }),
          description: flow.description || `OAuth-authorized ${flow.issuer}`,
        });
        savedAs = flow.registerAs;
      }
      return reply.type('text/html').send(`<html><body style="font-family:sans-serif;padding:2rem"><b>✓ MCP server authorized.</b>${savedAs ? ` Token stored sealed in registry as <code>${esc(savedAs)}</code>. Probing again should now list its tools.` : ''} You can close this tab.<script>setTimeout(function(){window.close()},3000)</script></body></html>`);
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  app.get('/api/mcp/oauth/status', {
    schema: { tags: ['mcp'], summary: 'Pending OAuth browser flows', description: 'Lists pending (awaiting-browser) OAuth flows for diagnostics.' },
  }, async () => ({ pending: [...pendingOauth.entries()].map(([state, f]) => ({ state, issuer: f.issuer, resource: f.resource, serverUrl: f.serverUrl, registerAs: f.registerAs ?? null, ageSec: Math.round((Date.now() - f.created) / 1000) })) }));
}

/** Loopback origin to use as the OAuth redirect_uri default (exact callback route). */
function callbackOrigin(req: { protocol?: string; hostname?: string; headers?: Record<string, unknown> }): string {
  const proto = req.protocol ?? 'http';
  // Prefer the raw Host header (keeps the port — providers require an exact redirect_uri match).
  const host = (req.headers?.host as string) || req.hostname || `127.0.0.1:${process.env.PORT ?? 3100}`;
  return `${proto}://${host}/api/mcp/oauth/callback`;
}

/**
 * Agent-style auto-fix: after a probe failure, ask the LLM for a **corrected MCP config**
 * (not prose), validate it with the same rules users must pass, and re-probe. On success
 * the route persists the fixed config — servers become usable without manual editing,
 * regardless of transport (stdio/local/http/sse) or auth style.
 */
async function llmAutoFixConfig(db: DbAdapter, config: unknown, errMessage: string, authHint: unknown): Promise<{ config: Record<string, unknown>; model: string } | null> {
  for (const meta of db.listAgents() as unknown as { id: string }[]) {
    const row = db.getAgent(meta.id) as { definition_json: string } | undefined;
    if (!row?.definition_json) continue;
    let provider: { type?: string; baseUrl?: string; model?: string; providerApiKey?: string } | null = null;
    try { provider = (JSON.parse(row.definition_json) as { provider?: { type?: string; baseUrl?: string; model?: string; providerApiKey?: string } }).provider ?? null; } catch { continue; }
    if (!provider?.baseUrl || !provider.model || !provider.providerApiKey) continue;
    try {
      const key = resolveProviderApiKeyValue(provider.providerApiKey);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (provider.type === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${key}`;
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const isAnthropic = provider.type === 'anthropic';
      const sys = 'You repair MCP (Model Context Protocol) server configs. Respond with ONLY the corrected single-server config as raw JSON — no markdown fences, no commentary. Allowed fields: type ("local"|"stdio"|"http"|"sse"), command/args/env/cwd (stdio), url/headers (http/sse), tools (array), timeoutMs. If authentication failed, set the correct header shape, e.g. "headers": { "Authorization": "Bearer ${ENV_VAR_NAME}" } using an env-var placeholder — never invent a literal token value. Keep it minimal: do not add speculative fields.';
      const user = `Config that failed probing:\n${JSON.stringify(config, null, 2)}\n\nProbe error:\n${errMessage}\n\n${authHint ? `Auth challenge details:\n${JSON.stringify(authHint, null, 2)}\n\n` : ''}Return the corrected config JSON only.`;
      const body = isAnthropic
        ? { model: provider.model, max_tokens: 800, system: sys, messages: [{ role: 'user', content: user }] }
        : { model: provider.model, max_tokens: 800, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
      const res = await fetch(`${base}/${isAnthropic ? 'messages' : 'chat/completions'}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const j = await res.json() as { choices?: { message?: { content?: string } }[]; content?: { type: string; text?: string }[] };
      const raw = isAnthropic
        ? (j.content ?? []).map((c) => c.text ?? '').join('\n')
        : (j.choices?.[0]?.message?.content ?? '');
      // Parse defensively: raw JSON, or the first fenced block.
      const cand = raw.replace(/```(?:json)?/gi, '').trim();
      const start = cand.indexOf('{');
      const end = cand.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      const fixed = JSON.parse(cand.slice(start, end + 1)) as Record<string, unknown>;
      // Reject things that are not a server config; strip wrappers like {"servers":{…}}.
      const wrapped = fixed as { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> };
      const inner = wrapped.servers ?? wrapped.mcpServers;
      const finalCfg = inner && typeof inner === 'object' ? Object.values(inner)[0] : fixed;
      if (!finalCfg || typeof finalCfg !== 'object') return null;
      return { config: finalCfg as Record<string, unknown>, model: provider.model };
    } catch { return null; }
  }
  return null;
}

/**
 * LLM-powered probe diagnosis (best-effort, never masks the real error).
 * Uses the provider configured on any saved agent definition (BYOK, key resolved
 * in memory only). Sends a redacted config + the failure details and asks for a
 * concise, concrete fix (e.g. the exact header/shape the server expects).
 */
async function llmDiagnoseProbeFailure(db: DbAdapter, config: unknown, errMessage: string, authHint: unknown): Promise<{ diagnosis: string; model: string } | null> {
  // Redact anything secret-looking before it leaves the process.
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return /gh[pousr]_|sk-|Bearer |authorization/i.test(v) ? '<redacted>' : v.length > 200 ? v.slice(0, 200) + '…' : v;
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [/authorization|token|secret|password|key/i.test(k) ? 'headers.Authorization' : k, scrub(x)]));
    return v;
  };
  for (const meta of db.listAgents() as unknown as { id: string }[]) {
    const row = db.getAgent(meta.id) as { definition_json: string } | undefined;
    if (!row?.definition_json) continue;
    let provider: { type?: string; baseUrl?: string; model?: string; providerApiKey?: string } | null = null;
    try { provider = (JSON.parse(row.definition_json) as { provider?: { type?: string; baseUrl?: string; model?: string; providerApiKey?: string } }).provider ?? null; } catch { continue; }
    if (!provider?.baseUrl || !provider.model || !provider.providerApiKey) continue;
    try {
      const key = resolveProviderApiKeyValue(provider.providerApiKey);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (provider.type === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${key}`;
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const isAnthropic = provider.type === 'anthropic';
      const sys = 'You are an MCP (Model Context Protocol) integration expert. Diagnose why a probe of an MCP server failed and give a minimal, concrete fix. Answer in at most 120 words, imperative, no preamble. If the fix is a corrected config JSON, include it in one fenced block. Never invent credentials.';
      const user = `MCP server config (secrets redacted):\n${JSON.stringify(scrub(config), null, 2)}\n\nProbe error:\n${errMessage}\n\n${authHint ? `Server auth challenge details:\n${JSON.stringify(scrub(authHint), null, 2)}\n\n` : ''}Explain the most likely cause and the exact next step (header to add, scope to request, URL to fix, or corrected config).`;
      const body = isAnthropic
        ? { model: provider.model, max_tokens: 600, system: sys, messages: [{ role: 'user', content: user }] }
        : { model: provider.model, max_tokens: 600, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
      const res = await fetch(`${base}/${isAnthropic ? 'messages' : 'chat/completions'}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const j = await res.json() as { choices?: { message?: { content?: string } }[]; content?: { type: string; text?: string }[] };
      const text = isAnthropic
        ? (j.content ?? []).map((c) => c.text ?? '').join('\n').trim()
        : (j.choices?.[0]?.message?.content ?? '').trim();
      if (text) return { diagnosis: text, model: provider.model };
      return null;
    } catch { return null; } // first usable provider only; diagnosis is best-effort
  }
  return null;
}
