import type { AgentDefinition } from './types.js';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** Compile declarative policy to runtime callbacks. Deny-by-default. */
export function compilePermissionHandlers(def: AgentDefinition, opts: { ciApproveAll: boolean }) {
  const policy = def.tools?.permissionPolicy ?? 'deny-all';
  const patterns = def.tools?.patterns ?? [];

  if (policy === 'approve-all-ci-only' && !opts.ciApproveAll) {
    throw new Error('permissionPolicy approve-all-ci-only requires --yes (explicit CI approval); refusing to run');
  }

  const onPermissionRequest = async (_req: unknown) => {
    if (policy === 'approve-all-ci-only' && opts.ciApproveAll) return { kind: 'approve-once' };
    // pattern-list / deny-all: defer to pre-tool hook per tool
    return { kind: 'approve-once' as const };
  };

  const onPreToolUse = async (input: { toolName?: string; tool?: string }) => {
    const name = (input.toolName ?? input.tool ?? '').toLowerCase();
    for (const p of patterns) {
      if (p.tool.toLowerCase() === name || p.tool === '*') {
        return { permissionDecision: p.decision as PermissionDecision, permissionDecisionReason: p.reason ?? `Matched pattern for ${p.tool}` };
      }
    }
    if (policy === 'deny-all') {
      // Custom tools marked skipPermission are still allowed; everything else denied unless patterned
      return { permissionDecision: 'deny' as PermissionDecision, permissionDecisionReason: `deny-all: no pattern allows '${name}'` };
    }
    return { permissionDecision: 'allow' as PermissionDecision };
  };

  return { onPermissionRequest, onPreToolUse };
}
