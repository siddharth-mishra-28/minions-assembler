import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { executeChatTurn, type ActivityUpdate } from '../execution/chat-runner.js';
import type { DbAdapter } from '../store/adapter.js';
import type { McpServerConfig } from '../mcp/mcp.js';
import { errorSchema } from './route-schemas.js';

/**
 * Chat route group: persistent multi-turn conversations with registered agents
 * (ChatGPT-style: thread + transcript + streaming assistant replies). A thread is
 * either 1:1 with one registered agent, or a general thread where each message
 * @mentions the registered agent that should answer.
 */
export async function registerChatRoutes(app: FastifyInstance, ctx: { db: DbAdapter; runQueue: import('../core/run-queue.js').RunQueue; workspaceRoot: string }): Promise<void> {
  const { db, runQueue, workspaceRoot } = ctx;

  const mcpRegistryFromDb = (): { registry: Map<string, McpServerConfig>; tools: Map<string, string[]> } => {
    const registry = new Map<string, McpServerConfig>();
    const tools = new Map<string, string[]>();
    for (const row of db.listMcpServers()) {
      try {
        registry.set(row.name, JSON.parse((db.getMcpServer(row.name) as { config_json: string }).config_json) as McpServerConfig);
        const tj = row.tools_json ? JSON.parse(row.tools_json) as { name: string }[] : [];
        tools.set(row.name, tj.map((t) => t.name));
      } catch { /* skip malformed rows */ }
    }
    return { registry, tools };
  };

  const threadSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'chat_a1b2c3d4' },
      title: { type: 'string', example: 'Chat with fullstack-engineer@1.0.0' },
      agent_id: { type: ['string', 'null'] },
      session_id: { type: ['string', 'null'] },
      created_at: { type: 'string' },
      updated_at: { type: 'string' },
      // messages intentionally NOT in the response schema: transcripts are free-form
      // rows (mtid/role/author/content/run_id/created_at) and Fastify serialization
      // strips undeclared props (same free-form policy as GET /api/runs).
    },
    additionalProperties: true, // allow `messages` transcript rows through
  };

  const threadDir = (threadId: string): string =>
    resolve(join(workspaceRoot, '.chats', threadId));

  /** Extract @mention targets: `@my-agent do X` → matches registered agents by name prefix. */
  const resolveMentions = (content: string, participants: string[]): string[] => {
    const found = new Set<string>();
    for (const m of content.matchAll(/@([a-zA-Z0-9_-]+)/g)) {
      const q = m[1].toLowerCase();
      const hit = participants.find((p) => p.startsWith(`${q}@`) || p.toLowerCase().startsWith(q));
      if (hit) found.add(hit);
    }
    return [...found];
  };

  app.post('/api/chat/threads', {
    schema: {
      tags: ['chat'],
      summary: 'Open a chat thread with an agent',
      description:
        'Body: { agentId } → 1:1 thread with that registered agent. Empty body → general chat with no fixed agent (agent selectable per message via @mention).',
      body: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Registered agent id (name@version) for a 1:1 thread' },
          title: { type: 'string', description: 'Optional thread title' },
        },
      },
      response: { 200: threadSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { agentId?: string; title?: string };
    let agentId: string | null = null;
    let title = body.title?.trim() || '';
    if (body.agentId) {
      const agent = db.getAgent(body.agentId);
      if (!agent) return reply.code(404).send({ error: `agent not found: ${body.agentId}` });
      agentId = body.agentId;
      title = title || `Chat with ${body.agentId}`;
    } else {
      title = title || 'New chat';
    }
    const id = db.createChatThread({ title, agentId, sessionId: null });
    const thread = db.getChatThread(id);
    mkdirSync(threadDir(id), { recursive: true });
    return { ...thread, messages: [] };
  });

  app.get('/api/chat/threads', {
    schema: {
      tags: ['chat'],
      summary: 'List chat threads (newest first)',
      description: 'No response schema: thread rows are free-form, newest first. Filter by `?agentId=`.',
      querystring: { type: 'object', properties: { agentId: { type: 'string' } } },
    },
  }, async (req) => {
    const q = req.query as { agentId?: string };
    return { threads: db.listChatThreads({ agentId: q.agentId }) };
  });

  const getThreadOr404 = (id: string) => db.getChatThread(id);

  app.get('/api/chat/threads/:id', {
    schema: {
      tags: ['chat'],
      summary: 'Fetch one chat thread with its full transcript',
      description: 'No response schema: thread + free-form message rows (mtid, role, author, content, run_id, created_at).',
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = getThreadOr404(id);
    if (!t) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    return { ...t, messages: db.getChatMessages(id) };
  });

  app.delete('/api/chat/threads/:id', {
    schema: {
      tags: ['chat'],
      summary: 'Delete a chat thread and its transcript',
      response: { 200: { type: 'object', properties: { deleted: { type: 'boolean' } } }, 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getThreadOr404(id)) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    return { deleted: db.deleteChatThread(id) };
  });

  app.post('/api/chat/threads/:id/messages', {
    schema: {
      tags: ['chat'],
      summary: 'Send a message — runs an agent turn and streams the reply',
      description:
        '1:1 threads: the stored agent replies (multi-turn session; history is preserved). General threads: `@agentname <text>` routes the message to that registered agent. The reply streams via SSE on /api/chat/threads/:id/stream.',
      body: { type: 'object', required: ['content'], properties: { content: { type: 'string', description: 'The user message. In general chats @mention a registered agent to pick the responder.' } } },
      response: { 200: { type: 'object', properties: { userMessageId: { type: 'integer' }, replyMessageId: { type: 'integer' }, runId: { type: 'string' }, agentId: { type: 'string' }, text: { type: 'string' }, reasoning: { type: 'string' }, tools: { type: 'array', items: { type: 'object', properties: { callId: { type: 'string' }, name: { type: 'string' }, success: { type: 'boolean' } } } } } }, 400: errorSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { content?: string };
    const content = body.content?.trim();
    if (!content) return reply.code(400).send({ error: 'content is required' });
    const t = getThreadOr404(id);
    if (!t) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    const fixedAgentId = (t.agent_id as string | null) ?? null;

    let agentId = fixedAgentId as string | null;
    const userMessageId = db.addChatMessage(id, { role: 'user', author: 'user', content });

    // General threads route by @mention across every registered agent.
    let mentionsNote = '';
    if (!agentId) {
      const participants = db.listAgents().map((a) => a.id);
      const mentions = resolveMentions(content, participants);
      if (!mentions.length) {
        return reply.code(400).send({ error: 'thread has no fixed agent — create it with { agentId } or @mention a registered agent (e.g. @expense-tracker-dev fix the totals)', userMessageId });
      }
      agentId = mentions[0];
      if (mentions.length > 1) mentionsNote = `\n\n———\nMentioned agents routing this turn: ${mentions.map((m) => `@${m.split('@')[0]}`).join(', ')}`;
    }

    /** Live activity fan-out: current Thinking text + tool log, mirrored to any open SSE subscriber. */
    let liveAgent = agentId as string;
    let reasoningBuf = '';
    const toolBuf = new Map<string, { name: string; args?: unknown; result?: string; success?: boolean }>();
    const onActivity = (u: ActivityUpdate): void => {
      if (u.type === 'reasoning') reasoningBuf += u.delta;
      else if (u.type === 'tool-start') toolBuf.set(u.callId, { name: u.name, args: u.args });
      else if (u.type === 'tool-complete') toolBuf.set(u.callId, { ...(toolBuf.get(u.callId) ?? { name: u.name }), result: u.result, success: u.success });
      broadcast(id, { event: u.type, ...u as object, reasoning: u.type === 'reasoning' ? reasoningBuf : undefined });
    };

    // 1:1 agent thread
    const defRow = db.getAgent(agentId as string);
    if (!defRow) return reply.code(404).send({ error: `agent not found: ${agentId}` });
    const def = JSON.parse(defRow.definition_json as string);
    const { registry, tools } = mcpRegistryFromDb();
    let replyText = '';
    let runIdOut = '';
    const queued = await runQueue.run(async () => {
      const turn = await executeChatTurn({
        definition: def, agentId: agentId as string, db,
        sessionId: (t.session_id as string | null) ?? undefined,
        sessionIdPrefix: 'chat',
        content,
        workingDirectory: threadDir(id),
        mcpRegistry: registry, mcpRegistryTools: tools,
        onDelta: (d) => { replyText += d; },
        onActivity,
      });
      runIdOut = turn.runId;
      return turn;
    });
    if (!replyText && queued.text) replyText = queued.text;
    db.updateChatThread(id, { sessionId: queued.sessionId });
    const replyMessageId = db.addChatMessage(id, { role: 'assistant', author: agentId as string, content: replyText, runId: runIdOut });
    broadcast(id, { event: 'reply', runId: runIdOut, agentId, replyMessageId });
    return { userMessageId, replyMessageId, runId: runIdOut, agentId, text: replyText, reasoning: queued.reasoning, tools: queued.tools };
  });

  app.get('/api/chat/threads/:id/stream', {
    schema: {
      tags: ['chat'],
      summary: 'SSE transcript stream — replays the thread then stays open for live turn events',
      description: 'text/event-stream: first `event: message` lines replay stored messages, then the connection stays open. While a turn runs in this thread the route fans out live `reasoning`/`tool-start`/`tool-complete` activity events so the UI can render a real-time Thinking section; `reply` marks the finished turn (the transcript should be refetched).',
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getThreadOr404(id)) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const m of db.getChatMessages(id)) {
      reply.raw.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    }
    // Keep the stream open: turns broadcast their live activity into this subscriber set.
    reply.raw.write('event: ready\ndata: {}\n\n');
    addSubscriber(id, reply.raw);
    req.raw.on('close', () => removeSubscriber(id, reply.raw));
  });
}

// ---------- live turn fan-out (module-level registry; keys are thread ids, values are response sockets) ----------
const streamSubscribers = new Map<string, Set<ServerResponse>>();

function addSubscriber(threadId: string, s: ServerResponse): void {
  let set = streamSubscribers.get(threadId);
  if (!set) { set = new Set(); streamSubscribers.set(threadId, set); }
  set.add(s);
}
function removeSubscriber(threadId: string, s: ServerResponse): void {
  const set = streamSubscribers.get(threadId);
  if (!set) return;
  set.delete(s);
  if (!set.size) streamSubscribers.delete(threadId);
}
function broadcast(threadId: string, payload: Record<string, unknown>): void {
  const set = streamSubscribers.get(threadId);
  if (!set?.size) return;
  const line = `event: activity\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const s of set) { try { s.write(line); } catch { removeSubscriber(threadId, s); } }
}

