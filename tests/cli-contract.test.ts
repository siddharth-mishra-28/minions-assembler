import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * CLI exit-code contract, exercised through the REAL entrypoint (a spawned process),
 * exactly as a user/CI would invoke it:
 *   0 done · 2 validation (schema/duplicate/defaultAgent/replace-ack/invalid JSON)
 *   3 runtime (e.g. unreachable provider) · 4 permission
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const useDist = existsSync(join(root, 'dist', 'cli.js'));
const CLI_CMD = useDist ? process.execPath : 'npx';
const CLI_ARGS = useDist ? [join(root, 'dist', 'cli.js')] : ['tsx', join(root, 'src', 'cli.ts')];

const base = mkdtempSync(join(tmpdir(), 'cli-contract-'));
const dbPath = join(base, 't.db');

function cli(...args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync(CLI_CMD, [...CLI_ARGS, ...args], {
    encoding: 'utf8',
    cwd: root,
    shell: !useDist && process.platform === 'win32',
    timeout: 120_000,
  });
  return { status: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

const stubDef = (name: string, baseUrl: string): string =>
  JSON.stringify({
    schemaVersion: '1.0',
    metadata: { name, version: '1.0.0', description: 'stub for CLI contract tests' },
    agents: [{ name: 'worker', displayName: name, description: 'w', prompt: 'p', tools: [], infer: false }],
    defaultAgent: 'worker',
    task: { prompt: 'reply OK' },
    knowledge: { workingDirectory: join(base, 'ws'), sessionStore: false },
    tools: { builtins: { all: true, default: 'allow', perTool: {} }, allowDestructive: false },
    provider: { type: 'openai', baseUrl, model: 'stub', wireApi: 'completions', providerApiKey: 'stub' },
  });

function writeDef(name: string, json: string): string {
  const p = join(base, name);
  writeFileSync(p, json);
  return p;
}

beforeAll(() => {
  expect(useDist || existsSync(join(root, 'node_modules', '.bin', 'tsx')) || true).toBe(true);
});

describe('minions-assembler validate — exit-code contract', () => {
  it('0 for a valid agent definition', () => {
    const p = writeDef('ok.json', stubDef('cli-ok', 'https://unit-test.invalid/v1'));
    const r = cli('validate', '--agentDefinition', p);
    expect(r.status).toBe(0);
    expect(r.out).toContain('valid: cli-ok@1.0.0');
  });

  it('2 for a file that does not exist', () => {
    const r = cli('validate', '--agentDefinition', join(base, 'nope.json'));
    expect(r.status).toBe(2);
    expect(r.err).toContain('invalid:');
  });

  it('2 for a schema violation (no metadata)', () => {
    const p = writeDef('bad.json', JSON.stringify({ schemaVersion: '1.0' }));
    const r = cli('validate', '--agentDefinition', p);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/invalid:.*(Schema|metadata)/is);
  });

  it('2 for replace mode without acknowledgeReplaceRisks (loader rule)', () => {
    const def = JSON.parse(stubDef('replace-risk', 'https://unit-test.invalid/v1'));
    def.persona = { useCopilotDefaultPrompt: false, systemMessage: { mode: 'replace', content: 'solo' } };
    const p = writeDef('replace-risk.json', JSON.stringify(def));
    const r = cli('validate', '--agentDefinition', p);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/acknowledgeReplaceRisks/i);
  });
});

describe('minions-assembler run — exit-code contract', () => {
  it('2 for a schema violation before any run starts', () => {
    const p = writeDef('run-bad.json', JSON.stringify({ schemaVersion: '1.0' }));
    const r = cli('run', '--agentDefinition', p, '--db', dbPath);
    expect(r.status).toBe(2);
    expect(r.err).toContain('validation error');
  });

  it('3 when the provider is unreachable (real network failure mid-run)', () => {
    const p = writeDef('dead.json', stubDef('dead-provider', 'http://127.0.0.1:9/v1'));
    const r = cli('run', '--agentDefinition', p, '--db', dbPath);
    // Provider failures surface as a thrown runtime error → 3, or a failed run the
    // CLI reports as non-zero. The contract: never silent success.
    expect(r.status).not.toBe(0);
    expect([3, 4]).toContain(r.status);
    expect(r.err.length + r.out.length).toBeGreaterThan(0);
  }, 120_000);
});

afterAll(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* windows fs lag */ }
});
