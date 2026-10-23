/** Typed events pushed to the browser for one chat thread (SSE). */
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

export interface HubEnvelope { id: number; at: string; threadId: string; event: ChatEvent }
type Listener = (env: HubEnvelope) => void;

/** In-process fan-out with a small replay buffer so a reconnecting SSE client can catch up via Last-Event-ID. */
export class ChatHub {
  private listeners = new Map<string, Set<Listener>>();
  private buffers = new Map<string, HubEnvelope[]>();
  private seq = 0;
  constructor(private readonly bufferSize = 500) {}

  publish(threadId: string, event: ChatEvent): HubEnvelope {
    const env: HubEnvelope = { id: ++this.seq, at: new Date().toISOString(), threadId, event };
    const buf = this.buffers.get(threadId) ?? [];
    buf.push(env);
    if (buf.length > this.bufferSize) buf.splice(0, buf.length - this.bufferSize);
    this.buffers.set(threadId, buf);
    for (const l of this.listeners.get(threadId) ?? []) {
      try { l(env); } catch { /* a broken subscriber must not break the turn */ }
    }
    return env;
  }

  subscribe(threadId: string, listener: Listener, afterId = 0): () => void {
    for (const env of this.buffers.get(threadId) ?? []) if (env.id > afterId) listener(env);
    const set = this.listeners.get(threadId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(threadId, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(threadId); };
  }

  /** Drop replay history once a thread is idle (called at turn end after a grace period by the engine). */
  clear(threadId: string): void { this.buffers.delete(threadId); }
}
