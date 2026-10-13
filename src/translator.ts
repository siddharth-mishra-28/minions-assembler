import type { AgentDefinition } from './types.js';
import { toSdkMcpConfig, type McpServerConfig } from './mcp.js';

/** Build Copilot SDK createSession options from a validated definition. Pure function — easy to unit test. */
export function toSessionOptions(def: AgentDefinition, apiKey: string): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    type: def.provider.type,
    baseUrl: def.provider.baseUrl,
    apiKey,
    wireApi: def.provider.wireApi ?? 'completions',
  };
  if (def.provider.type === 'azure' && def.provider.azureApiVersion) {
    provider.azure = { apiVersion: def.provider.azureApiVersion };
  }

  const opts: Record<string, unknown> = {
    model: def.provider.model,
    provider,
    streaming: def.runtime?.streaming ?? true,
    systemMessage: def.persona.systemMessage,
    customAgents: (def.agents ?? []).map((a) => ({
      name: a.name,
      prompt: a.prompt,
      displayName: a.displayName,
      description: a.description,
      tools: a.tools ?? null,
      mcpServers: a.mcpServers,
      infer: a.infer ?? true,
      skills: a.skills,
      model: a.model,
      reasoningEffort: a.reasoningEffort,
    })),
    skillDirectories: def.skills?.directories ?? [],
    disabledSkills: def.skills?.disabled ?? [],
    mcpServers: Object.fromEntries(Object.entries(def.mcp?.servers ?? {}).map(([k, v]) => [k, toSdkMcpConfig(v as McpServerConfig)])),
    disabledMcpServers: def.mcp?.disabled ?? [],
    workingDirectory: def.knowledge?.workingDirectory,
    additionalDirectories: def.knowledge?.additionalDirectories ?? [],
    availableTools: def.tools?.available,
    excludedTools: def.tools?.excluded,
    refreshCustomInstructions: def.instructions?.refreshDiscoveryCache ?? false,
  };
  if (def.defaultAgent) opts.agent = def.defaultAgent;
  if (def.runtime?.sessionId) opts.sessionId = def.runtime.sessionId;
  if (def.runtime?.idleTimeoutSecs) opts.sessionIdleTimeoutSeconds = def.runtime.idleTimeoutSecs;
  if (def.runtime?.maxAiCredits != null) opts.sessionLimits = { maxAiCredits: def.runtime.maxAiCredits };
  if (def.knowledge?.sessionStore != null) opts.enableSessionStore = def.knowledge.sessionStore;
  if (def.runtime?.clientInfo) opts.clientInfo = def.runtime.clientInfo;
  if (def.runtime?.logLevel) opts.logLevel = def.runtime.logLevel;
  // Remove undefined keys
  return Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
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

export function resolveApiKey(def: AgentDefinition): string {
  const key = process.env[def.provider.credentialEnv];
  if (!key) throw new Error(`Missing credential: env ${def.provider.credentialEnv} is not set (BYOK keys are never stored in JSON or DB)`);
  return key;
}
