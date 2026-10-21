import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentDefinition } from '../core/types.js';

const execFileAsync = promisify(execFile);

/** Default per-turn budget: 45 minutes. Multi-file coding builds need far more than 10. */
export const DEFAULT_TURN_TIMEOUT_MS = 45 * 60 * 1000;
export const MAX_TURN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const MIN_TURN_TIMEOUT_MS = 1000;

/**
 * Resolve the per-turn `sendAndWait` budget.
 * Priority: API body override > definition.runtime.turnTimeoutMs > RUN_TURN_TIMEOUT_MS env > default.
 */
export function resolveTurnTimeoutMs(definition: Pick<AgentDefinition, 'runtime'>, bodyOverride?: number): number {
  const clamp = (n: number) => Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(n)));
  if (bodyOverride != null && Number.isFinite(bodyOverride) && bodyOverride > 0) return clamp(bodyOverride);
  const fromDef = definition.runtime?.turnTimeoutMs;
  if (fromDef != null && Number.isFinite(fromDef) && fromDef > 0) return clamp(fromDef);
  const fromEnv = process.env.RUN_TURN_TIMEOUT_MS;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return clamp(n);
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

/** Normalize a tool path against the workspace root. Rejects escapes above the root. */
export function resolveInWorkspace(workspaceRoot: string, rawPath: string): string {
  const root = resolve(workspaceRoot);
  const cleaned = String(rawPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const rel = abs.toLowerCase();
  const rootLc = root.toLowerCase();
  if (rel !== rootLc && !rel.startsWith(rootLc + sep) && !rel.startsWith(rootLc + '/')) {
    throw new Error(`Path escapes workspace: ${rawPath}`);
  }
  return abs;
}

/** Pull a filesystem path out of common tool-arg shapes (create/edit/write/view). */
export function extractPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'file_path', 'filename', 'file', 'target', 'targetPath', 'destination']) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Ensure the parent directory of a file path exists (recursive).
 * Used both as a pre-tool hook for built-in `create`/`edit` and by the `write` tool.
 */
export function ensureParentDir(workspaceRoot: string, rawPath: string): string | undefined {
  const abs = resolveInWorkspace(workspaceRoot, rawPath);
  const parent = dirname(abs);
  if (existsSync(parent)) return undefined;
  mkdirSync(parent, { recursive: true });
  return parent;
}

const PATH_HINT = 'All paths are relative to the workspace root itself (do NOT repeat the workspace folder name).';

const SHELL_TOOL_DESCRIPTION =
  'Run a shell command in the agent workspace (like a coding-agent bash tool). ' +
  'Use for package installs, scaffolding, builds, tests, git, and mkdir -p. ' +
  'Returns stdout, stderr, and the exit code. Prefer the dedicated file tools for simple file edits. ' +
  PATH_HINT;

const MKDIR_TOOL_DESCRIPTION =
  'Create a directory (and any missing parents) inside the agent workspace. ' +
  'Equivalent to mkdir -p. Use this before create/write when you need a new nested folder. ' +
  PATH_HINT;

const WRITE_TOOL_DESCRIPTION =
  'Write a UTF-8 file inside the agent workspace, creating any missing parent directories automatically. ' +
  'Use this instead of create for nested paths (e.g. app/page.tsx). Overwrites existing content; use edit for partial changes. ' +
  PATH_HINT;

interface ToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  skipPermission?: boolean;
  overridesBuiltInTool?: boolean;
  defer?: 'never';
}

export interface HarnessToolContext {
  workspaceRoot: string;
  /** Called with a short line whenever a harness tool runs (for the audit trail). */
  onToolEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** Per-command timeout for bash. Default 120s. */
  shellTimeoutMs?: number;
}

/**
 * Coding-harness tools injected into every session unless `tools.harness === false`.
 * These restore the capabilities a regular GitHub Copilot coding agent has:
 * shell execution, recursive mkdir, and parent-dir-safe file writes.
 */
export function buildHarnessTools(ctx: HarnessToolContext): ToolLike[] {
  const shellTimeoutMs = ctx.shellTimeoutMs ?? 120_000;
  const log = (type: string, payload: Record<string, unknown>) => {
    try { ctx.onToolEvent?.(type, payload); } catch { /* best-effort */ }
  };

  const bash: ToolLike = {
    name: 'bash',
    description: SHELL_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Optional working directory relative to the workspace root' },
        timeoutMs: { type: 'number', description: `Optional per-command timeout in ms (default ${shellTimeoutMs})` },
      },
      required: ['command'],
    },
    skipPermission: true,
    overridesBuiltInTool: true,
    defer: 'never',
    handler: async (args) => {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('bash: command is required');
      const cwd = args.cwd ? resolveInWorkspace(ctx.workspaceRoot, String(args.cwd)) : resolve(ctx.workspaceRoot);
      const timeout = Math.min(600_000, Math.max(1000, Number(args.timeoutMs) || shellTimeoutMs));
      log('harness.bash', { command: command.slice(0, 2000), cwd, timeoutMs: timeout });
      try {
        const { stdout, stderr } = await execFileAsync(command, {
          cwd,
          timeout,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          shell: true,
        });
        return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
      } catch (err) {
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
        if (e.killed) throw new Error(`bash: command timed out after ${timeout}ms: ${command.slice(0, 200)}`);
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message ?? String(err),
        };
      }
    },
  };

  const mkdir: ToolLike = {
    name: 'mkdir',
    description: MKDIR_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to create (relative to the workspace root)' },
        recursive: { type: 'boolean', description: 'Create parent directories (default true)' },
      },
      required: ['path'],
    },
    skipPermission: true,
    overridesBuiltInTool: true,
    defer: 'never',
    handler: async (args) => {
      const raw = String(args.path ?? '').trim();
      if (!raw) throw new Error('mkdir: path is required');
      const abs = resolveInWorkspace(ctx.workspaceRoot, raw);
      const recursive = args.recursive !== false;
      mkdirSync(abs, { recursive });
      log('harness.mkdir', { path: raw, recursive });
      return { created: true, path: raw, absolutePath: abs, recursive };
    },
  };

  const write: ToolLike = {
    name: 'write',
    description: WRITE_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'UTF-8 file contents' },
        append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
      },
      required: ['path', 'content'],
    },
    skipPermission: true,
    // Override the built-in write if the runtime ships one, so parent dirs always work.
    overridesBuiltInTool: true,
    defer: 'never',
    handler: async (args) => {
      const raw = String(args.path ?? '').trim();
      const content = args.content == null ? '' : String(args.content);
      if (!raw) throw new Error('write: path is required');
      const abs = resolveInWorkspace(ctx.workspaceRoot, raw);
      ensureParentDir(ctx.workspaceRoot, raw);
      if (args.append) appendFileSync(abs, content, 'utf8');
      else writeFileSync(abs, content, 'utf8');
      log('harness.write', { path: raw, bytes: content.length, append: !!args.append });
      return { written: true, path: raw, bytes: Buffer.byteLength(content, 'utf8'), append: !!args.append };
    },
  };

  // `create` override: the stock tool refuses nested paths when the parent is missing.
  // Same contract, but parents are created first so scaffolding works.
  const create: ToolLike = {
    name: 'create',
    description: 'Create a new file in the agent workspace, creating any missing parent directories. Overwrites if the file already exists. ' + PATH_HINT,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'UTF-8 file contents' },
      },
      required: ['path', 'content'],
    },
    skipPermission: true,
    overridesBuiltInTool: true,
    defer: 'never',
    handler: async (args) => {
      const raw = String(args.path ?? '').trim();
      const content = args.content == null ? '' : String(args.content);
      if (!raw) throw new Error('create: path is required');
      const abs = resolveInWorkspace(ctx.workspaceRoot, raw);
      if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error(`create: path is a directory: ${raw}`);
      ensureParentDir(ctx.workspaceRoot, raw);
      writeFileSync(abs, content, 'utf8');
      log('harness.create', { path: raw, bytes: content.length });
      return { created: true, path: raw, bytes: Buffer.byteLength(content, 'utf8') };
    },
  };

  return [bash, mkdir, write, create];
}

/**
 * Names of the tools `buildHarnessTools` registers. Used to keep them available
 * even when a definition supplies an `availableTools` allowlist (they are
 * opt-out via `excluded` or `tools.harness: false`).
 */
export const HARNESS_TOOL_NAMES = ['bash', 'mkdir', 'write', 'create'] as const;

/** Whether the definition wants the coding harness (default true). */
export function harnessEnabled(def: Pick<AgentDefinition, 'tools'>): boolean {
  return def.tools?.harness !== false;
}

/**
 * Merge harness tool names into an `availableTools` allowlist so a narrow
 * list like ["grep","glob","view","create","edit"] still gets bash/mkdir/write.
 * Excluded tools always win.
 */
export function withHarnessToolsAvailable(available: string[] | undefined, excluded: string[] | undefined, def: Pick<AgentDefinition, 'tools'>): string[] | undefined {
  if (!harnessEnabled(def)) return available;
  const skip = new Set((excluded ?? []).map((t) => t.toLowerCase()));
  const extra = HARNESS_TOOL_NAMES.filter((n) => !skip.has(n) && !skip.has(`custom:${n}`) && !skip.has(`builtin:${n}`));
  if (!available) return undefined; // unset = everything available; harness tools ride along
  const have = new Set(available.map((t) => t.toLowerCase()));
  const merged = [...available];
  for (const n of extra) {
    if (!have.has(n) && !have.has(`custom:${n}`) && !have.has(`builtin:${n}`)) merged.push(n);
  }
  return merged;
}

/**
 * Same merge, but for a per-agent `tools` allowlist (`def.agents[].tools`).
 * A custom agent that lists only file tools would otherwise hide bash/mkdir
 * from the model even when the session has them registered.
 * Returns the input unchanged when the agent has no tools list (null/undefined
 * means "all tools"), or when the definition disabled the harness.
 */
export function withHarnessToolsForAgent(agentTools: string[] | null | undefined, def: Pick<AgentDefinition, 'tools'>): string[] | null | undefined {
  if (!agentTools) return agentTools;
  return withHarnessToolsAvailable(agentTools, def.tools?.excluded, def) ?? agentTools;
}

/**
 * Pre-tool hook addition: before a built-in create/edit/write runs, mkdir -p its
 * parent so nested paths never fail with "Parent directory does not exist".
 */
export function autoMkdirPreTool(workspaceRoot: string) {
  return async (input: { toolName?: string; tool?: string; toolArgs?: unknown }) => {
    const name = (input.toolName ?? input.tool ?? '').toLowerCase();
    if (name !== 'create' && name !== 'edit' && name !== 'write' && name !== 'str_replace_editor') return;
    const raw = extractPathArg(input.toolArgs);
    if (!raw) return;
    try {
      const created = ensureParentDir(workspaceRoot, raw);
      if (created) return { additionalContext: `Created parent directory ${created}` };
    } catch (e) {
      return { permissionDecision: 'deny' as const, permissionDecisionReason: `Cannot create parent directory: ${(e as Error).message}` };
    }
    return;
  };
}

/** Join helper re-exported for tests. */
export const pathJoin = join;
export const pathNormalize = normalize;
