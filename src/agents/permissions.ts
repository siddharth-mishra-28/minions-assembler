import type { AgentDefinition, ToolDecision } from '../core/types.js';
import { evaluateDestructive, BUILTIN_TOOLS } from './tools-policy.js';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

const KNOWN_BUILTIN_NAMES = new Set<string>(BUILTIN_TOOLS.map((b) => b.name.toLowerCase()));

export interface CompilePermissionHooks {
  /** Called when an 'ask' decision resolves as a deferred denial (for audit persistence). */
  onAskDeferred?: (info: { tool: string; decision: ToolDecision; source: string }) => void;
  /** Called when the destructive gate denies a call (for audit persistence). */
  onDestructiveDeny?: (info: { tool: string; reason: string; pattern: string }) => void;
  /** Interactive mode: ask a human. Resolves with the decision (deny on timeout/cancel). */
  requestApproval?: (info: { tool: string; args: unknown; source: string }) => Promise<{ allow: boolean; reason?: string }>;
  /** Called when an 'ask' is resolved without a human (autopilot allow / strict deny) for audit persistence. */
  onAskResolved?: (info: { tool: string; source: string; allow: boolean; mode: string }) => void;
}

export type ApprovalMode = 'interactive' | 'autopilot' | 'strict';

/**
 * Compile the declarative tool policy + builtins grid to runtime callbacks.
 *
 * Decision order for every pre-tool call:
 * 1. legacy `tools.patterns[]` (explicit definition intent)
 * 2. `tools.builtins.perTool` decision (wizard checkbox rows)
 * 3. destructive gate — unless `tools.allowDestructive: true`, shell commands
 *    matching destructive heuristics and MCP tool names signalling
 *    update/delete operations are denied (audited)
 * 4. harness tools (bash/mkdir/write/create/edit/view/grep/glob/ls/read/list)
 *    stay allowed — they are the scaffolding primitives
 * 5. base policy fallback:
 *    - `deny-all`: harness allowed, everything else denied (unchanged), except
 *      tools carrying an explicit perTool decision
 *    - `pattern-list` / `approve-all-ci-only(with --yes)`: allow, with
 *      `builtins.default` consulted for tools without a decision entry
 *
 * 'ask' semantics: interactive approval is deferred out of scope — an 'ask'
 * (from a checkbox row or a legacy pattern) resolves as a deny with an
 * audited reason naming the deferred decision (`permission.ask_denied`).
 */
export function compilePermissionHandlers(def: AgentDefinition, opts: { ciApproveAll: boolean; harnessTools?: boolean; approvalMode?: ApprovalMode }, hooks?: CompilePermissionHooks) {
  const policy = def.tools?.permissionPolicy ?? 'deny-all';
  const patterns = def.tools?.patterns ?? [];
  const builtins = def.tools?.builtins as { default?: PermissionDecision; perTool?: Record<string, PermissionDecision> } | undefined;

  if (policy === 'approve-all-ci-only' && !opts.ciApproveAll) {
    throw new Error('permissionPolicy approve-all-ci-only requires --yes (explicit CI approval); refusing to run');
  }

  const alwaysAllow = new Set<string>(opts.harnessTools === false ? [] : ['bash', 'mkdir', 'write', 'create', 'edit', 'view', 'grep', 'glob', 'ls', 'read', 'list']);

  const onPermissionRequest = async (_req: unknown) => {
    if (policy === 'approve-all-ci-only' && opts.ciApproveAll) return { kind: 'approve-once' };
    // pattern-list / deny-all: defer to pre-tool hook per tool
    return { kind: 'approve-once' as const };
  };

  /** Resolve a perTool decision for this tool across bare + source-qualified keys. */
  const perToolDecision = (name: string): PermissionDecision | undefined => {
    const perTool = builtins?.perTool ?? {};
    if (perTool[name] != null) return normalizeLeg(perTool[name]);
    if (perTool[`builtin:${name}`] != null) return normalizeLeg(perTool[`builtin:${name}`]);
    // MCP tools arrive as bare wire names (<server>-<tool>) or mcp:<name>
    if (perTool[`mcp:${name}`] != null) return normalizeLeg(perTool[`mcp:${name}`]);
    if (perTool[`custom:${name}`] != null) return normalizeLeg(perTool[`custom:${name}`]);
    // Any source-qualified key ending in :name (e.g. mcp:server-tool)
    for (const key of Object.keys(perTool)) {
      if (key.toLowerCase().endsWith(`:${name}`)) return normalizeLeg(perTool[key]);
    }
    return undefined;
  };

  const isMcpToolName = (name: string): boolean =>
    name.startsWith('mcp:') // source-qualified form
    || (/[a-z0-9-]+-[a-z0-9_-]+/.test(name) && !KNOWN_BUILTIN_NAMES.has(name) && !alwaysAllow.has(name)); // bare <server>-<tool> wire names

  /**
   * Resolve an 'ask' decision. With an approval mode it is answered (human / autopilot / strict);
   * without one it keeps the legacy deferred-deny so headless callers stay deterministic.
   * Runs AFTER the destructive gate, so autopilot can never bypass it.
   */
  const resolveAsk = async (name: string, args: unknown, source: string, deferredReason: string) => {
    const mode = opts.approvalMode;
    if (mode === 'autopilot') {
      hooks?.onAskResolved?.({ tool: name, source, allow: true, mode });
      return { permissionDecision: 'allow' as PermissionDecision, permissionDecisionReason: `autopilot: '${name}' auto-approved (${source})` };
    }
    if (mode === 'interactive' && hooks?.requestApproval) {
      const r = await hooks.requestApproval({ tool: name, args, source });
      return { permissionDecision: (r.allow ? 'allow' : 'deny') as PermissionDecision, permissionDecisionReason: r.reason ?? (r.allow ? `approved by user (${source})` : `denied by user (${source})`) };
    }
    if (mode === 'strict') hooks?.onAskResolved?.({ tool: name, source, allow: false, mode });
    else hooks?.onAskDeferred?.({ tool: name, decision: 'ask', source });
    return { permissionDecision: 'deny' as PermissionDecision, permissionDecisionReason: mode === 'strict' ? `strict: '${name}' requires approval and strict mode denies it (${source})` : deferredReason };
  };

  const onPreToolUse = async (input: { toolName?: string; tool?: string; toolArgs?: unknown }): Promise<{ permissionDecision: PermissionDecision; permissionDecisionReason?: string }> => {
    const rawName = (input.toolName ?? input.tool ?? '');
    const name = rawName.toLowerCase();
    if (!name) return { permissionDecision: 'allow' as PermissionDecision };

    // 1. destructive gate — denials are monotonic restrictions, so it runs
    //    before any allow decision (pattern '*' or an exact allow must not
    //    bypass it); the tools.allowDestructive checkbox is the opt-in.
    if (def.tools?.allowDestructive !== true) {
      const mcp = isMcpToolName(name);
      const verdict = evaluateDestructive(name, input.toolArgs, mcp ? { mcp: true } : undefined);
      if (verdict) {
        hooks?.onDestructiveDeny?.({ tool: name, reason: verdict.reason, pattern: verdict.pattern });
        return { permissionDecision: 'deny' as PermissionDecision, permissionDecisionReason: verdict.reason };
      }
    }

    // 2. legacy patterns (explicit definition intent; 'ask' maps to the deferred denial below)
    for (const p of patterns) {
      if (p.tool.toLowerCase() === name) {
        const decision = normalizeLeg(p.decision);
        if (decision === 'ask') {
          return resolveAsk(name, input.toolArgs, `pattern '${p.tool}'`, `interactive approval deferred: 'ask' decision from pattern '${p.tool}' is not resolved in headless runs — denied (audited)`);
        }
        return { permissionDecision: decision as PermissionDecision, permissionDecisionReason: p.reason ?? `Matched pattern for ${p.tool}` };
      }
    }
    for (const p of patterns) {
      if (p.tool === '*') {
        const decision = normalizeLeg(p.decision);
        if (decision === 'ask') {
          return resolveAsk(name, input.toolArgs, `pattern '${p.tool}'`, `interactive approval deferred: 'ask' decision from pattern '*' is not resolved in headless runs — denied (audited)`);
        }
        return { permissionDecision: decision as PermissionDecision, permissionDecisionReason: p.reason ?? `Matched wildcard pattern` };
      }
    }

    // 3. builtins perTool decisions (wizard grid)
    const pt = perToolDecision(name);
    if (pt == 'ask') {
      return resolveAsk(name, input.toolArgs, 'builtins.perTool', `interactive approval deferred: 'ask' decision for '${name}' is not resolved in headless runs — denied (audited)`);
    }
    if (pt == 'allow' || pt == 'deny') {
      return { permissionDecision: pt as PermissionDecision, permissionDecisionReason: `builtins.perTool: '${name}' → ${pt}` };
    }

    // 4. harness tools ride along under every policy
    if (alwaysAllow.has(name)) {
      return { permissionDecision: 'allow' as PermissionDecision, permissionDecisionReason: `coding-harness tool '${name}'` };
    }

    // 5. base policy fallback
    if (policy === 'deny-all') {
      return { permissionDecision: 'deny' as PermissionDecision, permissionDecisionReason: `deny-all: no pattern or decision allows '${name}'` };
    }
    const bDefault = (builtins?.default ?? 'allow') as PermissionDecision;
    if (bDefault === 'ask') {
      return resolveAsk(name, input.toolArgs, 'builtins.default', `interactive approval deferred: builtins.default is 'ask' and no decision covers '${name}' — denied (audited)`);
    }
    return { permissionDecision: bDefault as PermissionDecision, permissionDecisionReason: `policy ${policy} fallback (builtins.default=${bDefault})` };
  };

  return { onPermissionRequest, onPreToolUse };
}

function normalizeLeg(d: string | undefined): PermissionDecision | undefined {
  return d === 'allow' || d === 'deny' || d === 'ask' ? d : undefined;
}
