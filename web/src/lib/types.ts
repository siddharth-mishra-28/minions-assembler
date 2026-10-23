export type ApprovalMode = 'interactive' | 'autopilot' | 'strict';

export interface AppSettings {
  retention: { days: number; scope: 'everything' | 'chats'; keepPinned: boolean };
  approvals: { chatMode: ApprovalMode; timeoutSec: number };
  defaults: { providerId: string | null; model: string | null; systemPrompt: string };
  audit: { level: 'minimal' | 'standard' | 'full' };
  onboarding: { completed: boolean };
}

export interface Bootstrap {
  version: string;
  onboardingCompleted: boolean;
  providerCount: number;
  defaultProvider: { id: string; name: string; defaultModel: string | null; hasKey: boolean } | null;
  projectCount: number;
  settings: AppSettings;
  tokenRequired: boolean;
}

export interface Provider {
  id: string; name: string; type: string; baseUrl: string; defaultModel: string | null;
  credentialName: string | null; wireApi: string | null; azureApiVersion: string | null;
  isDefault: boolean; hasKey: boolean; createdAt: string; updatedAt: string;
}

export interface Project { id: string; name: string; path: string; createdAt: string; lastOpenedAt: string; settings: Record<string, unknown> }

export interface ChatAgent { id: string; name: string; kind: 'default' | 'custom' | 'project'; description?: string; model?: string }

export interface Thread {
  id: string; title: string; agent_id: string | null; session_id: string | null; project_id: string | null;
  model_override: string | null; approval_mode: string | null; pinned: number; archived: number;
  created_at: string; updated_at: string; busy?: boolean;
}

export interface ToolCall { callId: string; name: string; args?: unknown; result?: string; success?: boolean; done?: boolean }

export interface MessageMeta {
  model?: string; reasoning?: string; tools?: ToolCall[]; usage?: { tokensIn?: number; tokensOut?: number };
  status?: 'done' | 'error' | 'cancelled'; kind?: string; agentId?: string; error?: string;
}

export interface ChatMessage {
  id: number; thread_id: string; role: 'user' | 'assistant' | 'system'; author: string | null; content: string;
  created_at: string; meta: MessageMeta | null; run_id?: string | null;
}

export interface Approval {
  id: string; threadId: string | null; runId: string | null; tool: string; args: unknown;
  status: 'pending' | 'approved' | 'denied' | 'expired'; scope: string | null; decidedBy: string | null;
  reason: string | null; requestedAt: string; decidedAt: string | null;
}

export type ChatEvent =
  | { type: 'turn-start'; runId: string; messageId?: number; agentId: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-start'; callId: string; name: string; args?: unknown }
  | { type: 'tool-complete'; callId: string; name: string; result?: string; success?: boolean }
  | { type: 'approval-request'; approvalId: string; tool: string; args: unknown; source: string; timeoutSec: number }
  | { type: 'approval-resolved'; approvalId: string; status: 'approved' | 'denied' | 'expired'; scope?: string }
  | { type: 'usage'; tokensIn?: number; tokensOut?: number }
  | { type: 'done'; runId: string; messageId: number; text: string }
  | { type: 'error'; runId?: string; message: string }
  | { type: 'cancelled'; runId?: string };
