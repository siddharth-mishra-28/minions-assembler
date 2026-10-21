import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDefinitionObject } from '../src/agents/loader.js';
import { resolvePersona } from '../src/agents/translator.js';
import { SECTION_CATALOG, captureDefaultSystemMessage, clearDefaultPromptCache } from '../src/agents/default-prompt.js';
import type { AgentDefinition } from '../src/core/types.js';

const minimal: AgentDefinition = {
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  task: { prompt: 'x' },
  provider: { type: 'openai', baseUrl: 'https://u/v1', model: 'm', providerApiKey: '${LLM_API_KEY}' },
};

const ALL_SECTION_IDS = [
  'preamble', 'identity', 'tone', 'tool_efficiency', 'environment_context', 'code_change_rules',
  'guidelines', 'safety', 'tool_instructions', 'custom_instructions', 'runtime_instructions', 'last_instructions',
];

describe('persona.systemMessage.sections schema (customize mode)', () => {
  it('accepts all 12 SDK section ids with every static action', () => {
    const sections = Object.fromEntries(ALL_SECTION_IDS.map((id, i) => {
      const action = (['preserve', 'append', 'prepend', 'replace', 'remove'] as const)[i % 5];
      return [id, action === 'remove' || action === 'preserve' ? { action } : { action, content: `edit for ${id}` }];
    }));
    const { definition } = validateDefinitionObject({
      ...minimal,
      persona: { useCopilotDefaultPrompt: true, systemMessage: { mode: 'customize', sections } },
    });
    expect(Object.keys(definition.persona?.systemMessage?.sections ?? {})).toEqual(ALL_SECTION_IDS);
  });

  it('rejects an unknown section id', () => {
    expect(() => validateDefinitionObject({
      ...minimal,
      persona: { systemMessage: { mode: 'customize', sections: { not_a_section: { action: 'remove' } } } },
    })).toThrow(/section/i);
  });

  it('accepts sections without top-level content (content is optional for customize)', () => {
    const { definition } = validateDefinitionObject({
      ...minimal,
      persona: { systemMessage: { mode: 'customize', sections: { tone: { action: 'replace', content: 'be terse' } } } },
    });
    expect(definition.persona?.systemMessage?.content).toBeUndefined();
    expect(definition.persona?.systemMessage?.sections?.tone?.action).toBe('replace');
  });

  it('still requires content for replace mode', () => {
    expect(() => validateDefinitionObject({
      ...minimal,
      persona: { systemMessage: { mode: 'replace', acknowledgeReplaceRisks: true } },
    })).toThrow();
  });

  it('rejects a systemMessage with neither content nor sections', () => {
    expect(() => validateDefinitionObject({
      ...minimal,
      persona: { systemMessage: { mode: 'append' } },
    })).toThrow();
  });
});

describe('resolvePersona passthrough', () => {
  it('keeps the default prompt active for customize and passes sections through verbatim', () => {
    const sections = { tone: { action: 'replace' as const, content: 'be terse' }, safety: { action: 'preserve' as const } };
    const r = resolvePersona({ ...minimal, persona: { systemMessage: { mode: 'customize', content: 'extra', sections } } });
    expect(r.defaultPromptIncluded).toBe(true);
    expect((r.systemMessage as { sections?: unknown }).sections).toEqual(sections);
    expect(r.summary).toContain('included');
  });
});

describe('section catalog', () => {
  it('exposes every SDK section id with a description', () => {
    for (const id of ALL_SECTION_IDS) {
      expect(SECTION_CATALOG[id]?.description, `missing catalog entry for ${id}`).toBeTruthy();
    }
  });
});

describe('GET /api/persona/default-system-prompt', () => {
  let dir: string;
  let app: import('fastify').FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'default-prompt-'));
    const { buildServer } = await import('../src/server.js');
    const built = await buildServer(join(dir, 't.db'));
    app = built.app;
  });
  afterAll(async () => {
    try { await app.close(); } catch { /* noop */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
  });

  it('capture=0 returns the section catalog without spawning the runtime', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/persona/default-system-prompt?capture=0' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sections: Record<string, { description: string }>; capture: unknown; note: string };
    expect(Object.keys(body.sections).sort()).toEqual([...ALL_SECTION_IDS].sort());
    expect(body.capture).toBeNull();
    expect(body.note).toContain('SYSTEM_MESSAGE_SECTIONS');
  });
});

describe('live default-prompt capture (spawns the bundled Copilot CLI)', () => {
  it('captures the composed default system prompt via the loopback stub provider', async () => {
    clearDefaultPromptCache();
    const capture = await captureDefaultSystemMessage({ timeoutMs: 120_000 });
    expect(capture.error ?? '').toBe('');
    expect(capture.ok).toBe(true);
    // The default prompt is a large multi-section document, not a stub.
    expect((capture.text ?? '').length).toBeGreaterThan(200);
    expect(capture.workdir).toBeTruthy();
  }, 180_000);
});
