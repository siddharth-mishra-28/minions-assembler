/* Agent-definition model helpers: loose JSON editing, normalisation, validation-error mapping. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Def = Record<string, any>;

export type SectionId = 'identity' | 'provider' | 'persona' | 'tools' | 'knowledge' | 'permissions' | 'advanced' | 'review';

export const SECTION_META: { id: SectionId; label: string; hint: string }[] = [
  { id: 'identity', label: 'Identity', hint: 'Name, version, description' },
  { id: 'provider', label: 'Provider & model', hint: 'Which LLM powers the agent' },
  { id: 'persona', label: 'Persona & task', hint: 'System prompt and default task' },
  { id: 'tools', label: 'Tools', hint: 'Built-in tools and MCP servers' },
  { id: 'knowledge', label: 'Knowledge', hint: 'Working folder and instructions' },
  { id: 'permissions', label: 'Permissions', hint: 'What it may do without asking' },
  { id: 'advanced', label: 'Sub-agents & runtime', hint: 'Skills, fleet mode, limits' },
  { id: 'review', label: 'Review & publish', hint: 'Validate and go live' },
];

export const agentIdOf = (def: Def): string => `${def.metadata?.name ?? ''}@${def.metadata?.version ?? ''}`;

export const parsePath = (p: string): (string | number)[] => p.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));

export function getIn(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of parsePath(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Immutable deep set; creates objects/arrays along the way. `undefined` deletes the key. */
export function setIn<T extends Def>(o: T, path: string, value: unknown): T {
  const keys = parsePath(path);
  const rec = (cur: unknown, i: number): unknown => {
    if (i === keys.length) return value;
    const k = keys[i];
    const base: Record<string | number, unknown> | unknown[] = Array.isArray(cur)
      ? [...cur]
      : cur && typeof cur === 'object'
        ? { ...(cur as object) }
        : typeof k === 'number'
          ? []
          : {};
    const next = rec((base as Record<string | number, unknown>)[k], i + 1);
    if (next === undefined && !Array.isArray(base)) delete (base as Record<string, unknown>)[k as string];
    else (base as Record<string | number, unknown>)[k] = next;
    return base;
  };
  return rec(o, 0) as T;
}

const NO_PRUNE = new Set(['custom', 'servers', 'parametersSchema', 'mcpServers', 'env', 'headers', 'attachments']);

function prune(v: unknown, key?: string): unknown {
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? undefined : t; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return undefined;
  if (key && NO_PRUNE.has(key)) return v;
  if (Array.isArray(v)) {
    const a = v.map((x) => prune(x)).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x, k);
      if (p !== undefined) o[k] = p;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return undefined;
}

/** Clean form state into the definition that is validated, saved and shown in the JSON tab. */
export function normalize(input: Def): Def {
  const d = (prune(input) ?? {}) as Def;
  d.schemaVersion = '1.0';
  const order = ['schemaVersion', 'metadata', 'provider', 'persona', 'task', 'instructions', 'knowledge', 'tools', 'mcp', 'agents', 'defaultAgent', 'skills', 'runtime', 'fleet'];
  const out: Def = {};
  for (const k of order) if (k in d) out[k] = d[k];
  for (const k of Object.keys(d)) if (!(k in out)) out[k] = d[k];
  const persona = out.persona as Def | undefined;
  if (persona) {
    const sm = persona.systemMessage as Def | undefined;
    if (sm) {
      if (sm.mode !== 'customize') delete sm.sections;
      if (sm.mode !== 'replace') delete sm.acknowledgeReplaceRisks;
      if (!sm.content && !sm.sections) delete persona.systemMessage;
    }
    if (persona.systemMessage?.mode === 'replace') persona.useCopilotDefaultPrompt = false;
    else if (typeof persona.useCopilotDefaultPrompt !== 'boolean') persona.useCopilotDefaultPrompt = true;
  }
  const rt = out.runtime as Def | undefined;
  if (rt && Object.keys(rt).length === 0) delete out.runtime;
  if (out.fleet && !out.fleet.enabled) delete out.fleet;
  return out;
}

/* ---------- tools & permissions ---------- */
export type Decision = 'allow' | 'ask' | 'deny';
export const READ_ONLY_TOOLS = ['view', 'read', 'grep', 'glob', 'ls', 'tool_search_tool', 'skill', 'task_complete', 'report'];
export const MUTATING_TOOLS = ['bash', 'write', 'create', 'edit'];
const READ_PRESET = Object.fromEntries(READ_ONLY_TOOLS.map((t) => [t, 'allow'])) as Record<string, Decision>;
const MUTATING_PRESET = Object.fromEntries(MUTATING_TOOLS.map((t) => [t, 'ask'])) as Record<string, Decision>;

export const emptyDefinition = (): Def => ({
  schemaVersion: '1.0',
  metadata: { name: '', version: '1.0.0', description: '', tags: [] },
  provider: { providerRef: '', model: '' },
  persona: { useCopilotDefaultPrompt: true, systemMessage: { mode: 'append', content: '' } },
  task: { prompt: '' },
  knowledge: { workingDirectory: '' },
  tools: { harness: true, permissionPolicy: 'pattern-list', builtins: { all: true, default: 'ask', perTool: { ...READ_PRESET, ...MUTATING_PRESET } } },
});

/* ---------- validation error mapping ---------- */
export interface Issue { path: string; message: string; section: SectionId }

export function sectionForPath(path: string): SectionId {
  if (path.startsWith('/metadata')) return 'identity';
  if (path.startsWith('/provider')) return 'provider';
  if (path.startsWith('/persona') || path.startsWith('/task')) return 'persona';
  if (path.startsWith('/knowledge') || path.startsWith('/instructions')) return 'knowledge';
  if (/^\/tools\/(builtins|permissionPolicy|patterns|allowDestructive)/.test(path)) return 'permissions';
  if (path.startsWith('/tools') || path.startsWith('/mcp')) return 'tools';
  if (/^\/(agents|defaultAgent|skills|runtime|fleet)/.test(path)) return 'advanced';
  return 'review';
}

const PROVIDER_MSG = 'Pick a configured provider, or enter type, base URL and API key';

export function parseIssues(message: string): Issue[] {
  const body = message.replace(/^Schema validation failed:\s*/i, '').replace(/\s*\(in [^)]*\)\s*$/, '');
  const issues: Issue[] = [];
  for (const raw of body.split(/;\s+(?=\/|[A-Za-z])/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\/\S*)\s+(.*)$/.exec(part);
    if (m) {
      let path = m[1] === '/' ? '' : m[1];
      let msg = m[2];
      const req = /must have required property '([^']+)'/.exec(msg);
      if (req) { path = `${path}/${req[1]}`; msg = 'This field is required'; }
      else if (/must match a schema in anyOf|must match "then" schema/.test(msg)) msg = path === '/provider' ? PROVIDER_MSG : path === '/persona/systemMessage' ? 'Add instructions (content) or section overrides' : 'Does not match any allowed shape';
      else if (/fewer than 1 characters/i.test(msg)) msg = 'Cannot be empty';
      else if (/equal to one of the allowed values/.test(msg)) msg = 'Pick one of the allowed values';
      else if (/must match pattern/.test(msg)) msg = 'Invalid format';
      issues.push({ path, message: msg, section: sectionForPath(path) });
      continue;
    }
    let path = '/';
    if (/acknowledgeReplaceRisks|systemMessage/i.test(part)) path = '/persona/systemMessage/acknowledgeReplaceRisks';
    else if (/Duplicate agent name/i.test(part)) path = '/agents';
    else if (/defaultAgent/i.test(part)) path = '/defaultAgent';
    issues.push({ path, message: part, section: sectionForPath(path) });
  }
  const seen = new Set<string>();
  return issues.filter((i) => { const k = `${i.path}|${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export const issueAt = (issues: Issue[], dotted: string): string | undefined => {
  const p = '/' + dotted.split('.').join('/');
  return issues.find((i) => i.path === p)?.message ?? issues.find((i) => i.path.startsWith(p + '/'))?.message;
};

export type PermissionPreset = 'readonly' | 'ask' | 'autonomous' | 'custom';
export const PRESET_LABELS: Record<Exclude<PermissionPreset, 'custom'>, { title: string; desc: string }> = {
  ask: { title: 'Ask before changing things', desc: 'Reads freely; asks you to approve shell commands and file edits (chat) and denies them in headless runs.' },
  readonly: { title: 'Read-only', desc: 'Can look around and answer questions, but every write or command is denied.' },
  autonomous: { title: 'Autonomous', desc: 'Everything is allowed without asking. Best for trusted, unattended runs.' },
};

export function presetValue(p: Exclude<PermissionPreset, 'custom'>): Def {
  if (p === 'autonomous') return { all: true, default: 'allow' };
  if (p === 'readonly') return { all: true, default: 'deny', perTool: { ...READ_PRESET } };
  return { all: true, default: 'ask', perTool: { ...READ_PRESET, ...MUTATING_PRESET } };
}

export function detectPreset(builtins: Def | undefined): PermissionPreset {
  const b = builtins ?? {};
  const per = (b.perTool ?? {}) as Record<string, string>;
  const same = (a: Record<string, string>, c: Record<string, string>) => Object.keys(a).length === Object.keys(c).length && Object.keys(a).every((k) => a[k] === c[k]);
  if (b.all === false) return 'custom';
  const def = b.default ?? 'allow';
  if (def === 'allow' && Object.keys(per).length === 0) return 'autonomous';
  if (def === 'deny' && same(per, READ_PRESET)) return 'readonly';
  if (def === 'ask' && same(per, { ...READ_PRESET, ...MUTATING_PRESET })) return 'ask';
  return 'custom';
}

export interface McpUse { name: string; allow?: string[]; deny?: string[]; disabled?: boolean }
export const normalizeMcpUse = (use: unknown): McpUse[] =>
  (Array.isArray(use) ? use : []).map((u) => (typeof u === 'string' ? { name: u } : (u as McpUse))).filter((u) => u && u.name);
export const serializeMcpUse = (use: McpUse[]): unknown[] =>
  use.map((u) => (u.allow?.length || u.deny?.length || u.disabled ? { ...u } : u.name));

export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
export const splitList = (s: string): string[] => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function bumpVersion(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4]}` : `${v || '1.0.0'}-copy`;
}

export const PROVIDER_PRESETS: { id: string; label: string; type: 'openai' | 'anthropic' | 'azure'; baseUrl: string; model: string; env: string }[] = [
  { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', env: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', env: 'ANTHROPIC_API_KEY' },
  { id: 'azure', label: 'Azure OpenAI', type: 'azure', baseUrl: 'https://<resource>.openai.azure.com/openai/v1', model: '', env: 'AZURE_OPENAI_API_KEY' },
  { id: 'ollama', label: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', env: 'LLM_API_KEY' },
];

export const TEMPLATES: { id: string; name: string; title: string; description: string; persona: string; tools: Exclude<PermissionPreset, 'custom'> }[] = [
  { id: 'assistant', name: 'my-assistant', title: 'General assistant', description: 'A friendly all-round coding assistant that works in your project.', persona: 'You are a helpful, precise engineering assistant. Understand the request, inspect the project before changing it, make small focused changes, and explain what you did and why.', tools: 'ask' },
  { id: 'reviewer', name: 'code-reviewer', title: 'Code reviewer', description: 'Read-only reviewer that finds bugs, risks and missing tests.', persona: 'You are a meticulous code reviewer. Read the code, identify correctness bugs, security risks, edge cases and missing tests. Cite file paths and line numbers, rank findings by severity, and never modify files.', tools: 'readonly' },
  { id: 'builder', name: 'full-stack-builder', title: 'Full-stack builder', description: 'Autonomous builder that scaffolds, implements and tests features.', persona: 'You are a senior full-stack engineer. Plan briefly, then implement end to end: data model, API, UI and tests. Run the build and tests, fix failures, and finish with a short summary of changes.', tools: 'autonomous' },
  { id: 'researcher', name: 'researcher', title: 'Researcher', description: 'Explores a codebase and answers questions with evidence.', persona: 'You are a research assistant for codebases. Explore with search tools, quote the relevant code with file paths, and answer with clear, verifiable explanations. Do not change anything.', tools: 'readonly' },
];

/** Effective decision for a built-in tool given `tools.builtins` form state. */
export function toolDecision(builtins: Def | undefined, name: string): Decision {
  const b = builtins ?? { all: true };
  const per = (b.perTool ?? {}) as Record<string, Decision>;
  if (per[name]) return per[name];
  return b.all === false ? 'deny' : ((b.default as Decision) ?? 'allow');
}

export function setToolDecision(builtins: Def | undefined, name: string, d: Decision): Def {
  const b: Def = { all: true, ...(builtins ?? {}) };
  const per: Record<string, Decision> = { ...(b.perTool ?? {}) };
  // with all=true an entry equal to the default is redundant
  if (b.all !== false && d === ((b.default as Decision) ?? 'allow')) delete per[name];
  else per[name] = d;
  b.perTool = per;
  return b;
}

export const SECTION_ACTIONS = ['inherit', 'replace', 'append', 'prepend', 'remove', 'preserve'] as const;
