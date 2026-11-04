import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDefinitionObject, hydrateAgentDefinition } from '../src/agents/loader.js';
import { toSessionOptions, modelListing } from '../src/agents/translator.js';
import { toSdkMcpConfig } from '../src/mcp/mcp.js';
import { SqliteAdapter } from '../src/store/sqlite.js';
import type { AgentDefinition } from '../src/core/types.js';

const dir = mkdtempSync(join(tmpdir(), 'definition-hydration-'));

beforeAll(() => {
  process.env.HYDRO_KEY = 'sk-hydro-key';
  process.env.HYDRO_BASE = 'https://env-host/v1';
  process.env.HYDRO_TOKEN = 'hydro-token-value';
});
afterAll(() => {
  delete process.env.HYDRO_KEY;
  delete process.env.HYDRO_BASE;
  delete process.env.HYDRO_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});

const base = (): Record<string, unknown> => ({
  schemaVersion: '1.0',
  metadata: { name: 'hydrate-test', version: '1.0.0' },
  task: { prompt: 'hi' },
  provider: { type: 'openai', baseUrl: '${HYDRO_BASE}', model: 'm', providerApiKey: '${HYDRO_KEY}' },
  mcp: {
    servers: {
      remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer ${HYDRO_TOKEN}' } },
    },
  },
});

describe('portable storage + hydration', () => {
  it('validate keeps ${ENV_VAR} refs literal (portable) while resolved expands them', () => {
    const out = validateDefinitionObject(base());
    const remoteHeaders = (d: AgentDefinition): Record<string, string> | undefined =>
      (d.mcp?.servers?.remote as { headers?: Record<string, string> } | undefined)?.headers;
    // Portable form — this is exactly what gets persisted: refs intact, never baked.
    expect(out.definition.provider.baseUrl).toBe('${HYDRO_BASE}');
    expect(remoteHeaders(out.definition)?.Authorization).toBe('Bearer ${HYDRO_TOKEN}');
    // providerApiKey stays a token/ref in BOTH forms (resolveApiKey handles it).
    expect(out.definition.provider.providerApiKey).toBe('${HYDRO_KEY}');
    expect(out.resolved.provider.providerApiKey).toBe('${HYDRO_KEY}');
    // Resolved form — run-ready.
    expect(out.resolved.provider.baseUrl).toBe('https://env-host/v1');
    expect(remoteHeaders(out.resolved)?.Authorization).toBe('Bearer hydro-token-value');
  });

  it('definitionHash covers the portable form — hydrating a stored definition rehashes identically', () => {
    const out = validateDefinitionObject(base());
    const rehydrated = hydrateAgentDefinition(JSON.stringify(out.definition));
    expect(rehydrated.definitionHash).toBe(out.definitionHash);
    expect(rehydrated.definitionHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hydrateAgentDefinition rejects corrupt stored JSON with a storage-specific error', () => {
    expect(() => hydrateAgentDefinition('{not json')).toThrow(/Invalid definition JSON in storage/);
  });

  it('DB round trip: stored refs resolve on hydrate, and DB edits are the customization path', () => {
    const out = validateDefinitionObject(base());
    const db = new SqliteAdapter(join(dir, 'hydro.db'));
    try {
      const id = db.saveAgent('hydrate-test', '1.0.0', JSON.stringify(out.definition), out.definitionHash);
      const row = db.getAgent(id)!;
      // What lands in the DB keeps refs intact — env values are never persisted.
      expect(row.definition_json).toContain('${HYDRO_BASE}');
      expect(row.definition_json).not.toContain('https://env-host/v1');
      const hyd = hydrateAgentDefinition(row.definition_json);
      expect(hyd.resolved.provider.baseUrl).toBe('https://env-host/v1');
      // Editing the DB row is the customization path — the next hydrate reflects it.
      const edited = { ...out.definition, provider: { ...out.definition.provider, model: 'm2' } };
      expect(db.updateAgentDefinition(id, JSON.stringify(edited), 'h2')).toBe(true);
      expect(hydrateAgentDefinition(db.getAgent(id)!.definition_json).resolved.provider.model).toBe('m2');
    } finally {
      db.close();
    }
  });
});

describe('schema v1.1 — curated Copilot SDK parity fields', () => {
  const v11 = (): Record<string, unknown> => ({
    ...base(),
    instructions: { directories: ['./.github/instructions'] },
    tools: {
      defaultAgentExcluded: ['bash'],
      custom: [{ name: 'lookup', description: 'd', parametersSchema: { type: 'object' }, defer: 'auto', overridesBuiltInTool: true, isTerminal: true, namespace: 'ops', metadata: { k: 1 } }],
    },
    runtime: {
      reasoningEffort: 'high',
      capi: { autoTier: 'efficiency' },
      modelCapabilities: { vision: true, reasoningEffort: true, maxContextWindowTokens: 200000 },
      trustWorkingDirectory: 'session',
      autopilot: { continuationEnabled: true, maxContinues: 3 },
    },
    mcp: {
      servers: {
        remote: {
          type: 'http', url: 'https://mcp.example/mcp', authType: 'oauth',
          oauthClientId: 'cid', oauthScopes: ['mcp:read'], oauthPublicClient: true, oauthGrantType: 'authorization_code', timeout: 5000,
        },
        local: { type: 'local', command: 'node', args: ['s.js'], workingDirectory: './srv', timeoutMs: 1000 },
      },
    },
  });

  it('accepts every added field (and autopilot as boolean or options object)', () => {
    expect(() => validateDefinitionObject(v11())).not.toThrow();
    expect(() => validateDefinitionObject({ ...base(), runtime: { autopilot: true } })).not.toThrow();
  });

  it('maps the new fields through toSessionOptions', () => {
    const o = toSessionOptions(validateDefinitionObject(v11()).resolved, 'K');
    expect(o.reasoningEffort).toBe('high');
    expect(o.capi).toEqual({ autoTier: 'efficiency' });
    expect(o.trustWorkingDirectory).toBe('session');
    expect(o.instructionDirectories).toEqual(['./.github/instructions']);
    expect(o.defaultAgent).toEqual({ excludedTools: ['bash'] });
    expect(o.autopilot).toEqual({ continuationEnabled: true, maxContinues: 3 });
    const tool = (o.tools as { name: string; defer?: string; overridesBuiltInTool?: boolean; isTerminal?: boolean; namespace?: string; metadata?: unknown }[]).find((t) => t.name === 'lookup');
    expect(tool).toMatchObject({ name: 'lookup', defer: 'auto', overridesBuiltInTool: true, isTerminal: true, namespace: 'ops', metadata: { k: 1 } });
  });

  it('maps custom-tool defer default to never when unset', () => {
    const def = {
      ...base(),
      tools: { custom: [{ name: 'plain', description: 'd', parametersSchema: { type: 'object' } }] },
    };
    const o = toSessionOptions(validateDefinitionObject(def).resolved, 'K');
    const tool = (o.tools as { name: string; defer?: string }[]).find((t) => t.name === 'plain');
    expect(tool?.defer).toBe('never');
  });

  it('modelListing advertises definition-driven capabilities instead of hardcoded caps', () => {
    const plain = validateDefinitionObject(base()).resolved;
    expect(modelListing(plain)).toEqual({
      id: 'm',
      name: 'm',
      capabilities: { supports: { vision: false, reasoningEffort: false } },
      limits: { max_context_window_tokens: 128000 },
    });
    const caps = validateDefinitionObject(v11()).resolved;
    expect(modelListing(caps)).toMatchObject({
      capabilities: { supports: { vision: true, reasoningEffort: true } },
      limits: { max_context_window_tokens: 200000 },
    });
  });

  it('toSdkMcpConfig passes remote OAuth fields through and maps workingDirectory/timeout', () => {
    const remote = toSdkMcpConfig({ type: 'http', url: 'https://mcp.example/mcp', authType: 'oauth', oauthClientId: 'cid', oauthScopes: ['mcp:read'], oauthPublicClient: true, oauthGrantType: 'authorization_code', timeout: 5000 });
    expect(remote).toMatchObject({ type: 'http', url: 'https://mcp.example/mcp', oauthClientId: 'cid', oauthScopes: ['mcp:read'], oauthPublicClient: true, oauthGrantType: 'authorization_code', timeout: 5000 });
    const local = toSdkMcpConfig({ type: 'local', command: 'node', workingDirectory: './srv', timeoutMs: 1000 } as never);
    expect(local).toMatchObject({ type: 'local', command: 'node', workingDirectory: './srv', timeout: 1000 });
    // Host-side auth method is not an SDK field — it must not leak into the session config.
    expect(remote).not.toHaveProperty('authType');
  });
});
