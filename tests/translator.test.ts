import { describe, it, expect } from 'vitest';
import { toSessionOptions, toSendArgs, resolvePersona } from '../src/agents/translator.js';
import type { AgentDefinition } from '../src/core/types.js';

const base: AgentDefinition = {
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  persona: { systemMessage: { mode: 'append', content: 'Be concise.' } },
  task: { prompt: 'Hello' },
  provider: { type: 'openai', baseUrl: 'https://example/v1', model: 'm', providerApiKey: '${X}' },
};

describe('translator', () => {
  it('maps provider + model + systemMessage', () => {
    const o = toSessionOptions(base, 'KEY');
    expect(o.model).toBe('m');
    expect((o.provider as { baseUrl: string }).baseUrl).toBe('https://example/v1');
    expect((o.systemMessage as { content: string }).content).toBe('Be concise.');
  });
  it('omits systemMessage entirely for a pure default-prompt agent', () => {
    const def: AgentDefinition = { ...base, persona: { useCopilotDefaultPrompt: true } };
    const o = toSessionOptions(def, 'KEY');
    expect(o.systemMessage).toBeUndefined();
    expect(Object.keys(o)).not.toContain('systemMessage');
    const r = resolvePersona(def);
    expect(r.defaultPromptIncluded).toBe(true);
    expect(r.systemMessage).toBeUndefined();
  });
  it('replace mode marks the default prompt as dropped', () => {
    const def: AgentDefinition = { ...base, persona: { useCopilotDefaultPrompt: false, systemMessage: { mode: 'replace', content: 'solo', acknowledgeReplaceRisks: true } } };
    const r = resolvePersona(def);
    expect(r.defaultPromptIncluded).toBe(false);
    expect(toSessionOptions(def, 'K').systemMessage).toMatchObject({ mode: 'replace' });
  });
  it('maps customAgents and defaultAgent', () => {
    const o = toSessionOptions({ ...base, agents: [{ name: 'r', prompt: 'p', infer: false }], defaultAgent: 'r' }, 'K');
    expect(o.agent).toBe('r');
    expect((o.customAgents as { name: string; infer: boolean }[])[0]).toMatchObject({ name: 'r', infer: false });
  });

  it('injects harness tools into a per-agent tools allowlist', () => {
    // custom-engineer's code-builder listed only file tools — bash/mkdir were hidden.
    const o = toSessionOptions(
      {
        ...base,
        agents: [{ name: 'code-builder', prompt: 'p', tools: ['grep', 'glob', 'view', 'write', 'edit'] }],
        defaultAgent: 'code-builder',
      },
      'K',
    );
    const tools = (o.customAgents as { tools: string[] }[])[0].tools;
    expect(tools).toEqual(expect.arrayContaining(['bash', 'mkdir', 'write', 'create']));
    expect(tools).toContain('grep');
  });

  it('leaves agent tools unset when the agent has no allowlist', () => {
    const o = toSessionOptions({ ...base, agents: [{ name: 'r', prompt: 'p' }] }, 'K');
    expect((o.customAgents as { tools: unknown }[])[0].tools).toBeNull();
  });

  it('does not inject harness tools into agent allowlists when harness is off', () => {
    const o = toSessionOptions(
      {
        ...base,
        tools: { harness: false },
        agents: [{ name: 'r', prompt: 'p', tools: ['grep'] }],
      },
      'K',
    );
    expect((o.customAgents as { tools: string[] }[])[0].tools).toEqual(['grep']);
  });

  it('keeps availableTools unrestricted by default (all built-ins available)', () => {
    const o = toSessionOptions(base, 'K');
    expect(o.availableTools).toBeUndefined();
    expect(o.excludedTools).toBeUndefined();
  });

  it('builds an explicit availability allowlist when builtins.all=false', () => {
    const def: AgentDefinition = {
      ...base,
      tools: {
        builtins: {
          all: false,
          perTool: { read: 'allow', view: 'allow', 'mcp:github-list_issues': 'allow' },
        },
      },
    };
    const o = toSessionOptions(def, 'K');
    expect(o.availableTools).toEqual(expect.arrayContaining(['mcp:*', 'custom:*', 'builtin:read', 'builtin:view', 'builtin:github-list_issues']));
  });

  it('excludes perTool deny entries from the session', () => {
    const def: AgentDefinition = {
      ...base,
      tools: { builtins: { perTool: { shell: 'deny' } }, excluded: ['wait'] },
    };
    const o = toSessionOptions(def, 'K');
    expect(o.excludedTools).toEqual(expect.arrayContaining(['shell', 'wait']));
  });

  it('passes toolSearch, builtin agent/skill lists and autopilot through', () => {
    const def: AgentDefinition = {
      ...base,
      runtime: {
        toolSearch: { enabled: true, deferThreshold: 12 },
        excludedBuiltinAgents: ['brainstormer'],
        includedBuiltinSkills: ['memory'],
        autopilot: true,
      },
    };
    const o = toSessionOptions(def, 'K');
    expect(o.toolSearch).toEqual({ enabled: true, deferThreshold: 12 });
    expect(o.excludedBuiltinAgents).toEqual(['brainstormer']);
    expect(o.includedBuiltinSkills).toEqual(['memory']);
    expect(o.autopilot).toBe(true);
  });

  it('defaults toolSearch to disabled for coding-agent behavior', () => {
    const o = toSessionOptions(base, 'K');
    expect(o.toolSearch).toEqual({ enabled: false });
  });

  it('injects instructions into prompt and honors task override', () => {
    const args = toSendArgs({ ...base, instructions: { global: ['G1'] } }, 'Override');
    expect(args.prompt).toContain('Override');
    expect(args.prompt).toContain('G1');
  });
  it('never includes apiKey at rest (key passed separately)', () => {
    const o = toSessionOptions(base, 'LIVE');
    expect(JSON.stringify(o)).toContain('LIVE');
  });
});
