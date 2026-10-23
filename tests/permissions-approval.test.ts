import { describe, it, expect, vi } from 'vitest';
import { compilePermissionHandlers } from '../src/agents/permissions.js';
import type { AgentDefinition } from '../src/core/types.js';

const def = (perTool: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  tools: { permissionPolicy: 'pattern-list', builtins: { default: 'allow', perTool }, ...extra },
}) as unknown as AgentDefinition;
const call = (h: ReturnType<typeof compilePermissionHandlers>, toolName: string, toolArgs: unknown = {}) => h.onPreToolUse({ toolName, toolArgs });

describe('approval modes', () => {
  it('legacy (no mode): ask is a deferred deny', async () => {
    const onAskDeferred = vi.fn();
    const h = compilePermissionHandlers(def({ web_fetch: 'ask' }), { ciApproveAll: false }, { onAskDeferred });
    expect((await call(h, 'web_fetch')).permissionDecision).toBe('deny');
    expect(onAskDeferred).toHaveBeenCalled();
  });

  it('autopilot approves asks but never bypasses the destructive gate', async () => {
    const onAskResolved = vi.fn();
    const h = compilePermissionHandlers(def({ web_fetch: 'ask', bash: 'ask' }), { ciApproveAll: true, approvalMode: 'autopilot' }, { onAskResolved });
    expect((await call(h, 'web_fetch')).permissionDecision).toBe('allow');
    expect(onAskResolved).toHaveBeenCalledWith(expect.objectContaining({ tool: 'web_fetch', allow: true, mode: 'autopilot' }));
    expect((await call(h, 'bash', { command: 'rm -rf /' })).permissionDecision).toBe('deny');
  });

  it('strict denies asks', async () => {
    const h = compilePermissionHandlers(def({ web_fetch: 'ask' }), { ciApproveAll: false, approvalMode: 'strict' });
    expect((await call(h, 'web_fetch')).permissionDecision).toBe('deny');
  });

  it('interactive defers to the human callback', async () => {
    const requestApproval = vi.fn().mockResolvedValueOnce({ allow: true }).mockResolvedValueOnce({ allow: false });
    const h = compilePermissionHandlers(def({ web_fetch: 'ask' }), { ciApproveAll: false, approvalMode: 'interactive' }, { requestApproval });
    expect((await call(h, 'web_fetch')).permissionDecision).toBe('allow');
    expect((await call(h, 'web_fetch')).permissionDecision).toBe('deny');
  });

  it('approve-all-ci-only still refuses without explicit approval', () => {
    expect(() => compilePermissionHandlers(def({}, { permissionPolicy: 'approve-all-ci-only' }), { ciApproveAll: false })).toThrow(/--yes/);
  });
});
