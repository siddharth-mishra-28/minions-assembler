import { describe, it, expect } from 'vitest';
import { compilePermissionHandlers } from './permissions.js';
import type { AgentDefinition } from './types.js';

const base: AgentDefinition = {
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  persona: { systemMessage: { content: 'x' } },
  task: { prompt: 'hi' },
  provider: { type: 'openai', baseUrl: 'https://e/v1', model: 'm', credentialEnv: 'X' },
};

describe('permissions', () => {
  it('deny-all denies unknown tools', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'deny-all' } }, { ciApproveAll: false });
    expect(await h.onPreToolUse({ toolName: 'shell' })).toMatchObject({ permissionDecision: 'deny' });
  });
  it('pattern-list allows matched tools', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'pattern-list', patterns: [{ tool: 'view', decision: 'allow' }] } }, { ciApproveAll: false });
    expect(await h.onPreToolUse({ toolName: 'view' })).toMatchObject({ permissionDecision: 'allow' });
  });
  it('approve-all-ci-only requires --yes', () => {
    expect(() => compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'approve-all-ci-only' } }, { ciApproveAll: false })).toThrow();
  });
});
