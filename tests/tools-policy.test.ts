import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOLS, resolveBuiltinTools, evaluateDestructive, normalizePerToolDecisions } from '../src/agents/tools-policy.js';
import type { AgentDefinition, ToolBuiltinsPolicy } from '../src/core/types.js';

const def = (tools: AgentDefinition['tools']): AgentDefinition => ({
  schemaVersion: '1.0',
  metadata: { name: 't', version: '1.0.0' },
  task: { prompt: 'x' },
  provider: { type: 'openai', baseUrl: 'u', model: 'm', providerApiKey: 'k' },
  tools,
});

describe('builtin tool registry', () => {
  it('lists the core CLI tool surface', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    for (const expected of ['bash', 'read', 'view', 'write', 'create', 'edit', 'grep', 'glob', 'task', 'report']) {
      expect(names).toContain(expected);
    }
  });
});

describe('resolveBuiltinTools', () => {
  it('leaves everything unrestricted by default (select-all posture)', () => {
    const r = resolveBuiltinTools(def(undefined));
    expect(r.availableTools).toBeUndefined();
    expect(r.excludedTools).toBeUndefined();
    expect(r.allBuiltins).toBe(true);
    expect(r.defaultDecision).toBe('allow');
    expect(r.allowDestructive).toBe(false);
  });
  it('all=false produces an explicit allowlist that preserves MCP/custom sources', () => {
    const r = resolveBuiltinTools(def({ builtins: { all: false, perTool: { read: 'allow', edit: 'allow' } } }));
    expect(r.availableTools).toEqual(expect.arrayContaining(['mcp:*', 'custom:*', 'builtin:read', 'builtin:edit']));
    expect(r.availableTools).not.toContain('builtin:grep');
  });
  it('collects perTool deny entries into excludedTools and keeps def.tools.excluded', () => {
    const r = resolveBuiltinTools(def({ excluded: ['wait'], builtins: { perTool: { shell: 'deny', 'builtin:report': 'deny' } } }));
    expect(r.excludedTools).toEqual(expect.arrayContaining(['wait', 'shell', 'builtin:report']));
  });
  it('default decision falls back to allow and carries the destructive flag', () => {
    const r = resolveBuiltinTools(def({ builtins: { default: 'ask' } as ToolBuiltinsPolicy, allowDestructive: true }));
    expect(r.defaultDecision).toBe('ask');
    expect(r.allowDestructive).toBe(true);
  });
  it('summary is compact and includes the posture', () => {
    const r = resolveBuiltinTools(def({ builtins: { default: 'deny' } }));
    expect(r.summary).toMatch(/default=deny/);
    expect(r.summary).toMatch(/destructive=gated/);
  });
});

describe('normalizePerToolDecisions', () => {
  it('strips builtin:/custom: prefixes into the bare index and keeps mcp: keys qualified', () => {
    const { qualified, bare } = normalizePerToolDecisions({
      'builtin:view': 'allow',
      'custom:foo': 'deny',
      'mcp:github-list_issues': 'ask',
      shell: 'allow',
    });
    expect(bare.get('view')).toBe('allow');
    expect(bare.get('foo')).toBe('deny');
    expect(qualified.get('mcp:github-list_issues')).toBe('ask');
    expect(bare.get('shell')).toBe('allow');
  });
});

describe('evaluateDestructive', () => {
  it('denies recursive rm and SQL DROP shell commands', () => {
    for (const command of ['rm -rf node_modules', 'sudo rm -rf /', 'DROP TABLE users', 'git push --force origin main']) {
      const v = evaluateDestructive('bash', { command });
      expect(v, command).toMatchObject({ decision: 'deny' });
      expect(v?.reason ?? '').toContain('tools.allowDestructive=true');
    }
  });
  it('denies process-kill commands (they can take down the host app and sibling runs)', () => {
    for (const command of [
      'cd app && start /b node server.js & taskkill /f /im node.exe',
      'pkill -f "node server.js"',
      'killall node',
      'kill -9 12345',
      'kill 12345',
      'Get-Process node | Stop-Process -Force',
      'npx kill-port 3100',
    ]) {
      const v = evaluateDestructive('bash', { command });
      expect(v, command).toMatchObject({ decision: 'deny' });
      expect(v?.reason ?? '').toContain('tools.allowDestructive=true');
    }
  });
  it('ignores benign shell commands', () => {
    expect(evaluateDestructive('bash', { command: 'node build.js && npm test' })).toBeUndefined();
    expect(evaluateDestructive('bash', { command: 'mkdir -p app/lib' })).toBeUndefined();
    expect(evaluateDestructive('bash', { command: 'npm run kill-server' })).toBeUndefined();
    expect(evaluateDestructive('bash', { command: 'echo "kill the lights"' })).toBeUndefined();
  });
  it('gates destructive-named MCP tool calls', () => {
    const v = evaluateDestructive('mcp:github-delete_issue', {}, { mcp: true });
    expect(v).toMatchObject({ decision: 'deny', pattern: 'mcp-name' });
    expect(evaluateDestructive('mcp:github-list_issues', {}, { mcp: true })).toBeUndefined();
  });
  it('no verdict when the tool exposes no command payload', () => {
    expect(evaluateDestructive('bash', {})).toBeUndefined();
    expect(evaluateDestructive('bash', undefined)).toBeUndefined();
  });
});
