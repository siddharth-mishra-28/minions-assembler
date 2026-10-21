export type ToolDecision = 'allow' | 'ask' | 'deny';

export interface ToolBuiltinsPolicy {
  /** Default posture for any tool without an explicit perTool decision (covers built-in, MCP and custom tools). */
  default?: ToolDecision;
  /** Convenience toggle for "all built-in CLI tools available" (select-all checkbox). Default true. */
  all?: boolean;
  /** Per-tool override, matched on bare name or source-qualified (builtin:x, mcp:x, custom:x). 'ask' resolves as deny in headless runs (audited). */
  perTool?: Record<string, ToolDecision>;
}

export interface AgentDefinition {
  schemaVersion: '1.0';
  metadata: { name: string; version: string; description?: string; tags?: string[]; color?: string };
  persona?: {
    systemMessage?: {
      mode?: 'append' | 'replace' | 'customize';
      content?: string;
      acknowledgeReplaceRisks?: boolean;
      sections?: Record<string, { action: 'replace' | 'remove' | 'append' | 'prepend' | 'preserve'; content?: string }>;
    };
    /**
     * UI affordance + explicit intent marker: whether the agent keeps the
     * SDK-managed default Copilot CLI system prompt (preamble, identity, tone,
     * tool_instructions, safety, …). Default true (append/customize keep it;
     * replace drops it). The wizard checkbox writes this field and derives the
     * systemMessage mode accordingly.
     */
    useCopilotDefaultPrompt?: boolean;
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
    /**
     * Built-in tool availability + per-tool decisions (wizard checkbox grid).
     * Complements available/excluded: availability shapes the session tool
     * list; perTool decisions shape the permission hooks.
     */
    builtins?: ToolBuiltinsPolicy;
    /**
     * Allow destructive operations (rm -rf, deletes, forced pushes, drops…, process kills).
     * Default false: the pre-tool hook denies wrecking commands and update/
     * delete-flagged MCP calls with an audited reason.
     */
    allowDestructive?: boolean;
    /**
     * Inject the built-in coding-harness tools (`bash`, `mkdir`, `write`) and
     * auto-create parent directories for `create`/`write`/`edit`. Default true.
     * Set false for a locked-down read-only agent.
     */
    harness?: boolean;
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
    /**
     * Fixed attribute name for the provider credential. Value is one of:
     * - `enc:v1:…` token (AES-256-GCM, produced on save — never a plaintext key at rest)
     * - `${ENV_VAR}` reference, expanded at load time
     * - a literal API key (accepted in hand-written files; encrypted on store)
     */
    providerApiKey: string;
    /** @deprecated Legacy env-var name. Use providerApiKey with `${ENV_VAR}` instead. */
    credentialEnv?: string;
    azureApiVersion?: string;
  };
  runtime?: {
    streaming?: boolean; sessionId?: string; resume?: boolean; idleTimeoutSecs?: number;
    /** Render override for the tool-search tool: hide it (enabled false) or defer discovery below a threshold. */
    toolSearch?: { enabled?: boolean; deferThreshold?: number };
    /** Built-in runtime agents (specialists) to hide from discovery. */
    excludedBuiltinAgents?: string[];
    /** Runtime-bundled skills to include (none are bundled in a bare session unless named). */
    includedBuiltinSkills?: string[];
    /**
     * Budget for one agent turn (`sendAndWait`), in milliseconds.
     * Multi-file coding builds routinely need far more than a few minutes.
     * Resolution order: API body override > this field > RUN_TURN_TIMEOUT_MS env > default 45 min.
     */
    turnTimeoutMs?: number;
    maxAiCredits?: number; logLevel?: 'error' | 'warning' | 'info' | 'debug';
    autopilot?: boolean;
    clientInfo?: { applicationName?: string; applicationVersion?: string; integrationName?: string; integrationVersion?: string };
  };
  fleet?: {
    enabled?: boolean;
    prompt?: string;
    maxConcurrentWorkers?: number;
  };
}

export interface LoadResult {
  definition: AgentDefinition;
  warnings: string[];
  definitionHash: string;
}

export type RunStatus = 'queued' | 'running' | 'idle' | 'aborted' | 'failed' | 'done';
