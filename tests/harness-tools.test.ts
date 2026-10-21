import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTurnTimeoutMs,
  resolveInWorkspace,
  extractPathArg,
  ensureParentDir,
  buildHarnessTools,
  withHarnessToolsAvailable,
  withHarnessToolsForAgent,
  harnessEnabled,
  DEFAULT_TURN_TIMEOUT_MS,
  HARNESS_TOOL_NAMES,
} from '../src/agents/harness-tools.js';

describe('resolveTurnTimeoutMs', () => {
  const prev = process.env.RUN_TURN_TIMEOUT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.RUN_TURN_TIMEOUT_MS;
    else process.env.RUN_TURN_TIMEOUT_MS = prev;
  });

  it('defaults to 45 minutes', () => {
    delete process.env.RUN_TURN_TIMEOUT_MS;
    expect(resolveTurnTimeoutMs({})).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(45 * 60 * 1000);
  });

  it('prefers body override over definition and env', () => {
    process.env.RUN_TURN_TIMEOUT_MS = '1000';
    expect(resolveTurnTimeoutMs({ runtime: { turnTimeoutMs: 2000 } }, 3000)).toBe(3000);
  });

  it('prefers definition over env', () => {
    process.env.RUN_TURN_TIMEOUT_MS = '1000';
    expect(resolveTurnTimeoutMs({ runtime: { turnTimeoutMs: 2000 } })).toBe(2000);
  });

  it('uses env when definition is absent', () => {
    process.env.RUN_TURN_TIMEOUT_MS = '60000';
    expect(resolveTurnTimeoutMs({})).toBe(60000);
  });

  it('clamps out-of-range values', () => {
    delete process.env.RUN_TURN_TIMEOUT_MS;
    expect(resolveTurnTimeoutMs({}, 10)).toBe(1000);
    expect(resolveTurnTimeoutMs({}, 99 * 60 * 60 * 1000)).toBe(6 * 60 * 60 * 1000);
  });
});

describe('resolveInWorkspace / extractPathArg / ensureParentDir', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'minions-harness-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('resolves relative paths under the workspace', () => {
    expect(resolveInWorkspace(root, 'app/page.tsx')).toBe(join(root, 'app', 'page.tsx'));
  });

  it('rejects path escapes', () => {
    expect(() => resolveInWorkspace(root, '../outside.txt')).toThrow(/escapes workspace/);
    expect(() => resolveInWorkspace(root, '..\\outside.txt')).toThrow(/escapes workspace/);
  });

  it('extracts paths from common tool-arg shapes', () => {
    expect(extractPathArg({ path: 'a/b.txt' })).toBe('a/b.txt');
    expect(extractPathArg({ file_path: 'x.ts' })).toBe('x.ts');
    expect(extractPathArg({ filePath: 'y.ts' })).toBe('y.ts');
    expect(extractPathArg({ filename: 'z.ts' })).toBe('z.ts');
    expect(extractPathArg({ content: 'no path' })).toBeUndefined();
    expect(extractPathArg(null)).toBeUndefined();
  });

  it('creates missing parent directories recursively', () => {
    const created = ensureParentDir(root, 'app/lib/deep/file.tsx');
    expect(created).toBeTruthy();
    expect(existsSync(join(root, 'app', 'lib', 'deep'))).toBe(true);
    // second call is a no-op
    expect(ensureParentDir(root, 'app/lib/deep/other.tsx')).toBeUndefined();
  });
});

describe('buildHarnessTools', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'minions-tools-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('registers bash, mkdir, write, create', () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    expect(tools.map((t) => t.name).sort()).toEqual([...HARNESS_TOOL_NAMES].sort());
  });

  it('mkdir creates nested directories', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const mkdir = tools.find((t) => t.name === 'mkdir')!;
    const res = await mkdir.handler({ path: 'a/b/c' });
    expect(existsSync(join(root, 'a', 'b', 'c'))).toBe(true);
    expect((res as { created: boolean }).created).toBe(true);
  });

  it('write creates parent directories automatically', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const write = tools.find((t) => t.name === 'write')!;
    await write.handler({ path: 'app/page.tsx', content: 'export default function P(){}' });
    expect(readFileSync(join(root, 'app', 'page.tsx'), 'utf8')).toContain('export default');
  });

  it('create writes nested paths (the original failure mode)', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const create = tools.find((t) => t.name === 'create')!;
    await create.handler({ path: 'lib/utils/format.ts', content: 'export const n = 1;' });
    expect(readFileSync(join(root, 'lib', 'utils', 'format.ts'), 'utf8')).toContain('export const n');
  });

  it('bash runs a command in the workspace and returns stdout', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const bash = tools.find((t) => t.name === 'bash')!;
    const res = await bash.handler({ command: 'node -e "console.log(1+1)"' }) as { exitCode: number; stdout: string };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('2');
  });

  it('bash mkdir -p works (the agent tried this and it failed)', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const bash = tools.find((t) => t.name === 'bash')!;
    const cmd = process.platform === 'win32' ? 'if not exist nested\\dir mkdir nested\\dir' : 'mkdir -p nested/dir';
    await bash.handler({ command: cmd });
    expect(existsSync(join(root, 'nested', 'dir'))).toBe(true);
  });

  it('bash reports non-zero exit codes without throwing', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const bash = tools.find((t) => t.name === 'bash')!;
    const res = await bash.handler({ command: 'node -e "process.exit(3)"' }) as { exitCode: number };
    expect(res.exitCode).toBe(3);
  });

  it('write rejects paths outside the workspace', async () => {
    const tools = buildHarnessTools({ workspaceRoot: root });
    const write = tools.find((t) => t.name === 'write')!;
    await expect(write.handler({ path: '../evil.txt', content: 'x' })).rejects.toThrow(/escapes workspace/);
  });
});

describe('withHarnessToolsAvailable / harnessEnabled', () => {
  it('harness defaults to on', () => {
    expect(harnessEnabled({})).toBe(true);
    expect(harnessEnabled({ tools: {} })).toBe(true);
    expect(harnessEnabled({ tools: { harness: true } })).toBe(true);
    expect(harnessEnabled({ tools: { harness: false } })).toBe(false);
  });

  it('merges harness names into a narrow allowlist', () => {
    const merged = withHarnessToolsAvailable(['grep', 'glob', 'view', 'create', 'edit'], undefined, {});
    expect(merged).toContain('bash');
    expect(merged).toContain('mkdir');
    expect(merged).toContain('write');
    expect(merged).toContain('grep');
  });

  it('respects excluded tools', () => {
    const merged = withHarnessToolsAvailable(['grep'], ['bash'], {});
    expect(merged).not.toContain('bash');
    expect(merged).toContain('mkdir');
  });

  it('returns undefined when available is unset (all tools allowed)', () => {
    expect(withHarnessToolsAvailable(undefined, undefined, {})).toBeUndefined();
  });

  it('skips injection when harness is disabled', () => {
    const merged = withHarnessToolsAvailable(['grep'], undefined, { tools: { harness: false } });
    expect(merged).toEqual(['grep']);
  });
});

describe('withHarnessToolsForAgent', () => {
  // Regression: custom-engineer's code-builder agent listed only file tools,
  // so bash/mkdir/write never reached the model even though the session had them.
  it('merges harness names into a per-agent tools allowlist', () => {
    const merged = withHarnessToolsForAgent(['grep', 'glob', 'view', 'write', 'edit'], {});
    expect(merged).toEqual(expect.arrayContaining(['bash', 'mkdir', 'write', 'create', 'grep', 'glob', 'view', 'edit']));
  });

  it('leaves null/undefined agent tools alone (all tools allowed)', () => {
    expect(withHarnessToolsForAgent(null, {})).toBeNull();
    expect(withHarnessToolsForAgent(undefined, {})).toBeUndefined();
  });

  it('respects excluded tools', () => {
    const merged = withHarnessToolsForAgent(['grep'], { tools: { excluded: ['bash', 'mkdir'] } });
    expect(merged).not.toContain('bash');
    expect(merged).not.toContain('mkdir');
    expect(merged).toContain('write');
  });

  it('does not inject when harness is disabled', () => {
    const merged = withHarnessToolsForAgent(['grep'], { tools: { harness: false } });
    expect(merged).toEqual(['grep']);
  });
});
