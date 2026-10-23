import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentDefinition } from '../core/types.js';
import type { PlatformStore, ProviderRow, ProjectRow } from '../store/platform.js';
import { parseAgentMarkdown } from './md-profile.js';
import { sealProviderApiKey } from './provider-keys.js';

export const DEFAULT_AGENT_ID = 'copilot-default@builtin';
export const PROJECT_AGENT_PREFIX = 'project:';

const READ_ONLY_TOOLS = ['view', 'read', 'grep', 'glob', 'ls', 'list', 'report_intent', 'tool_search_tool', 'skill', 'task_complete'];
const MUTATING_TOOLS = ['bash', 'write', 'create', 'edit', 'mkdir'];

/**
 * Resolve `provider.providerRef` (a Settings provider) into concrete connection details.
 * Returns a copy; the stored definition is never mutated and never contains the plaintext key.
 */
export function resolveProviderRef(def: AgentDefinition, platform: PlatformStore, modelOverride?: string | null): AgentDefinition {
  const copy = JSON.parse(JSON.stringify(def)) as AgentDefinition;
  const ref = copy.provider.providerRef;
  if (ref) {
    const p = platform.getProvider(ref);
    if (!p) throw new Error(`Provider "${ref}" referenced by this agent no longer exists. Pick another provider in Settings → Providers.`);
    const secret = platform.getProviderSecret(ref);
    if (!secret) throw new Error(`Provider "${p.name}" has no API key. Add one in Settings → Providers.`);
    copy.provider.type = p.type as AgentDefinition['provider']['type'];
    copy.provider.baseUrl = p.baseUrl;
    copy.provider.providerApiKey = sealProviderApiKey(secret);
    if (p.wireApi) copy.provider.wireApi = p.wireApi as 'completions' | 'responses';
    if (p.azureApiVersion) copy.provider.azureApiVersion = p.azureApiVersion;
    copy.provider.model ||= p.defaultModel ?? '';
  }
  if (modelOverride) copy.provider.model = modelOverride;
  if (!copy.provider.model) throw new Error('No model selected. Choose a model in the chat header or set a default in Settings → Providers.');
  return copy;
}

/** Built-in "GitHub Copilot"-style agent: default prompt, project workspace, asks before mutating anything. */
export function buildDefaultAgent(provider: Pick<ProviderRow, 'id' | 'type' | 'baseUrl' | 'defaultModel'>, opts: { projectPath?: string; model?: string | null; systemPrompt?: string }): AgentDefinition {
  const perTool: Record<string, 'allow' | 'ask'> = {};
  for (const t of READ_ONLY_TOOLS) perTool[t] = 'allow';
  for (const t of MUTATING_TOOLS) perTool[t] = 'ask';
  return {
    schemaVersion: '1.0',
    metadata: { name: 'copilot-default', version: 'builtin', description: 'Default Copilot agent — works in your project folder and asks before changing anything.', tags: ['builtin'] },
    persona: {
      useCopilotDefaultPrompt: true,
      ...(opts.systemPrompt?.trim() ? { systemMessage: { mode: 'append' as const, content: opts.systemPrompt.trim() } } : {}),
    },
    knowledge: { ...(opts.projectPath ? { workingDirectory: opts.projectPath } : {}), sessionStore: false },
    task: { prompt: '' },
    tools: { permissionPolicy: 'pattern-list', harness: true, builtins: { all: true, default: 'ask', perTool } },
    provider: {
      providerRef: provider.id,
      type: provider.type as AgentDefinition['provider']['type'],
      baseUrl: provider.baseUrl,
      model: opts.model || provider.defaultModel || '',
      providerApiKey: 'provider-ref',
    },
  };
}

export interface ProjectAgentInfo { id: string; name: string; description?: string; file: string; model?: string }

/** `.github/agents/*.agent.md` profiles inside a project become selectable chat agents (read-only discovery). */
export function discoverProjectAgents(project: ProjectRow): ProjectAgentInfo[] {
  const dir = join(project.path, '.github', 'agents');
  const out: ProjectAgentInfo[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const abs = join(dir, f);
      if (!statSync(abs).isFile()) continue;
      const profile = parseAgentMarkdown(readFileSync(abs, 'utf8'), basename(f).replace(/\.(agent\.)?md$/i, ''));
      out.push({ id: `${PROJECT_AGENT_PREFIX}${project.id}:${f}`, name: profile.name, description: profile.description, file: abs, model: profile.model });
    } catch { /* unparsable profile — skip */ }
  }
  return out;
}

export function buildProjectAgent(project: ProjectRow, file: string, provider: Pick<ProviderRow, 'id' | 'type' | 'baseUrl' | 'defaultModel'>, modelOverride?: string | null): AgentDefinition {
  // Only files directly inside .github/agents are accepted — never an arbitrary path from the client.
  if (file !== basename(file) || !/\.md$/i.test(file)) throw new Error('Invalid project agent file');
  const profile = parseAgentMarkdown(readFileSync(join(project.path, '.github', 'agents', file), 'utf8'), file.replace(/\.(agent\.)?md$/i, ''));
  const perTool: Record<string, 'allow' | 'ask'> = {};
  for (const t of READ_ONLY_TOOLS) perTool[t] = 'allow';
  for (const t of MUTATING_TOOLS) perTool[t] = 'ask';
  for (const t of profile.tools ?? []) perTool[t] = 'allow';
  return {
    schemaVersion: '1.0',
    metadata: { name: profile.name, version: profile.version, description: profile.description ?? `Project agent (${file})`, tags: ['project'] },
    persona: { useCopilotDefaultPrompt: true, systemMessage: { mode: 'append', content: profile.prompt } },
    knowledge: { workingDirectory: project.path, sessionStore: false },
    task: { prompt: '' },
    tools: { permissionPolicy: 'pattern-list', harness: true, builtins: { all: true, default: 'ask', perTool } },
    provider: {
      providerRef: provider.id,
      type: provider.type as AgentDefinition['provider']['type'],
      baseUrl: provider.baseUrl,
      model: modelOverride || profile.model || provider.defaultModel || '',
      providerApiKey: 'provider-ref',
    },
  };
}
