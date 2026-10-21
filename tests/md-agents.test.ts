import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentMarkdown, mdProfileToDefinition, loadAgentMarkdown, scanInstructionFiles } from '../src/agents/md-profile.js';
import { readAgentsMdFiles, resolvePersona, toSessionOptions } from '../src/agents/translator.js';
import { validateDefinitionObject } from '../src/agents/loader.js';

const dir = mkdtempSync(join(tmpdir(), 'md-agents-'));

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ } });

describe('markdown agent profiles (.agent.md)', () => {
  it('parses frontmatter + prompt body', () => {
    const p = parseAgentMarkdown([
      '---',
      'name: Fullstack Dev',
      'description: Builds full-stack apps',
      'version: 2.1.0',
      'model: mimo-v2.6-flash',
      'tools: view, create, edit, bash',
      '---',
      'Build the app described below with tests.',
    ].join('\n'));
    expect(p.name).toBe('fullstack-dev');
    expect(p.description).toBe('Builds full-stack apps');
    expect(p.version).toBe('2.1.0');
    expect(p.model).toBe('mimo-v2.6-flash');
    expect(p.tools).toEqual(['view', 'create', 'edit', 'bash']);
    expect(p.prompt).toBe('Build the app described below with tests.');
  });

  it('works without frontmatter (whole file is the prompt)', () => {
    const p = parseAgentMarkdown('Just do the thing.\n\nMore detail here.', 'fallback-agent');
    expect(p.name).toBe('fallback-agent');
    expect(p.prompt).toContain('Just do the thing.');
  });

  it('rejects a profile with no prompt body', () => {
    expect(() => parseAgentMarkdown('---\nname: empty\n---\n')).toThrow(/no prompt body/i);
  });

  it('maps to a regular agent on the DEFAULT Copilot prompt (persona untouched)', () => {
    const def = mdProfileToDefinition(parseAgentMarkdown('---\nname: fullstack-dev\n---\nBuild a CRUD app.'));
    const validated = validateDefinitionObject(def);
    expect(validated.definition.persona).toBeUndefined();
    const persona = resolvePersona(validated.definition);
    expect(persona.systemMessage).toBeUndefined();
    expect(persona.defaultPromptIncluded).toBe(true);
    expect(validated.definition.task.prompt).toBe('Build a CRUD app.');
    // provider complete with env-var key reference — no secrets in the definition
    expect(validated.definition.provider.providerApiKey).toBe('${MIMO_API_KEY}');
  });

  it('loads a profile from disk via loadAgentMarkdown', () => {
    const file = join(dir, 'disk.agent.md');
    writeFileSync(file, '---\nname: disk-agent\n---\nDo disk things.');
    const { definition, profile } = loadAgentMarkdown(file);
    expect(profile.name).toBe('disk-agent');
    expect(definition.metadata.name).toBe('disk-agent');
  });
});

describe('AGENTS.md-style instruction files', () => {
  it('readAgentsMdFiles reads explicit paths relative to the working directory and skips missing', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nAlways write tests.');
    const out = readAgentsMdFiles(['AGENTS.md', 'does-not-exist.md'], dir);
    expect(out).toContain('Always write tests.');
    expect(readAgentsMdFiles(['nope.md'], dir)).toBeUndefined();
    expect(readAgentsMdFiles(undefined)).toBeUndefined();
  });

  it('agentsMdPaths lands in organizationCustomInstructions (system-prompt channel)', () => {
    writeFileSync(join(dir, 'GUIDE.md'), 'Cite file paths.');
    const def = {
      schemaVersion: '1.0' as const,
      metadata: { name: 't', version: '1.0.0' },
      task: { prompt: 'x' },
      provider: { type: 'openai' as const, baseUrl: 'https://u/v1', model: 'm', providerApiKey: '${LLM_API_KEY}' },
      knowledge: { workingDirectory: dir },
      instructions: { agentsMdPaths: ['GUIDE.md'] },
    };
    const opts = toSessionOptions(def, 'K');
    expect(String(opts.organizationCustomInstructions)).toContain('Cite file paths.');
  });

  it('scanInstructionFiles detects AGENTS.md / CLAUDE.md / copilot-instructions.md and .github/agents profiles', () => {
    const ws = join(dir, 'scan-me');
    mkdirSync(join(ws, '.github', 'agents'), { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), '# repo rules');
    writeFileSync(join(ws, 'CLAUDE.md'), '# claude rules');
    writeFileSync(join(ws, '.github', 'copilot-instructions.md'), '# copilot rules');
    writeFileSync(join(ws, '.github', 'agents', 'reviewer.agent.md'), '---\nname: reviewer\n---\nReview code.');
    const hits = scanInstructionFiles(ws);
    const kinds = hits.map((h) => h.kind).sort();
    expect(kinds).toEqual(['agent-profile', 'agents-md', 'claude-md', 'copilot-instructions']);
    const profile = hits.find((h) => h.kind === 'agent-profile');
    expect(profile?.path).toContain('reviewer.agent.md');
  });
});

describe('GET /api/workspace/instruction-files + POST /api/agents/import', () => {
  let app: import('fastify').FastifyInstance;
  let serverDir: string;

  beforeAll(async () => {
    serverDir = mkdtempSync(join(tmpdir(), 'md-agents-srv-'));
    writeFileSync(join(serverDir, 'AGENTS.md'), '# detected rules');
    const { buildServer } = await import('../src/server.js');
    const built = await buildServer(join(serverDir, 't.db'));
    app = built.app;
  });
  afterAll(async () => {
    try { await app.close(); } catch { /* noop */ }
    try { rmSync(serverDir, { recursive: true, force: true }); } catch { /* windows lag */ }
  });

  it('lists detected instruction files for a workdir', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspace/instruction-files?workdir=${encodeURIComponent(serverDir)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: { kind: string; path: string }[] };
    expect(body.files.some((f) => f.kind === 'agents-md')).toBe(true);
  });

  it('imports an inline markdown profile (register:false → mapped definition only)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/import',
      payload: { markdown: '---\nname: inline-md\n---\nInline prompt body.', register: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string | null; definition: { metadata: { name: string }; task: { prompt: string } } };
    expect(body.id).toBeNull();
    expect(body.definition.metadata.name).toBe('inline-md');
    expect(body.definition.task.prompt).toBe('Inline prompt body.');
  });

  it('registers the profile as a regular agent (register:true)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/import',
      payload: { markdown: '---\nname: registered-md\n---\nRegistered prompt.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string };
    expect(body.id).toBe('registered-md@1.0.0');
    const list = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(list.body).toContain('registered-md@1.0.0');
  });

  it('400s on empty body import (no prompt body)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agents/import', payload: { markdown: '' } });
    expect(res.statusCode).toBe(400);
  });
});
