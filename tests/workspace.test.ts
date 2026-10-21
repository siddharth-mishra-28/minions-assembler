import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveChatWorkspace, resolveWorkspace } from '../src/core/workspace.js';

const dir = mkdtempSync(join(tmpdir(), 'workspace-resolve-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('resolveChatWorkspace — README 4.2 precedence', () => {
  it('the definition workspace wins over the per-thread fallback folder', () => {
    const ws = join(dir, 'agent-ws');
    const threadDir = join(dir, '.chats', 'chat_x');
    expect(resolveChatWorkspace({ knowledge: { workingDirectory: ws } }, threadDir)).toBe(resolve(ws));
  });

  it('falls back to the caller folder when the definition declares no workspace', () => {
    const threadDir = join(dir, '.chats', 'chat_y');
    expect(resolveChatWorkspace({}, threadDir)).toBe(resolve(threadDir));
    expect(resolveChatWorkspace({ knowledge: {} }, threadDir)).toBe(resolve(threadDir));
  });

  it('ignores blank workspace values instead of resolving them', () => {
    const threadDir = join(dir, '.chats', 'chat_z');
    expect(resolveChatWorkspace({ knowledge: { workingDirectory: '   ' } }, threadDir)).toBe(resolve(threadDir));
  });
});

describe('resolveWorkspace — definition/env/cwd chain', () => {
  it('creates a missing definition workspace and reports the source', () => {
    const ws = join(dir, 'created-ws');
    const r = resolveWorkspace(ws);
    expect(r.root).toBe(resolve(ws));
    expect(r.source).toBe('definition');
    expect(existsSync(r.root)).toBe(true);
  });

  it('definition override wins over MINION_WORKSPACE', () => {
    const prev = process.env.MINION_WORKSPACE;
    process.env.MINION_WORKSPACE = join(dir, 'env-ws');
    try {
      const r = resolveWorkspace(join(dir, 'def-ws'));
      expect(r.source).toBe('definition');
      expect(r.root).toBe(resolve(join(dir, 'def-ws')));
    } finally {
      if (prev === undefined) delete process.env.MINION_WORKSPACE;
      else process.env.MINION_WORKSPACE = prev;
    }
  });
});
