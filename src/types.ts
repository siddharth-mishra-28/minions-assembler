export interface AgentDefinition {
  schemaVersion: '1.0';
  metadata: { name: string; version: string; description?: string; tags?: string[] };
  persona: {
    systemMessage: {
      mode?: 'append' | 'replace' | 'customize';
      content: string;
      acknowledgeReplaceRisks?: boolean;
      sections?: Record<string, { action: 'replace' | 'remove' | 'append' | 'prepend' | 'preserve'; content?: string }>;
    };
  };
  instructions?: { global?: string[]; scoped?: { applyTo: string; body: string }[]; agentsMdPaths?: string[]; refreshDiscoveryCache?: boolean };
  knowledge?: {
    workingDirectory?: string;
    additionalDirectories?: string[];
    attachments?: { type: 'file' | 'directory' | 'blob'; path?: string; data?: string; mimeType?: string; displayName?: string }[];
    sessionStore?: boolean;
    maxAttachmentBytes?: number;
  };
  agents?: {
    name: string; prompt: string; displayName?: string; description?: string;
    tools?: string[] | null; mcpServers?: Record<string, unknown>; infer?: boolean;
    skills?: string[]; model?: string; reasoningEffort?: string;
  }[];
  defaultAgent?: string;
  skills?: { directories?: string[]; disabled?: string[] };
  task: { prompt: string; deliveryMode?: 'enqueue' | 'immediate'; attachments?: unknown[] };
  tools?: {
    custom?: { name: string; description: string; parametersSchema: Record<string, unknown>; skipPermission?: boolean }[];
    available?: string[]; excluded?: string[];
    permissionPolicy?: 'deny-all' | 'approve-all-ci-only' | 'pattern-list';
    patterns?: { tool: string; decision: 'allow' | 'deny' | 'ask'; reason?: string }[];
  };
  mcp?: {
    servers?: Record<string, {
      type: 'local' | 'stdio' | 'http' | 'sse';
      command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
      url?: string; headers?: Record<string, string>; tools?: string[]; timeoutMs?: number;
    }>;
    disabled?: string[]; timeoutDefaultMs?: number;
    /** References to servers registered in the MCP registry (POST /api/mcp). */
    use?: (string | { name: string; allow?: string[]; deny?: string[]; disabled?: boolean })[];
  };
  provider: {
    type: 'openai' | 'azure' | 'anthropic';
    baseUrl: string; model: string; wireApi?: 'completions' | 'responses';
    credentialEnv: string; azureApiVersion?: string;
  };
  runtime?: {
    streaming?: boolean; sessionId?: string; resume?: boolean; idleTimeoutSecs?: number;
    maxAiCredits?: number; logLevel?: 'error' | 'warning' | 'info' | 'debug';
    autopilot?: boolean;
    clientInfo?: { applicationName?: string; applicationVersion?: string; integrationName?: string; integrationVersion?: string };
  };
}

export interface LoadResult {
  definition: AgentDefinition;
  warnings: string[];
  definitionHash: string;
}

export type RunStatus = 'queued' | 'running' | 'idle' | 'aborted' | 'failed' | 'done';
