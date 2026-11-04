import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as AjvModule from 'ajv/dist/2020.js';
const Ajv = (AjvModule as unknown as { default: new (opts?: Record<string, unknown>) => { compile: (s: unknown) => ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] } } }).default ?? (AjvModule as unknown as new (opts?: Record<string, unknown>) => { compile: (s: unknown) => ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] } });
import schema from '../schema/agent-definition.schema.json' with { type: 'json' };
import type { AgentDefinition, LoadResult } from '../core/types.js';

const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

const SECRET_RE = /(api[_-]?key|token|secret|password)/i;

export function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') return SECRET_RE.test(value) ? '***' : value;
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_RE.test(k) ? '***' : scrubSecrets(v)]));
  }
  return value;
}

/**
 * Expand `${ENV_VAR}` references for execution. `providerApiKey` is deliberately
 * left as its literal token: definitions stay portable in storage and
 * resolveProviderApiKeyValue expands the key at run time (enc:v1: / ${ENV} / literal).
 */
function resolveEnvRefs(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) =>
      // Keep providerApiKey as a literal `${ENV}` token so definitions stay portable;
      // resolveProviderApiKeyValue expands it at run time.
      [k, k === 'providerApiKey' ? v : resolveEnvRefs(v)]
    ));
  }
  return obj;
}

/**
 * Core validation shared by file loading, inline (UI/API) validation, and DB hydration.
 * Throws Error on failure.
 *
 * Storage semantics: `definition` is the PORTABLE form — `${ENV_VAR}` refs are kept
 * literal (this is exactly what gets persisted; env values are never baked into the DB).
 * `resolved` is the env-expanded, run-ready view. `definitionHash` covers the portable
 * form so a stored definition and its run snapshot hash identically. Warnings are
 * computed against the resolved view so path/credential checks see real values.
 */
export function validateDefinitionObject(json: unknown): LoadResult {
  if (!validate(json)) {
    const details = (validate.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`Schema validation failed: ${details}`);
  }
  const def = json as AgentDefinition;
  const resolvedDef = resolveEnvRefs(json) as AgentDefinition;
  // Warnings inspect live values (paths, env presence) — use the resolved view.
  const d = resolvedDef;
  const warnings: string[] = [];
  // Chat-only agents omit 	ask; provider-ref agents omit inline connection details. Normalise so downstream code keeps its invariants.
  if (!def.task) def.task = { prompt: '' };
  if (def.provider.providerRef) {
    def.provider.type ??= 'openai';
    def.provider.baseUrl ??= 'provider-ref';
    def.provider.providerApiKey ??= 'provider-ref';
  }

  if (d.persona?.systemMessage?.mode === 'replace' && !d.persona.systemMessage.acknowledgeReplaceRisks) {
    throw new Error('persona.systemMessage.mode=replace requires acknowledgeReplaceRisks:true (it drops SDK guardrails)');
  }
  if (d.persona && d.persona.systemMessage === undefined && d.persona.useCopilotDefaultPrompt === false) {
    warnings.push('persona.useCopilotDefaultPrompt=false but no persona.systemMessage provided — the runtime default Copilot prompt still applies');
  }
  if (d.persona?.useCopilotDefaultPrompt === true && d.persona?.systemMessage?.mode === 'replace') {
    warnings.push("persona.useCopilotDefaultPrompt=true but systemMessage.mode='replace' — the default prompt will be REPLACED (replace wins)");
  }
  const builtins = d.tools?.builtins;
  if (builtins && builtins.all === false && builtins.default === 'allow' && !Object.keys(builtins.perTool ?? {}).length) {
    warnings.push('tools.builtins.all=false with no perTool allow entries — no built-in tools will be available (MCP/custom sources still are)');
  }
  if (builtins && builtins.all === true && builtins.perTool && Object.values(builtins.perTool).filter((d) => d === 'allow').length) {
    warnings.push('tools.builtins: perTool allow entries are redundant while all=true (they only matter when all=false or default≠allow)');
  }
  const names = new Set<string>();
  for (const a of d.agents ?? []) {
    if (names.has(a.name)) throw new Error(`Duplicate agent name: ${a.name}`);
    names.add(a.name);
  }
  if (d.defaultAgent && !names.has(d.defaultAgent)) {
    throw new Error(`defaultAgent '${d.defaultAgent}' not found in agents[]`);
  }
  for (const s of d.agents ?? []) {
    for (const sk of s.skills ?? []) {
      if (!d.skills?.directories?.length) warnings.push(`Agent '${s.name}' lists skill '${sk}' but skills.directories is empty`);
    }
  }
  if (d.knowledge?.workingDirectory && !existsSync(d.knowledge.workingDirectory)) {
    warnings.push(`workingDirectory does not exist: ${d.knowledge.workingDirectory}`);
  }
  for (const p of d.knowledge?.attachments ?? []) {
    if ((p.type === 'file' || p.type === 'directory') && p.path && !existsSync(p.path)) {
      warnings.push(`attachment path does not exist: ${p.path}`);
    }
  }
  if (def.provider.providerRef) {
    // resolved from Settings at run time
  } else if (def.provider.providerApiKey) {
    // enc:v1: tokens and ${ENV} refs are resolved at run time; literal keys are sealed on save.
  } else if (d.provider.credentialEnv) {
    if (!process.env[d.provider.credentialEnv]) {
      warnings.push(`Credential env ${d.provider.credentialEnv} is not set (legacy fallback — prefer provider.providerApiKey)`);
    }
  } else {
    warnings.push('provider.providerApiKey is missing — runs will fail to resolve an API key');
  }
  // Literal-secret scan runs on the PORTABLE form: `${ENV_VAR}` refs stay visible here.
  for (const [srv, cfg] of Object.entries(def.mcp?.servers ?? {})) {
    for (const [k, v] of Object.entries({ ...(cfg.env ?? {}), ...(cfg.headers ?? {}) })) {
      if (SECRET_RE.test(k) && v && !v.startsWith('${') && v !== '***' && v.length > 0 && !process.env[v]) {
        warnings.push(`MCP server '${srv}' key '${k}' looks like a literal secret — use \${ENV_VAR} instead`);
      }
    }
  }
  // Hash the PORTABLE form: a stored definition and its run snapshot hash identically.
  const definitionHash = createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
  return { definition: def, resolved: resolvedDef, warnings, definitionHash };
}

/**
 * Hydration entry point: the ONLY way a definition enters a run/chat turn.
 * Validates the portable form, then returns the env-resolved, run-ready definition
 * alongside it (the portable form is what gets snapshotted onto runs).
 */
export function hydrateDefinitionObject(json: unknown): LoadResult {
  return validateDefinitionObject(json);
}

/** Hydrate a stored definition JSON string (agents.definition_json, runs.definition_json). */
export function hydrateAgentDefinition(rawJson: string): LoadResult {
  let json: unknown;
  try {
    json = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`Invalid definition JSON in storage: ${(e as Error).message}`);
  }
  return hydrateDefinitionObject(json);
}

export function loadAgentDefinition(path: string): LoadResult {
  // Tolerate UTF-8 BOMs (Windows editors/PowerShell writes): JSON.parse rejects them.
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
  try {
    return validateDefinitionObject(json);
  } catch (e) {
    throw new Error(`${(e as Error).message} (in ${path})`);
  }
}

export function redactedForLog(def: AgentDefinition): Record<string, unknown> {
  return scrubSecrets(def) as Record<string, unknown>;
}
