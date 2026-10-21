import type { AgentDefinition, ToolBuiltinsPolicy, ToolDecision } from '../core/types.js';

/**
 * Curated registry of built-in Copilot CLI tools for the wizard checkbox grid.
 *
 * The runtime's tool inventory is version-dependent and not exhaustively
 * documented upstream, so this list is *presentational*: it seeds the wizard
 * and covers the common cases. Effective control always happens via
 * source-qualified availableTools/excludedTools patterns (`builtin:*`,
 * `builtin:<name>`, `mcp:*`, `mcp:<server>-<tool>`, `custom:<name>`, bare
 * names) plus the per-tool permission layer; unknown names are accepted as
 * freeform entries and still work through the patterns.
 */
export interface BuiltinToolInfo {
  name: string;
  description: string;
  /** Wizard grouping. */
  group: 'files' | 'search' | 'execution' | 'session';
}

export const BUILTIN_TOOLS: BuiltinToolInfo[] = [
  { name: 'bash', group: 'execution', description: 'Run shell commands in the workspace (installs, builds, tests, git).' },
  { name: 'read', group: 'files', description: 'Read file contents, including line ranges.' },
  { name: 'view', group: 'files', description: 'View a file, image, or directory listing.' },
  { name: 'write', group: 'files', description: 'Write or overwrite a file (harness version auto-creates parent dirs).' },
  { name: 'create', group: 'files', description: 'Create a new file (harness version creates nested parents).' },
  { name: 'edit', group: 'files', description: 'Apply targeted string replacements inside an existing file.' },
  { name: 'grep', group: 'search', description: 'Search file contents with a regex across the workspace.' },
  { name: 'glob', group: 'search', description: 'Find files by glob pattern.' },
  { name: 'ls', group: 'search', description: 'List directory contents.' },
  { name: 'tool_search_tool', group: 'session', description: 'Discover deferred tools on demand (toolSearch).' },
  { name: 'task', group: 'session', description: 'Delegate a scoped sub-task to a custom sub-agent.' },
  { name: 'skill', group: 'session', description: 'Load a registered SKILL.md skill into context.' },
  { name: 'ask_user', group: 'session', description: 'Ask the operator a clarifying question.' },
  { name: 'task_complete', group: 'session', description: 'Mark the delegated task complete.' },
  { name: 'report', group: 'session', description: 'Report structured findings back to the host.' },
];

/** Provenance of the curated list, surfaced in the UI and README. */
export const BUILTIN_TOOLS_SOURCE =
  'Curated from @github/copilot-sdk toolSet BuiltInTools.Isolated + the nodejs README built-in tool examples + Copilot CLI tool-search docs. Runtime inventory is version-dependent; unlisted names are accepted as freeform.';

export type BuiltinToolFlag = 'allow' | 'ask' | 'deny';

/** A wizard row: one tool with its 3-way decision. */
export interface BuiltinToolFlagRow {
  tool: string;
  decision: BuiltinToolFlag;
}

const PER_TOOL_PREFIXES = ['builtin:', 'custom:', 'mcp:'] as const;

/**
 * Normalize per-tool decision keys: bare names stay; source-qualified names
 * keep the source (except bare-name lookup happens against every variant).
 * Returns a map key → decision, plus a bare-name index for permission checks.
 */
export function normalizePerToolDecisions(perTool: Record<string, BuiltinToolFlag> | undefined): {
  qualified: Map<string, BuiltinToolFlag>;
  bare: Map<string, BuiltinToolFlag>;
} {
  const qualified = new Map<string, BuiltinToolFlag>();
  const bare = new Map<string, BuiltinToolFlag>();
  for (const [raw, decision] of Object.entries(perTool ?? {})) {
    const key = String(raw).trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    qualified.set(key, decision);
    const matched = PER_TOOL_PREFIXES.find((p) => lower.startsWith(p));
    bare.set(matched ? lower.slice(matched.length) : lower, decision);
  }
  return { qualified, bare };
}

export interface BuiltinsResolution {
  /** Final `availableTools` for the session (undefined = everything available). */
  availableTools: string[] | undefined;
  /** Final `excludedTools` for the session. */
  excludedTools: string[] | undefined;
  /** Per-tool decision map (qualified keys) for the permission hooks. */
  decisions: Map<string, BuiltinToolFlag>;
  /** Posture for tools without a decision entry. */
  defaultDecision: BuiltinToolFlag;
  /** Whether destructive operations are permitted. */
  allowDestructive: boolean;
  /** Whether the built-in CLI toolset is fully available. */
  allBuiltins: boolean;
  /** Compact description for the audit trail / UI. */
  summary: string;
}

/**
 * Resolve `tools.builtins` (+ `tools.available`/`excluded`/`allowDestructive`)
 * into concrete session options and permission-hook policy.
 *
 * Semantics (excluded wins over allow in the SDK, so `all:false` is expressed
 * as an explicit availability allowlist rather than a `builtin:*` exclusion):
 * - `all: true` (default) → availableTools stays undefined: every built-in,
 *   MCP and custom tool is in front of the model.
 * - `all: false` → `availableTools` = `mcp:*` + `custom:*` + one
 *   `builtin:<name>` per perTool-"allow" (or bare name) entry; unselected
 *   built-ins drop out. MCP/custom tools keep their own sources.
 * - perTool decisions shape the *permission layer*, not availability — an
 *   `allow` decision just pre-clears a call; `ask`/`deny` go to
 *   compilePermissionHandlers which resolves `ask` as an audited deny in
 *   headless runs.
 */
export function resolveBuiltinTools(def: Pick<AgentDefinition, 'tools'>): BuiltinsResolution {
  const policy: ToolBuiltinsPolicy | undefined = def.tools?.builtins;
  const defaultDecision = policy?.default ?? 'allow';
  const allBuiltins = policy?.all !== false;
  const allowDestructive = def.tools?.allowDestructive === true;
  const { qualified, bare } = normalizePerToolDecisions(policy?.perTool);

  const denyEntries = [...qualified.entries()].filter(([, d]) => d === 'deny').map(([k]) => k);
  const allowBare = [...bare.entries()].filter(([, d]) => d === 'allow').map(([k]) => k);

  const excludedTools = unionUnique(def.tools?.excluded, denyEntries);

  let availableTools: string[] | undefined;
  const defAvailable = def.tools?.available;
  if (!allBuiltins) {
    availableTools = unionUnique(['mcp:*', 'custom:*'], allowBare.map((n) => `builtin:${n}`));
  } else if (defAvailable) {
    availableTools = defAvailable; // explicit allowlist from the definition wins as-is (harness merge happens later)
  }

  const summary = [
    `builtins=${allBuiltins ? 'all' : 'selected(' + allowBare.length + ')'}`,
    `default=${defaultDecision}`,
    `perTool=${qualified.size}`,
    `excluded=${excludedTools?.length ?? 0}`,
    `destructive=${allowDestructive ? 'allowed' : 'gated'}`,
  ].join(' ');

  return { availableTools, excludedTools, decisions: qualified, defaultDecision, allowDestructive, allBuiltins, summary };
}

function unionUnique(...lists: (string[] | undefined)[]): string[] | undefined {
  const out = new Set<string>();
  for (const list of lists) for (const v of list ?? []) if (v) out.add(v);
  return out.size ? [...out] : undefined;
}

const DESTRUCTIVE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\b[^;&|]*\s(-[a-z]*r[a-z]*|--recursive)\b/i, why: 'recursive rm' },
  { re: /\bdel\b\s+\/[sqz]/i, why: 'windows del /s|/q' },
  { re: /\brd\b\s+\/s/i, why: 'rd /s' },
  { re: /Remove-Item\s+(.*-Recurse|-Force)/i, why: 'Remove-Item -Recurse/-Force' },
  { re: /\bdrop\s+(table|database|schema|index|view)\b/i, why: 'SQL DROP' },
  { re: /\btruncate\s+(table|)\b/i, why: 'SQL TRUNCATE' },
  { re: /\bgit\s+push\b[^;&|]*--force/i, why: 'git forced push' },
  { re: /\bgit\s+reset\b[^;&|]*--hard/i, why: 'git reset --hard' },
  { re: /\bgit\s+clean\b[^;&|]*-[a-z]*[fdx]/i, why: 'git clean' },
  { re: /\bkubectl\s+(delete|drain)\b/i, why: 'kubectl delete/drain' },
  { re: /\b(taskkill|tskill)\b/i, why: 'process kill (taskkill)' },
  { re: /\b(pkill|killall)\b/i, why: 'process kill' },
  { re: /\bkill\s+(-\S+|\d+|%|\$)/i, why: 'process kill' },
  { re: /\bStop-Process\b/i, why: 'process kill (Stop-Process)' },
  { re: /\bkill-port\b/i, why: 'process kill (kill-port)' },
  { re: /\b(npm|yarn|pnpm)\s+(uninstall|rm|remove)\b/i, why: 'package removal' },
  { re: /\bsudo\b/i, why: 'sudo ( destructive/privilege )' },
];

/** MCP tools whose names signal update/delete-type destructive operations. */
const DESTRUCTIVE_MCP_RE = /(?:^|[:_\/-])(delete|remove|drop|truncate|destroy|purge|erase|wipe|overwrite|force-?update)(?:$|[_\/-])/i;

export interface DestructiveVerdict {
  decision: 'deny';
  reason: string;
  pattern: string | 'mcp-name';
}

/**
 * Heuristic destructive gate (active unless `tools.allowDestructive: true`).
 * Applies to command-running tool args (shell commands) and to MCP tool
 * calls whose wire name signals delete/update-style operations. Returns
 * undefined when nothing destructive was detected.
 */
export function evaluateDestructive(toolName: string, toolArgs: unknown, opts?: { mcp?: boolean }): DestructiveVerdict | undefined {
  const name = String(toolName ?? '');
  const command =
    typeof (toolArgs as { command?: unknown })?.command === 'string' ? String((toolArgs as { command: string }).command) : '';
  if (opts?.mcp) {
    if (DESTRUCTIVE_MCP_RE.test(name)) {
      return {
        decision: 'deny',
        reason: `destructive gate: MCP tool '${name}' looks like an update/delete operation — set tools.allowDestructive=true to permit destructive operations`,
        pattern: 'mcp-name',
      };
    }
    return undefined;
  }
  if (!command) return undefined;
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(command)) {
      return {
        decision: 'deny',
        reason: `destructive gate: ${p.why} in '${command.slice(0, 120)}' — set tools.allowDestructive=true to permit destructive operations`,
        pattern: p.why,
      };
    }
  }
  return undefined;
}
