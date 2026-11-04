import { applyRunFeedback, collectFailures, distillEpisode, uniqueFiles, type Observation } from './lessons.js';
import { clip } from './text.js';
import type { MemoryStore } from './store.js';
import type { MemoryEpisode, MemoryNode, ResolvedMemoryConfig } from './types.js';

/**
 * Captures what a run actually did so it can be learned from.
 *
 * Fed from the same SDK events the runners already handle, so no extra
 * instrumentation is needed. `finish()` is called from a `finally`: failed and
 * aborted runs are the most valuable memories, not an exception.
 */
export interface CollectorOptions {
  store: MemoryStore;
  config: ResolvedMemoryConfig;
  /** Agent dataset the episode's lessons land in (`agent:<name>`). */
  dataset: string;
  agentId: string;
  runId?: string;
  sessionId?: string;
  threadId?: string;
  task?: string;
  /** Opt-in LLM distillation (`distill: 'llm'`); absent → heuristic lessons. */
  summarize?: (input: { episode: MemoryEpisode; failures: import('./types.js').ToolFailure[] }) => Promise<string | undefined>;
}

export interface CollectorOutcome {
  episode?: MemoryEpisode;
  lessons: MemoryNode[];
  promoted: number;
  feedbackApplied: number;
}

export class RunMemoryCollector {
  private observations: Observation[] = [];
  private injected: string[] = [];
  private runError: string | undefined;
  private summary: string | undefined;
  private finished = false;
  private runId: string | undefined;

  constructor(private readonly opts: CollectorOptions) {
    this.runId = opts.runId;
  }

  /** The run id only exists after the runner creates the run row — attach it then. */
  setRunId(runId: string | undefined): void {
    this.runId = runId;
  }

  get injectedIds(): string[] { return [...this.injected]; }
  get failureCount(): number { return this.observations.filter((o) => o.success === false).length; }

  noteToolStart(tool: string, args?: unknown): void {
    this.observations.push({
      tool: tool || 'tool',
      args,
      command: extractCommand(args),
      path: extractPath(args),
    });
  }

  noteToolResult(tool: string, args: unknown, success: boolean | undefined, output?: string): void {
    const verdict = interpretResult(success, output);
    const pending = [...this.observations].reverse().find((o) => o.tool === (tool || 'tool') && o.success === undefined);
    if (pending) {
      pending.success = verdict.ok;
      pending.error = verdict.ok ? undefined : verdict.error;
      if (!pending.command) pending.command = extractCommand(args);
      if (!pending.path) pending.path = extractPath(args);
      return;
    }
    this.observations.push({
      tool: tool || 'tool',
      args,
      success: verdict.ok,
      error: verdict.ok ? undefined : verdict.error,
      command: extractCommand(args),
      path: extractPath(args),
    });
  }

  setInjected(nodeIds: string[]): void {
    this.injected = [...new Set(nodeIds.filter(Boolean))];
  }

  setRunError(message: string | undefined): void {
    if (message) this.runError = message;
  }

  setSummary(text: string | undefined): void {
    if (text) this.summary = clip(text, 1000);
  }

  /** Idempotent: safe to call from a `finally` after an explicit success call. */
  async finish(outcome: 'done' | 'failed' | 'aborted'): Promise<CollectorOutcome> {
    if (this.finished) return { lessons: [], promoted: 0, feedbackApplied: 0 };
    this.finished = true;
    const cfg = this.opts.config;
    const { store } = this.opts;

    const failures = cfg.capture.toolFailures ? collectFailures(this.observations, cfg.capture.commands) : [];
    const files = uniqueFiles(this.observations);
    const commands = cfg.capture.commands
      ? [...new Set(this.observations.map((o) => o.command).filter((c): c is string => Boolean(c)))].slice(0, 60)
      : [];

    let episode: MemoryEpisode | undefined;
    if (cfg.capture.episodes) {
      episode = store.insertEpisode({
        run_id: this.runId ?? null,
        agent_id: this.opts.agentId,
        session_id: this.opts.sessionId ?? null,
        thread_id: this.opts.threadId ?? null,
        task: this.opts.task ?? null,
        outcome,
        error: this.runError ?? (failures[0]?.error ?? null),
        summary: this.summary ?? null,
        memory_injected_json: JSON.stringify(this.injected),
        tool_failures_json: JSON.stringify(failures.map((f) => ({
          tool: f.tool,
          error: clip(f.error, 500),
          command: f.command ?? null,
          path: f.path ?? null,
        }))),
        files_touched_json: JSON.stringify(files),
        commands_json: JSON.stringify(commands),
      });
    }

    let lessons: MemoryNode[] = [];
    let promoted = 0;
    if (episode && (failures.length || this.observations.length)) {
      const distilled = await distillEpisode(store, cfg, episode, this.observations, { summarize: this.opts.summarize });
      lessons = distilled.lessons;
      promoted = distilled.promoted;
    }

    // Feedback applies to what the run actually READ. A freshly learned lesson
    // must not be penalised for the failure that produced it.
    const feedbackApplied = applyRunFeedback(store, this.injected, outcome, this.runId);
    return { episode, lessons, promoted, feedbackApplied };
  }
}

/**
 * Turn a tool result into a success verdict.
 *
 * The harness `bash` tool intentionally RETURNS `{ exitCode, stdout, stderr }`
 * instead of throwing (so the model can read the failure), which the SDK reports
 * as a successful call. Without inspecting the payload, every failing build/test
 * command would look like a success and nothing would be learned.
 */
export function interpretResult(success: boolean | undefined, output: string | undefined): { ok: boolean; error?: string } {
  const text = typeof output === 'string' ? output.trim() : '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { exitCode?: unknown; stderr?: string; stdout?: string; error?: string; success?: boolean };
      if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) {
        const detail = (parsed.stderr?.trim() || parsed.stdout?.trim() || `exit code ${parsed.exitCode}`);
        return { ok: false, error: `exit code ${parsed.exitCode}: ${detail}` };
      }
      if (typeof parsed.success === 'boolean' && !parsed.success) {
        return { ok: false, error: parsed.error ?? 'tool reported failure' };
      }
    } catch { /* not JSON — fall through */ }
  }
  if (success === false) return { ok: false, error: text || 'tool reported failure' };
  return { ok: true };
}

function extractCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const v = (args as { command?: unknown }).command;
  return typeof v === 'string' && v.trim() ? clip(v.trim(), 300) : undefined;
}

export function extractPath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'file_path', 'filename', 'file', 'target', 'targetPath']) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\\/g, '/');
  }
  return undefined;
}
