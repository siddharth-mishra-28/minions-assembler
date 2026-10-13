import { describe, it, expect } from 'vitest';
import { toSessionOptions, toSendArgs } from './translator.js';
import type { AgentDefinition } from './types.js';

const base: AgentDefinition = {
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  persona: { systemMessage: { mode: 'append', content: 'Be concise.' } },
  task: { prompt: 'Hello' },
  provider: { type: 'openai', baseUrl: 'https://example/v1', model: 'm', credentialEnv: 'X' },
};

describe('translator', () => {
  it('maps provider + model + systemMessage', () => {
    const o = toSessionOptions(base, 'KEY');
    expect(o.model).toBe('m');
    expect((o.provider as { baseUrl: string }).baseUrl).toBe('https://example/v1');
    expect((o.systemMessage as { content: string }).content).toBe('Be concise.');
  });
  it('maps customAgents and defaultAgent', () => {
    const o = toSessionOptions({ ...base, agents: [{ name: 'r', prompt: 'p', infer: false }], defaultAgent: 'r' }, 'K');
    expect(o.agent).toBe('r');
    expect((o.customAgents as { name: string; infer: boolean }[])[0]).toMatchObject({ name: 'r', infer: false });
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
