import { describe, it, expect } from 'vitest';
import { compilePermissionHandlers } from '../src/agents/permissions.js';
import type { AgentDefinition } from '../src/core/types.js';

const base: AgentDefinition = {
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  persona: { systemMessage: { content: 'x' } },
  task: { prompt: 'hi' },
  provider: { type: 'openai', baseUrl: 'https://e/v1', model: 'm', providerApiKey: '${X}' },
};

describe('permissions', () => {
  it('deny-all denies unknown tools', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'deny-all' } }, { ciApproveAll: false });
    expect(await h.onPreToolUse({ toolName: 'shell' })).toMatchObject({ permissionDecision: 'deny' });
  });
  it('deny-all still allows coding-harness tools', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'deny-all' } }, { ciApproveAll: false });
    for (const tool of ['bash', 'mkdir', 'write', 'create', 'edit', 'grep']) {
      expect(await h.onPreToolUse({ toolName: tool }), tool).toMatchObject({ permissionDecision: 'allow' });
    }
  });
  it('deny-all denies harness tools when harness is disabled', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'deny-all', harness: false } }, { ciApproveAll: false, harnessTools: false });
    expect(await h.onPreToolUse({ toolName: 'bash' })).toMatchObject({ permissionDecision: 'deny' });
  });
  it('pattern-list allows matched tools', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'pattern-list', patterns: [{ tool: 'view', decision: 'allow' }] } }, { ciApproveAll: false });
    expect(await h.onPreToolUse({ toolName: 'view' })).toMatchObject({ permissionDecision: 'allow' });
  });
  it('approve-all-ci-only requires --yes', () => {
    expect(() => compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'approve-all-ci-only' } }, { ciApproveAll: false })).toThrow();
  });

  // --- new: builtins perTool grid ---

  it('perTool ask resolves as a deferred denial and fires the audit hook', async () => {
    const deferred: string[] = [];
    const h = compilePermissionHandlers(
      { ...base, tools: { builtins: { perTool: { wait: 'ask' } } } },
      { ciApproveAll: false },
      { onAskDeferred: (i) => deferred.push(i.tool) },
    );
    const d = await h.onPreToolUse({ toolName: 'wait' });
    expect(d).toMatchObject({ permissionDecision: 'deny' });
    expect(String(d.permissionDecisionReason)).toContain('interactive approval deferred');
    expect(deferred).toEqual(['wait']);
  });

  it('perTool deny and allow are honored under deny-all policies', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'deny-all', builtins: { perTool: { web_search: 'allow', danger: 'deny' } } } }, { ciApproveAll: false });
    expect(await h.onPreToolUse({ toolName: 'web_search' })).toMatchObject({ permissionDecision: 'allow' });
    expect(await h.onPreToolUse({ toolName: 'danger' })).toMatchObject({ permissionDecision: 'deny' });
  });

  it('perTool matches source-qualified keys (builtin:, mcp:, custom:)', async () => {
    const h = compilePermissionHandlers(
      { ...base, tools: { builtins: { perTool: { 'mcp:github-merge_pull_request': 'deny', 'builtin:report': 'ask' } } } },
      { ciApproveAll: false },
    );
    expect(await h.onPreToolUse({ toolName: 'github-merge_pull_request' })).toMatchObject({ permissionDecision: 'deny' });
    expect(await h.onPreToolUse({ toolName: 'report' })).toMatchObject({ permissionDecision: 'deny' });
  });

  it('legacy patterns win over perTool, and ask patterns defer-deny', async () => {
    const deferred: string[] = [];
    const h = compilePermissionHandlers(
      { ...base, tools: { permissionPolicy: 'pattern-list', patterns: [{ tool: 'bash', decision: 'deny', reason: 'explicit' }], builtins: { perTool: { bash: 'allow' } } } },
      { ciApproveAll: false },
      { onAskDeferred: (i) => deferred.push(i.tool) },
    );
    expect(await h.onPreToolUse({ toolName: 'bash' })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'explicit' });
    const h2 = compilePermissionHandlers({ ...base, tools: { patterns: [{ tool: 'shell', decision: 'ask' }] } }, { ciApproveAll: false }, { onAskDeferred: (i) => deferred.push(i.tool) });
    expect(await h2.onPreToolUse({ toolName: 'shell' })).toMatchObject({ permissionDecision: 'deny' });
    expect(deferred).toContain('shell');
  });

  it('destructive gate denies wrecking shell commands by default', async () => {
    const denied: string[] = [];
    const h = compilePermissionHandlers(
      { ...base, tools: { permissionPolicy: 'pattern-list', patterns: [{ tool: 'bash', decision: 'allow' }] } },
      { ciApproveAll: false },
      { onDestructiveDeny: (i) => denied.push(i.tool) },
    );
    const d = await h.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'rm -rf src && git push --force' } });
    expect(d).toMatchObject({ permissionDecision: 'deny' });
    expect(String(d.permissionDecisionReason)).toContain('destructive gate');
    expect(denied).toEqual(['bash']);
  });

  it('allowDestructive=true lets destructive commands through', async () => {
    const h = compilePermissionHandlers({ ...base, tools: { allowDestructive: true, permissionPolicy: 'pattern-list', patterns: [{ tool: 'bash', decision: 'allow' }] } }, { ciApproveAll: false });
    expect(await h.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'rm -rf node_modules' } })).toMatchObject({ permissionDecision: 'allow' });
  });

  it('destructive gate inherits to MCP tool calls (heuristic by wire name)', async () => {
    const h = compilePermissionHandlers(
      { ...base, tools: { permissionPolicy: 'pattern-list', patterns: [{ tool: '*', decision: 'allow' }] } },
      { ciApproveAll: false },
    );
    expect(await h.onPreToolUse({ toolName: 'mcp:github-delete_issue', toolArgs: {} })).toMatchObject({ permissionDecision: 'deny' });
    // non-destructive MCP tool passes
    expect(await h.onPreToolUse({ toolName: 'mcp:github-list_issues', toolArgs: {} })).toMatchObject({ permissionDecision: 'allow' });
  });

  it('builtins.default=ask denies unlisted tools with the audit hook', async () => {
    const deferred: string[] = [];
    const h = compilePermissionHandlers(
      { ...base, tools: { permissionPolicy: 'pattern-list', builtins: { default: 'ask', perTool: { view: 'allow' } } } },
      { ciApproveAll: false },
      { onAskDeferred: (i) => deferred.push(`${i.source}:${i.tool}`) },
    );
    expect(await h.onPreToolUse({ toolName: 'random_tool' })).toMatchObject({ permissionDecision: 'deny' });
    expect(await h.onPreToolUse({ toolName: 'view' })).toMatchObject({ permissionDecision: 'allow' });
    expect(deferred).toContain('builtins.default:random_tool');
  });

  it('deny-all policy is unchanged when no builtins config exists (harness allow, rest deny)', async () => {
    const onPermissionRequest = compilePermissionHandlers({ ...base, tools: { permissionPolicy: 'deny-all' } }, { ciApproveAll: false });
    const d = await onPermissionRequest.onPreToolUse({ toolName: 'report' });
    expect(d).toMatchObject({ permissionDecision: 'deny' });
  });
});
