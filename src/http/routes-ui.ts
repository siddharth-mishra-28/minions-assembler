import type { FastifyInstance } from 'fastify';
import { dashboardPage, agentsPage, agentDetailPage, runsPage, runDetailPage, sessionDetailPage, mcpPage, mcpDetailPage } from '../ui/ui-pages.js';
import { chatPage } from '../ui/ui-chat.js';
import { pageShell } from '../ui/ui-kit.js';
import { esc } from '../ui/ui-util.js';
import type { DbAdapter } from '../store/adapter.js';

/**
 * UI route group: server-rendered HTML screens (dashboard, agents, runs, sessions,
 * MCP, chat). Screens live in ui-pages.ts / ui-wizard.ts / ui-chat.ts; this module only
 * wires them to URLs and shared 404 pages.
 */
export async function registerUiRoutes(app: FastifyInstance, ctx: { db: DbAdapter }): Promise<void> {
  const { db } = ctx;

  const notFoundPage = (what: string, backHref: string, backLabel: string) =>
    pageShell({
      title: 'Not found', crumb: 'Not found', path: '',
      body: `<div class="card"><div class="alert err"><b>✕</b><div><b>${esc(what)} not found.</b> <a href="${backHref}">${backLabel} →</a></div></div></div>`,
    });

  // Chat in one screen: /ui/chat with an optional active thread.
  app.get('/ui/chat', async (_req, reply) => reply.type('text/html').send(chatPage(db)));
  app.get('/ui/chat/:id', async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    // '_new' is the blank-composer state (current threads stay saved in the rail).
    if (id === '_new') return reply.type('text/html').send(chatPage(db, { threadId: '_new' }));
    if (!db.getChatThread(id)) return reply.code(404).type('text/html').send(notFoundPage(`Chat thread ${id}`, '/ui/chat', 'All chats'));
    reply.type('text/html').send(chatPage(db, { threadId: id }));
  });

  app.get('/', async (_req, reply) => reply.type('text/html').send(dashboardPage(db)));
  // Legacy /ui — the define flow now lives as a tab on the Agents screen.
  app.get('/ui', async (_req, reply) => reply.redirect('/ui/agents?tab=define'));
  app.get('/ui/agents', async (req, reply) => {
    const tab = (req.query as { tab?: string }).tab === 'define' ? 'define' : 'agents';
    reply.type('text/html').send(agentsPage(db, tab));
  });
  app.get('/ui/agents/:id', async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).type('text/html').send(notFoundPage(`Agent ${id}`, '/ui/agents', 'All agents'));
    reply.type('text/html').send(agentDetailPage(agent as { id: string; name: string; version: string; definition_json: string; created_at: string }, db));
  });
  app.get('/ui/runs', async (_req, reply) => reply.type('text/html').send(runsPage(db)));
  app.get('/ui/runs/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = db.getRun(id);
    if (!run) return reply.code(404).type('text/html').send(notFoundPage(`Run ${id}`, '/ui/runs', 'All runs'));
    reply.type('text/html').send(runDetailPage(run as Record<string, unknown>, db));
  });
  // Sessions were merged into the Runs screen — keep deep links working, drop the separate list.
  app.get('/ui/sessions', async (_req, reply) => reply.redirect('/ui/runs'));
  app.get('/ui/sessions/:sid', async (req, reply) => {
    const sid = decodeURIComponent((req.params as { sid: string }).sid);
    const s = db.getSession(sid);
    if (!s) return reply.code(404).type('text/html').send(notFoundPage(`Session ${sid}`, '/ui/runs', 'All runs'));
    // Prefer the linked run detail (the single tracking screen); fall back to session facts.
    const runId = s.run_id as string | undefined;
    if (runId && db.getRun(runId)) return reply.redirect(`/ui/runs/${encodeURIComponent(runId)}`);
    reply.type('text/html').send(sessionDetailPage(s as Record<string, unknown>, db));
  });
  app.get('/ui/mcp', async (_req, reply) => reply.type('text/html').send(mcpPage(db)));
  app.get('/ui/mcp/:name', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const srv = db.getMcpServer(name);
    if (!srv) return reply.code(404).type('text/html').send(notFoundPage(`MCP server ${name}`, '/ui/mcp', 'All servers'));
    reply.type('text/html').send(mcpDetailPage(name, srv, db));
  });
}
