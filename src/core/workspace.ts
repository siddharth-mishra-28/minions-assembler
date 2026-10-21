import { mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scrubSecrets } from '../agents/loader.js';

/**
 * Workspace resolution for agent runs:
 * 1. definition `knowledge.workingDirectory` (per-agent override)
 * 2. `MINION_WORKSPACE` env var (server/CLI-wide default)
 * 3. process.cwd() (project root)
 * Resolved to an absolute path; created if missing.
 */
export function resolveWorkspace(defOverride?: string): { root: string; source: 'definition' | 'env' | 'cwd' } {
  const fromDef = defOverride?.trim();
  if (fromDef) {
    const root = resolve(fromDef);
    mkdirSync(root, { recursive: true });
    return { root, source: 'definition' };
  }
  const fromEnv = process.env.MINION_WORKSPACE?.trim();
  if (fromEnv) {
    const root = resolve(fromEnv);
    mkdirSync(root, { recursive: true });
    return { root, source: 'env' };
  }
  return { root: process.cwd(), source: 'cwd' };
}

/**
 * Session root for chat turns (README 4.2 precedence): the definition's
 * `knowledge.workingDirectory` is the agent workspace "where agents read/write
 * files", so it wins when declared; the caller's per-thread folder is only the
 * fallback for agents without one.
 */
export function resolveChatWorkspace(def: { knowledge?: { workingDirectory?: string } }, fallbackDir: string): string {
  const defWs = def.knowledge?.workingDirectory?.trim();
  return resolve(defWs ? defWs : fallbackDir);
}

/** Structured, leveled JSONL server log file (secrets scrubbed) for auditing outside the DB. */
export class ServerLog {
  private file: string | null = null;
  constructor(root: string) {
    try {
      const logDir = resolve(root, '.minion');
      mkdirSync(logDir, { recursive: true });
      this.file = join(logDir, 'server.log.jsonl');
    } catch { /* logging is best-effort; never break the server */ }
  }
  get path(): string | null { return this.file; }
  write(level: 'info' | 'warn' | 'error' | 'audit', event: string, details: Record<string, unknown> = {}): void {
    if (!this.file) return;
    const rec = {
      ts: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      ...scrubSecrets(details) as Record<string, unknown>,
    };
    try { appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best-effort */ }
  }
}
