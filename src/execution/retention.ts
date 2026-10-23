import { rmSync, statSync, existsSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { PlatformStore, PurgeResult, RetentionScope } from '../store/platform.js';

const inside = (root: string, target: string): boolean => {
  const r = resolve(root);
  const t = resolve(target);
  return t !== r && t.startsWith(r.endsWith(sep) ? r : r + sep);
};

/**
 * Delete files recorded by a purge. Only paths inside a trusted root are touched: the audit
 * root, or (legacy runs) a `.audit` directory / single transcript file inside the workspace.
 */
export function removePurgedPaths(paths: string[], roots: { auditRoot: string; workspaceRoot: string }): number {
  let removed = 0;
  for (const p of new Set(paths)) {
    try {
      if (!p || !existsSync(p)) continue;
      const abs = resolve(p);
      const isDir = statSync(abs).isDirectory();
      const ok = inside(roots.auditRoot, abs) || (inside(roots.workspaceRoot, abs) && (isDir ? basename(abs) === '.audit' : true));
      if (!ok) continue;
      rmSync(abs, { recursive: isDir, force: true });
      removed++;
    } catch { /* best-effort: a locked file is retried by the next sweep only if still referenced */ }
  }
  return removed;
}

export interface RetentionRunResult extends PurgeResult { filesRemoved: number; dryRun?: boolean }

/** Runs the retention sweep at startup and on an interval; also callable on demand from the API. */
export class RetentionService {
  private timer: NodeJS.Timeout | undefined;
  lastRun: { at: string; result: RetentionRunResult } | undefined;

  constructor(private readonly platform: PlatformStore, private readonly roots: { auditRoot: string; workspaceRoot: string }) {}

  runOnce(opts?: { days?: number; scope?: RetentionScope; keepPinned?: boolean }): RetentionRunResult {
    this.platform.expireStaleApprovals();
    const purge = this.platform.purge(opts);
    const filesRemoved = removePurgedPaths(purge.paths, this.roots);
    const result: RetentionRunResult = { ...purge, filesRemoved };
    this.lastRun = { at: new Date().toISOString(), result };
    return result;
  }

  start(intervalMs = 60 * 60 * 1000): void {
    try { this.runOnce(); } catch { /* never block startup on a sweep */ }
    this.timer = setInterval(() => { try { this.runOnce(); } catch { /* retry next tick */ } }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
