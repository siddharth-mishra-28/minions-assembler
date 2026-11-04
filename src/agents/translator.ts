import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { AgentDefinition } from '../core/types.js';
import { toSdkMcpConfig, type McpServerConfig } from '../mcp/mcp.js';
import { resolveProviderApiKeyValue } from '../core/crypto.js';
import { withHarnessToolsAvailable, withHarnessToolsForAgent, harnessEnabled } from './harness-tools.js';
import { mergeSystemMessageWithMemory } from '../memory/context.js';
import { resolveBuiltinTools } from './tools-policy.js';

export interface PersonaResolution {
  /** The value to hand to createSession (undefined = pure SDK default prompt). */
  systemMessage: Record<string, unknown> | undefined;
  /** Whether the default Copilot CLI system prompt remains active. */
  defaultPromptIncluded: boolean;
  /** Human-readable summary for the audit trail. */
  summary: string;
}

/**
 * Resolve the persona block into the session `systemMessage` option.
 *
 * - persona/systemMessage omitted → undefined: the runtime applies its full
 *   SDK-managed default Copilot CLI prompt (preamble, identity, tone,
 *   tool_instructions, safety, …). This is the "default prompt only" agent.
 * - mode append (default) / customize → default prompt stays + custom content
 *   appended / section tweaks.
 * - mode replace → default prompt fully replaced (loader requires
 *   acknowledgeReplaceRisks; the wizard's unchecked default-prompt checkbox
 *   writes this shape).
 */
export function resolvePersona(def: AgentDefinition, memoryContext?: string): PersonaResolution {
  const useDefault = def.persona?.useCopilotDefaultPrompt !== false;
  const memoryChars = (memoryContext ?? '').trim().length;
  const memoryNote = memoryChars ? ` + memory ${memoryChars} chars` : '';
  const sm = def.persona?.systemMessage;
  if (!sm) {
    const merged = mergeSystemMessageWithMemory(undefined, memoryContext);
    if (!merged) {
      let summary = 'systemMessage omitted — default Copilot CLI system prompt only';
      if (!useDefault) summary += ' (warning: useCopilotDefaultPrompt=false but no custom systemMessage provided)';
      return { systemMessage: undefined, defaultPromptIncluded: useDefault, summary };
    }
    return {
      systemMessage: merged,
      defaultPromptIncluded: useDefault,
      summary: `systemMessage memory-only (append)${memoryNote} — default prompt ${useDefault ? 'included' : 'REPLACED per definition'}`,
    };
  }
  const mode = sm.mode ?? 'append';
  // replace drops the default prompt (and its guardrails) — acknowledge or not active.
  const defaultPromptIncluded = mode !== 'replace';
  const merged = mergeSystemMessageWithMemory(sm as unknown as Record<string, unknown>, memoryContext);
  return {
    systemMessage: merged,
    defaultPromptIncluded,
    summary: `systemMessage mode=${mode} content=${(sm.content ?? '').length} chars${memoryNote} — default prompt ${defaultPromptIncluded ? 'included' : 'REPLACED'}`,
  };
}

/** Build Copilot SDK createSession options from a validated definition. Pure function — easy to unit test. */
export function toSessionOptions(
  def: AgentDefinition,
  apiKey: string,
  extra?: { tools?: unknown[]; memoryContext?: string },
): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    type: def.provider.type,
    baseUrl: def.provider.baseUrl,
    apiKey,
    wireApi: def.provider.wireApi ?? 'completions',
  };
  if (def.provider.type === 'azure' && def.provider.azureApiVersion) {
    provider.azure = { apiVersion: def.provider.azureApiVersion };
  }

  // Harness tools (bash/mkdir/write/create) + definition-declared custom tools.
  // Custom tools are declaration-only (no handler) unless the caller supplies one
  // through `extra.tools`; the harness ones always carry real handlers.
  const sessionTools: unknown[] = [...(extra?.tools ?? [])];
  for (const t of def.tools?.custom ?? []) {
    if (sessionTools.some((s) => (s as { name?: string })?.name === t.name)) continue;
    sessionTools.push({
      name: t.name,
      description: t.description,
      parameters: t.parametersSchema,
      skipPermission: t.skipPermission,
      defer: t.defer ?? 'never',
      ...(t.overridesBuiltInTool != null ? { overridesBuiltInTool: t.overridesBuiltInTool } : {}),
      ...(t.isTerminal != null ? { isTerminal: t.isTerminal } : {}),
      ...(t.namespace != null ? { namespace: t.namespace } : {}),
      ...(t.metadata != null ? { metadata: t.metadata } : {}),
    });
  }

  // Built-in tool availability + per-tool decisions (tools.builtins grid).
  const builtins = resolveBuiltinTools(def);

  const opts: Record<string, unknown> = {
    model: def.provider.model,
    provider,
    streaming: def.runtime?.streaming ?? true,
    systemMessage: resolvePersona(def, extra?.memoryContext).systemMessage,
    customAgents: (def.agents ?? []).map((a) => ({
      name: a.name,
      prompt: a.prompt,
      displayName: a.displayName,
      description: a.description,
      // A per-agent tools allowlist would otherwise hide bash/mkdir/write/create
      // from the model even when the session has them registered.
      tools: withHarnessToolsForAgent(a.tools, def) ?? null,
      mcpServers: a.mcpServers,
      infer: a.infer ?? true,
      skills: a.skills,
      model: a.model,
      reasoningEffort: a.reasoningEffort,
    })),
    skillDirectories: def.skills?.directories ?? [],
    disabledSkills: def.skills?.disabled ?? [],
    includedBuiltinSkills: def.runtime?.includedBuiltinSkills,
    excludedBuiltinAgents: def.runtime?.excludedBuiltinAgents,
    mcpServers: Object.fromEntries(Object.entries(def.mcp?.servers ?? {}).map(([k, v]) => [k, toSdkMcpConfig(v as McpServerConfig)])),
    disabledMcpServers: def.mcp?.disabled ?? [],
    workingDirectory: def.knowledge?.workingDirectory,
    additionalDirectories: def.knowledge?.additionalDirectories ?? [],
    // Harness tools are custom:*-source tools, so `custom:*` availability
    // covers them even under a restricted built-in grid.
    availableTools: withHarnessToolsAvailable(builtins.availableTools, builtins.excludedTools, def),
    excludedTools: builtins.excludedTools,
    // Keep the coding tools in front of the model. Tool-search deferral hides
    // bash/mkdir behind a discovery tool the agent never calls mid-build.
    // Overridable via runtime.toolSearch ({ enabled, deferThreshold }).
    toolSearch: def.runtime?.toolSearch
      ? {
          enabled: def.runtime.toolSearch.enabled ?? false,
          ...(def.runtime.toolSearch.deferThreshold != null ? { deferThreshold: def.runtime.toolSearch.deferThreshold } : {}),
        }
      : { enabled: false },
    refreshCustomInstructions: def.instructions?.refreshDiscoveryCache ?? false,
  };
  // AGENTS.md-style repo instruction files at explicit paths (instructions.agentsMdPaths).
  // The Copilot CLI natively discovers AGENTS.md / CLAUDE.md / .github/copilot-instructions.md
  // inside the working directory; this covers files OUTSIDE that discovery. Their content
  // is injected into the system prompt through the same channel the CLI uses for
  // discovered custom instructions.
  const agentsMd = readAgentsMdFiles(def.instructions?.agentsMdPaths, def.knowledge?.workingDirectory);
  if (agentsMd) opts.organizationCustomInstructions = agentsMd;
  if (sessionTools.length) opts.tools = sessionTools;
  if (def.defaultAgent) opts.agent = def.defaultAgent;
  if (def.runtime?.sessionId) opts.sessionId = def.runtime.sessionId;
  if (def.runtime?.idleTimeoutSecs) opts.sessionIdleTimeoutSeconds = def.runtime.idleTimeoutSecs;
  // Coding builds need a long-lived session: default the SDK idle timeout to 30 min
  // so a slow tool chain does not idle-out mid-scaffold.
  else opts.sessionIdleTimeoutSeconds = 30 * 60;    if (def.runtime?.maxAiCredits != null) opts.sessionLimits = { maxAiCredits: def.runtime.maxAiCredits };
    if (def.runtime?.autopilot != null) opts.autopilot = def.runtime.autopilot;
    if (def.runtime?.reasoningEffort) opts.reasoningEffort = def.runtime.reasoningEffort;
    if (def.runtime?.capi) opts.capi = def.runtime.capi;
    if (def.runtime?.trustWorkingDirectory) opts.trustWorkingDirectory = def.runtime.trustWorkingDirectory;
    if (def.instructions?.directories?.length) opts.instructionDirectories = def.instructions.directories;
    // SDK `defaultAgent.excludedTools`: hide tools from the default/main agent only.
    if (def.tools?.defaultAgentExcluded?.length) opts.defaultAgent = { excludedTools: def.tools.defaultAgentExcluded };
  if (def.knowledge?.sessionStore != null) opts.enableSessionStore = def.knowledge.sessionStore;
  if (def.runtime?.clientInfo) opts.clientInfo = def.runtime.clientInfo;
  if (def.runtime?.logLevel) opts.logLevel = def.runtime.logLevel;
  if (def.runtime?.turnTimeoutMs != null) opts.turnTimeoutMs = def.runtime.turnTimeoutMs;
  // Remove undefined keys
  return Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
}

export { harnessEnabled };

/**
 * Model listing the host serves to the SDK (`onListModels`): the model in the
 * definition plus its advertised capabilities. Driven by `runtime.modelCapabilities`
 * so definitions control what the runtime believes the model supports.
 */
export function modelListing(def: AgentDefinition): Record<string, unknown> {
  const caps = def.runtime?.modelCapabilities ?? {};
  return {
    id: def.provider.model,
    name: def.provider.model,
    capabilities: { supports: { vision: caps.vision ?? false, reasoningEffort: caps.reasoningEffort ?? false } },
    limits: { max_context_window_tokens: caps.maxContextWindowTokens ?? 128000 },
  };
}

export function toSendArgs(def: AgentDefinition, taskOverride?: string): { prompt: string; mode: string; attachments?: unknown[] } {
  const instructionContext = [
    ...(def.instructions?.global ?? []),
    ...(def.instructions?.scoped ?? []).map((s) => `[${s.applyTo}]\n${s.body}`),
  ].join('\n\n');
  const base = taskOverride?.trim() || def.task.prompt;
  const prompt = instructionContext ? `${base}\n\n---\nProject instructions:\n${instructionContext}` : base;
  return {
    prompt,
    mode: def.task.deliveryMode ?? 'enqueue',
    attachments: [...(def.knowledge?.attachments ?? []), ...((def.task.attachments as unknown[]) ?? [])],
  };
}

/**
 * Read explicit AGENTS.md-style instruction files (absolute, or relative to the
 * working directory). Missing files are skipped silently — the loader warns at
 * registration time. Returns joined content or undefined when nothing readable.
 */
export function readAgentsMdFiles(paths?: string[], workingDirectory?: string): string | undefined {
  if (!paths?.length) return undefined;
  const base = resolvePath(workingDirectory?.trim() || process.cwd());
  const parts: string[] = [];
  for (const p of paths) {
    try {
      const abs = resolvePath(base, p);
      const text = readFileSync(abs, 'utf8').trim();
      if (text) parts.push(text);
    } catch { /* skip unreadable entries */ }
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Resolve the provider API key at run time.
 *
 * `provider.providerApiKey` is the fixed attribute. Accepts `enc:v1:` tokens
 * (decrypted with the local master key), `${ENV_VAR}` references, and literal
 * keys. Legacy `credentialEnv` is used only when providerApiKey is absent.
 */
export function resolveApiKey(def: AgentDefinition): string {
  const raw = def.provider.providerApiKey;
  if (raw) return resolveProviderApiKeyValue(raw);
  const envName = def.provider.credentialEnv;
  if (envName) {
    const key = process.env[envName];
    if (key) return key;
    throw new Error(`Missing credential: env ${envName} is not set (legacy fallback — set provider.providerApiKey instead)`);
  }
  throw new Error('Missing credential: provider.providerApiKey is required');
}
