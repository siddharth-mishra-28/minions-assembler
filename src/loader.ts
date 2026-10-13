import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as AjvModule from 'ajv/dist/2020.js';
const Ajv = (AjvModule as unknown as { default: new (opts?: Record<string, unknown>) => { compile: (s: unknown) => ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] } } }).default ?? (AjvModule as unknown as new (opts?: Record<string, unknown>) => { compile: (s: unknown) => ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] } });
import schema from './schema/agent-definition.schema.json' with { type: 'json' };
import type { AgentDefinition, LoadResult } from './types.js';

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

function resolveEnvRefs(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, resolveEnvRefs(v)]));
  }
  return obj;
}

/** Core validation shared by file loading and inline (UI/API) validation. Throws Error on failure. */
export function validateDefinitionObject(json: unknown): LoadResult {
  if (!validate(json)) {
    const details = (validate.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`Schema validation failed: ${details}`);
  }
  const def = resolveEnvRefs(json) as AgentDefinition;
  const warnings: string[] = [];

  if (def.persona.systemMessage.mode === 'replace' && !def.persona.systemMessage.acknowledgeReplaceRisks) {
    throw new Error('persona.systemMessage.mode=replace requires acknowledgeReplaceRisks:true (it drops SDK guardrails)');
  }
  const names = new Set<string>();
  for (const a of def.agents ?? []) {
    if (names.has(a.name)) throw new Error(`Duplicate agent name: ${a.name}`);
    names.add(a.name);
  }
  if (def.defaultAgent && !names.has(def.defaultAgent)) {
    throw new Error(`defaultAgent '${def.defaultAgent}' not found in agents[]`);
  }
  for (const s of def.agents ?? []) {
    for (const sk of s.skills ?? []) {
      if (!def.skills?.directories?.length) warnings.push(`Agent '${s.name}' lists skill '${sk}' but skills.directories is empty`);
    }
  }
  if (def.knowledge?.workingDirectory && !existsSync(def.knowledge.workingDirectory)) {
    warnings.push(`workingDirectory does not exist: ${def.knowledge.workingDirectory}`);
  }
  for (const p of def.knowledge?.attachments ?? []) {
    if ((p.type === 'file' || p.type === 'directory') && p.path && !existsSync(p.path)) {
      warnings.push(`attachment path does not exist: ${p.path}`);
    }
  }
  if (def.provider.credentialEnv && !process.env[def.provider.credentialEnv]) {
    warnings.push(`Credential env ${def.provider.credentialEnv} is not set (required at run time, never stored)`);
  }
  for (const [srv, cfg] of Object.entries(def.mcp?.servers ?? {})) {
    for (const [k, v] of Object.entries({ ...(cfg.env ?? {}), ...(cfg.headers ?? {}) })) {
      if (SECRET_RE.test(k) && v && !v.startsWith('${') && v !== '***' && v.length > 0 && !process.env[v]) {
        warnings.push(`MCP server '${srv}' key '${k}' looks like a literal secret — use \${ENV_VAR} instead`);
      }
    }
  }
  const definitionHash = createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
  return { definition: def, warnings, definitionHash };
}

export function loadAgentDefinition(path: string): LoadResult {
  const raw = readFileSync(path, 'utf8');
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
