import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removePurgedPaths } from '../src/execution/retention.js';

let base: string;
let auditRoot: string;
let workspaceRoot: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ret-paths-'));
  auditRoot = join(base, 'audit');
  workspaceRoot = join(base, 'ws');
  outside = join(base, 'precious');
  for (const d of [auditRoot, workspaceRoot, outside]) mkdirSync(d, { recursive: true });
});
afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* windows lag */ } });

describe('removePurgedPaths confinement', () => {
  it('removes files inside the audit root and .audit dirs inside the workspace', () => {
    const a = join(auditRoot, 'run1.jsonl');
    writeFileSync(a, 'x');
    const legacy = join(workspaceRoot, 'run2', '.audit');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'e.json'), '{}');
    expect(removePurgedPaths([a, legacy], { auditRoot, workspaceRoot })).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
  });

  it('never deletes paths outside the trusted roots, the roots themselves, or non-.audit workspace dirs', () => {
    const victim = join(outside, 'keep.txt');
    writeFileSync(victim, 'keep');
    const wsDir = join(workspaceRoot, 'project');
    mkdirSync(wsDir, { recursive: true });
    const traversal = join(auditRoot, '..', 'precious', 'keep.txt');
    const removed = removePurgedPaths([victim, traversal, auditRoot, workspaceRoot, wsDir, '', outside], { auditRoot, workspaceRoot });
    expect(removed).toBe(0);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(wsDir)).toBe(true);
    expect(existsSync(auditRoot)).toBe(true);
  });
});