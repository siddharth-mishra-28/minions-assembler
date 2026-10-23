import type { FastifyInstance, FastifyReply } from 'fastify';
import { mkdirSync } from 'node:fs';
import type { DbAdapter } from '../store/adapter.js';
import type { PlatformStore } from '../store/platform.js';
import type { ChatHub, HubEnvelope } from '../execution/chat-hub.js';
import type { ApprovalBroker } from '../execution/approvals.js';
import { ChatEngine, ChatEngineError } from '../execution/chat-engine.js';
import { DEFAULT_AGENT_ID, PROJECT_AGENT_PREFIX, discoverProjectAgents } from '../agents/default-agent.js';
import { errorSchema } from './route-schemas.js';

type ThreadRow = Record<string, unknown>;

const parseMessages = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.map((m) => {
    let meta: unknown = null;
    try { meta = m.meta_json ? JSON.parse(m.meta_json as string) : null; } catch { /* corrupt meta is ignored */ }
    const { meta_json: _drop, ...rest } = m;
    return { ...rest, meta };
  });

/**
 * Chat route group. A thread belongs to an optional project folder and a selected agent:
 * the built-in Copilot agent (default), a registered custom agent, or a `.github/agents`
 * profile found inside the project. Sending a message returns 202 immediately; the turn is
 * streamed over SSE (`GET /api/chat/threads/:id/events`) and can be stopped.
 */
export async function registerChatRoutes(
  app: FastifyInstance,
  ctx: { db: DbAdapter; platform: PlatformStore; engine: ChatEngine; hub: ChatHub; broker: ApprovalBroker },
): Promise<void> {
  const { db, platform, engine, hub, broker } = ctx;

  const threadView = (t: ThreadRow) => ({ ...t, busy: engine.isBusy(t.id as string) });

  const agentLabel = (id: string | null): string => {
    if (!id || id === DEFAULT_AGENT_ID) return 'GitHub Copilot';
    if (id.startsWith(PROJECT_AGENT_PREFIX)) return id.split(':').slice(2).join(':').replace(/\.(agent\.)?md$/i, '');
    return id;
  };

  /** Extract @mention targets (general threads only): `@my-agent do X` -> registered agent id. */
  const resolveMentions = (content: string): string[] => {
    const participants = db.listAgents().map((a) => a.id);
    const found = new Set<string>();
    for (const m of content.matchAll(/@([a-zA-Z0-9_-]+)/g)) {
      const q = m[1].toLowerCase();
      const hit = participants.find((p) => p.startsWith(`${q}@`) || p.toLowerCase().startsWith(q));
      if (hit) found.add(hit);
    }
    return [...found];
  };

  const sendError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ChatEngineError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };

  app.get('/api/chat/agents', {
    schema: {
      tags: ['chat'],
      summary: 'Agents selectable in the chat picker',
      description: 'The built-in Copilot agent, every published custom agent, and (when `projectId` is given) the agent profiles found in that project\'s .github/agents folder.',
      querystring: { type: 'object', properties: { projectId: { type: 'string' } } },
    },
  }, async (req) => {
    const q = req.query as { projectId?: string };
    const provider = platform.getDefaultProvider();
    const agents: { id: string; name: string; kind: 'default' | 'custom' | 'project'; description?: string; model?: string }[] = [{
      id: DEFAULT_AGENT_ID, name: 'GitHub Copilot', kind: 'default',
      description: 'Default agent. Works in your project and asks before changing anything.',
      model: platform.getSettings().defaults.model ?? provider?.defaultModel ?? undefined,
    }];
    for (const a of db.listAgents()) {
      let description: string | undefined; let model: string | undefined;
      try {
        const def = JSON.parse((db.getAgent(a.id) as { definition_json: string }).definition_json) as { metadata?: { description?: string }; provider?: { model?: string } };
        description = def.metadata?.description; model = def.provider?.model;
      } catch { /* listing must not fail on one bad row */ }
      agents.push({ id: a.id, name: a.id.split('@')[0], kind: 'custom', description, model });
    }
    const project = q.projectId ? platform.getProject(q.projectId) : undefined;
    if (project) for (const p of discoverProjectAgents(project)) agents.push({ id: p.id, name: p.name, kind: 'project', description: p.description, model: p.model });
    return { agents };
  });

  app.post('/api/chat/threads', {
    schema: {
      tags: ['chat'],
      summary: 'Create a chat thread',
      description: 'All fields optional. No `agentId` = the built-in Copilot agent. `projectId` binds the chat to a project folder.',
      body: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'copilot-default@builtin, a registered `name@version`, or `project:<projectId>:<file>`' },
          projectId: { type: 'string' },
          model: { type: 'string', description: 'Per-chat model override' },
          title: { type: 'string' },
        },
      },
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { agentId?: string; projectId?: string; model?: string; title?: string };
    const project = body.projectId ? platform.getProject(body.projectId) : undefined;
    if (body.projectId && !project) return reply.code(404).send({ error: `project not found: ${body.projectId}` });
    let agentId: string | null = null;
    if (body.agentId && body.agentId !== DEFAULT_AGENT_ID) {
      if (!body.agentId.startsWith(PROJECT_AGENT_PREFIX) && !db.getAgent(body.agentId)) return reply.code(404).send({ error: `agent not found: ${body.agentId}` });
      agentId = body.agentId;
    }
    const title = body.title?.trim() || (agentId && !agentId.startsWith(PROJECT_AGENT_PREFIX) ? `Chat with ${agentId}` : 'New chat');
    const id = db.createChatThread({ title, agentId, sessionId: null, projectId: body.projectId ?? null, modelOverride: body.model ?? null });
    mkdirSync(engine.threadDir(id), { recursive: true });
    if (project) platform.openProject(project.path);
    return { ...threadView(db.getChatThread(id)!), messages: [] };
  });

  app.get('/api/chat/threads', {
    schema: {
      tags: ['chat'],
      summary: 'List chat threads (pinned first, then most recent)',
      querystring: { type: 'object', properties: { agentId: { type: 'string' }, projectId: { type: 'string' }, q: { type: 'string' }, archived: { type: 'boolean' } } },
    },
  }, async (req) => {
    const q = req.query as { agentId?: string; projectId?: string; q?: string; archived?: boolean };
    return { threads: db.listChatThreads({ agentId: q.agentId, projectId: q.projectId, q: q.q, includeArchived: q.archived }).map(threadView) };
  });

  app.get('/api/chat/threads/:id', {
    schema: { tags: ['chat'], summary: 'One thread with its transcript and pending approvals', response: { 404: errorSchema } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = db.getChatThread(id);
    if (!t) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    const live = new Set(broker.pendingFor(id));
    return { ...threadView(t), messages: parseMessages(db.getChatMessages(id)), pendingApprovals: platform.listApprovals({ threadId: id, status: 'pending' }).filter((a) => live.has(a.id)) };
  });

  app.patch('/api/chat/threads/:id', {
    schema: {
      tags: ['chat'],
      summary: 'Rename, pin, archive, or change agent/model/approval mode of a thread',
      description: 'Changing the agent, project or model starts a fresh model session (the visible transcript is kept and a divider message is added).',
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 }, pinned: { type: 'boolean' }, archived: { type: 'boolean' },
          agentId: { type: ['string', 'null'] }, projectId: { type: ['string', 'null'] }, model: { type: ['string', 'null'] },
          approvalMode: { type: ['string', 'null'], enum: ['interactive', 'autopilot', 'strict', null] },
        },
        additionalProperties: false,
      },
      response: { 404: errorSchema, 409: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = db.getChatThread(id);
    if (!t) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    const b = req.body as { title?: string; pinned?: boolean; archived?: boolean; agentId?: string | null; projectId?: string | null; model?: string | null; approvalMode?: string | null };
    const nextAgent = b.agentId === undefined ? undefined : (b.agentId && b.agentId !== DEFAULT_AGENT_ID ? b.agentId : null);
    const switchesAgent = nextAgent !== undefined && nextAgent !== ((t.agent_id as string | null) ?? null);
    const switchesProject = b.projectId !== undefined && (b.projectId || null) !== ((t.project_id as string | null) ?? null);
    const resets = switchesAgent || switchesProject || b.model !== undefined;
    if (resets && engine.isBusy(id)) return reply.code(409).send({ error: 'Stop the running turn before changing agent, project or model.' });
    const project = b.projectId ? platform.getProject(b.projectId) : undefined;
    if (b.projectId && !project) return reply.code(404).send({ error: `project not found: ${b.projectId}` });
    if (switchesAgent && nextAgent && !nextAgent.startsWith(PROJECT_AGENT_PREFIX) && !db.getAgent(nextAgent)) return reply.code(404).send({ error: `agent not found: ${nextAgent}` });
    db.updateChatThread(id, {
      title: b.title, pinned: b.pinned, archived: b.archived,
      agentId: switchesAgent ? nextAgent : undefined,
      projectId: b.projectId, modelOverride: b.model, approvalMode: b.approvalMode,
      ...(resets ? { sessionId: null } : {}),
    });
    if (switchesAgent) db.addChatMessage(id, { role: 'system', author: 'system', content: `Switched agent to ${agentLabel(nextAgent ?? null)}`, meta: { kind: 'agent-switch', agentId: nextAgent ?? DEFAULT_AGENT_ID } });
    if (switchesProject) db.addChatMessage(id, { role: 'system', author: 'system', content: project ? `Project changed to ${project.name}` : 'Project detached', meta: { kind: 'project-switch', projectId: b.projectId ?? null } });
    return { ...threadView(db.getChatThread(id)!), messages: parseMessages(db.getChatMessages(id)) };
  });

  app.delete('/api/chat/threads/:id', {
    schema: { tags: ['chat'], summary: 'Delete a thread and its transcript', response: { 404: errorSchema } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getChatThread(id)) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    engine.cancel(id);
    hub.clear(id);
    return { deleted: db.deleteChatThread(id) };
  });

  app.post('/api/chat/threads/:id/messages', {
    schema: {
      tags: ['chat'],
      summary: 'Send a message',
      description: 'Returns 202 immediately; follow the turn on `GET /api/chat/threads/:id/events`. Add `?wait=true` to block until the reply is complete and receive it in the response (API clients). In a general thread (no fixed agent) an `@agentname` mention routes the message to that registered agent; otherwise the Copilot agent answers.',
      querystring: { type: 'object', properties: { wait: { type: 'boolean' } } },
      body: { type: 'object', required: ['content'], properties: { content: { type: 'string', maxLength: 200000 } } },
      response: {
        202: { type: 'object', properties: { userMessageId: { type: 'integer' }, agentId: { type: 'string' }, model: { type: 'string' }, status: { type: 'string' } } },
        400: errorSchema, 404: errorSchema, 409: errorSchema, 412: errorSchema,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { wait?: boolean };
    const content = ((req.body ?? {}) as { content?: string }).content?.trim();
    if (!content) return reply.code(400).send({ error: 'content is required' });
    const t = db.getChatThread(id);
    if (!t) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    const mention = !t.agent_id ? resolveMentions(content)[0] : undefined;

    let waiter: Promise<Record<string, unknown>> | undefined;
    if (q.wait) {
      waiter = new Promise((resolve, reject) => {
        const off = hub.subscribe(id, (env: HubEnvelope) => {
          const e = env.event;
          if (e.type === 'done') { off(); resolve({ runId: e.runId, replyMessageId: e.messageId, text: e.text }); }
          else if (e.type === 'error') { off(); reject(new ChatEngineError(e.message, 502)); }
          else if (e.type === 'cancelled') { off(); reject(new ChatEngineError('turn cancelled', 409)); }
        }, Number.MAX_SAFE_INTEGER);
      });
      waiter.catch(() => { /* surfaced below */ });
    }
    let started: ReturnType<ChatEngine['start']>;
    try { started = engine.start(id, content, { agentId: mention }); } catch (e) { return sendError(reply, e); }
    if (!waiter) return reply.code(202).send({ userMessageId: started.userMessageId, agentId: started.agentId, model: started.model, status: 'running' });
    try {
      const r = await waiter;
      return { userMessageId: started.userMessageId, agentId: started.agentId, ...r };
    } catch (e) { return sendError(reply, e); }
  });

  app.post('/api/chat/threads/:id/cancel', {
    schema: { tags: ['chat'], summary: 'Stop the running turn (pending approvals are denied)', response: { 404: errorSchema } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getChatThread(id)) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    return { cancelled: engine.cancel(id) };
  });

  app.get('/api/chat/threads/:id/events', {
    schema: {
      tags: ['chat'],
      summary: 'Typed SSE stream for one thread',
      description: 'Events: turn-start, delta, reasoning, tool-start, tool-complete, approval-request, approval-resolved, usage, done, error, cancelled. Supports `Last-Event-ID` for reconnects. A `ready` event carries `{ busy, pending }` once any replay is flushed.',
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getChatThread(id)) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    const last = Number(req.headers['last-event-id'] ?? 0) || 0;
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (env: HubEnvelope): void => { try { reply.raw.write(`id: ${env.id}\nevent: ${env.event.type}\ndata: ${JSON.stringify(env.event)}\n\n`); } catch { /* socket closed */ } };
    // Replay the in-flight turn so a late/reconnecting client can rebuild it; an idle thread is already fully persisted.
    const busy = engine.isBusy(id);
    const off = hub.subscribe(id, write, busy || last ? last : Number.MAX_SAFE_INTEGER);
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ busy, pending: broker.pendingFor(id) })}\n\n`);
    const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    req.raw.on('close', () => { clearInterval(ping); off(); });
  });

  app.get('/api/chat/threads/:id/export', {
    schema: { tags: ['chat'], summary: 'Export a transcript as Markdown or JSON', querystring: { type: 'object', properties: { format: { type: 'string', enum: ['md', 'json'] } } }, response: { 404: errorSchema } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = db.getChatThread(id);
    if (!t) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    const messages = parseMessages(db.getChatMessages(id));
    const fmt = (req.query as { format?: string }).format ?? 'md';
    const safe = String(t.title ?? id).replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || id;
    if (fmt === 'json') {
      reply.header('Content-Disposition', `attachment; filename="${safe}.json"`);
      return { thread: t, messages, approvals: platform.listApprovals({ threadId: id, limit: 1000 }) };
    }
    const md = [`# ${String(t.title ?? id)}`, '', `Agent: ${agentLabel((t.agent_id as string | null) ?? null)}`, '',
      ...messages.map((m) => `## ${m.role === 'user' ? 'You' : String(m.author)}  \n_${String(m.created_at)}_\n\n${String(m.content)}\n`)].join('\n');
    reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${safe}.md"`);
    return md;
  });

  // Legacy (v1 UI) SSE shape: replay + `activity` events. Kept until the old UI is removed.
  app.get('/api/chat/threads/:id/stream', {
    schema: { tags: ['chat'], summary: 'Deprecated: legacy SSE (use /events)', deprecated: true, response: { 404: errorSchema } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getChatThread(id)) return reply.code(404).send({ error: `chat thread not found: ${id}` });
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const m of parseMessages(db.getChatMessages(id))) reply.raw.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    reply.raw.write('event: ready\ndata: {}\n\n');
    let reasoning = '';
    const emit = (payload: Record<string, unknown>): void => { try { reply.raw.write(`event: activity\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* closed */ } };
    const off = hub.subscribe(id, (env) => {
      const e = env.event;
      if (e.type === 'reasoning') { reasoning += e.delta; emit({ event: 'reasoning', delta: e.delta, reasoning }); }
      else if (e.type === 'tool-start' || e.type === 'tool-complete') emit({ event: e.type, ...e });
      else if (e.type === 'done') { reasoning = ''; emit({ event: 'reply', runId: e.runId, replyMessageId: e.messageId }); }
    }, Number.MAX_SAFE_INTEGER);
    req.raw.on('close', off);
  });
}
