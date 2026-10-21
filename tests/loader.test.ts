import { describe, it, expect } from 'vitest';
import { validateDefinitionObject } from '../src/agents/loader.js';
import type { AgentDefinition } from '../src/core/types.js';

const minimal: AgentDefinition = {
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  task: { prompt: 'x' },
  provider: { type: 'openai', baseUrl: 'https://u/v1', model: 'm', providerApiKey: '${LLM_API_KEY}' },
};

describe('loader validation (persona + builtins)', () => {
  it('accepts a definition with no persona at all (pure default Copilot prompt)', () => {
    const { definition, warnings } = validateDefinitionObject(minimal);
    expect(definition.persona).toBeUndefined();
    expect(warnings.join('\n')).not.toContain('systemMessage');
  });
  it('accepts persona.useCopilotDefaultPrompt as a bare boolean', () => {
    const { definition } = validateDefinitionObject({ ...minimal, persona: { useCopilotDefaultPrompt: true } });
    expect(definition.persona?.useCopilotDefaultPrompt).toBe(true);
  });
  it('keeps requiring acknowledgeReplaceRisks for replace mode', () => {
    expect(() => validateDefinitionObject({ ...minimal, persona: { systemMessage: { mode: 'replace', content: 'solo' } } })).toThrow(/acknowledgeReplaceRisks/);
  });
  it('warns when useCopilotDefaultPrompt=false but no systemMessage is given', () => {
    const { warnings } = validateDefinitionObject({ ...minimal, persona: { useCopilotDefaultPrompt: false } });
    expect(warnings.join('\n')).toMatch(/default Copilot prompt still applies/);
  });
  it('warns when useCopilotDefaultPrompt=true but mode=replace', () => {
    const { warnings } = validateDefinitionObject({ ...minimal, persona: { useCopilotDefaultPrompt: true, systemMessage: { mode: 'replace', content: 'solo', acknowledgeReplaceRisks: true } } });
    expect(warnings.join('\n')).toMatch(/REPLACED/);
  });
  it('accepts tools.builtins and tools.allowDestructive', () => {
    const { definition } = validateDefinitionObject({
      ...minimal,
      tools: { allowDestructive: true, builtins: { default: 'ask', perTool: { bash: 'allow', 'mcp:github-delete_issue': 'deny' } } },
    });
    expect(definition.tools?.allowDestructive).toBe(true);
    expect(definition.tools?.builtins?.default).toBe('ask');
  });
  it('warns on all=false with no allow entries', () => {
    const { warnings } = validateDefinitionObject({ ...minimal, tools: { builtins: { all: false, default: 'allow' } } });
    expect(warnings.join('\n')).toMatch(/no built-in tools will be available/);
  });
  it('warns on redundant perTool allow entries while all=true', () => {
    const { warnings } = validateDefinitionObject({ ...minimal, tools: { builtins: { all: true, perTool: { view: 'allow' } } } });
    expect(warnings.join('\n')).toMatch(/redundant/);
  });
  it('rejects invalid builtins decision values', () => {
    expect(() => validateDefinitionObject({ ...minimal, tools: { builtins: { default: 'maybe' } } })).toThrow(/Schema validation failed/);
  });
});
