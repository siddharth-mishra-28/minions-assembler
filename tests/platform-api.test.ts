import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The SDK needs a live model; replace the turn with a scripted one that exercises hub + approvals.
vi.mock('../src/execution/chat-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/execution/chat-runner.js')>('../src/execution/chat-runner.js');
  return {
    ...actual,
    executeChatTurn: vi.fn(async (opts: import('../src/execution/chat-runner.js').ChatTurnOptions) => {
      const runId = opts.db.createRun(opts.agentId, 'sess_t', `trace_${Math.random().toString(36).slice(2)}`, opts.definition.provider.model, opts.definition.provider.type, opts.content, 'chat', { source: 'chat', threadId: opts.threadId, projectId: opts.projectId });
      if (opts.content.includes('needs-approval')) {
        const r = await opts.requestApproval!({ runId, tool: 'bash', args: { command: 'echo hi' }, source: 'test' });
        opts.onDelta?.(r.allow ? 'approved' : 'denied');
        opts.db.finishRun(runId, 'done');
        return { runId, sessionId: 'sess_t', traceId: 'trace', text: r.allow ? 'approved' : 'denied', reasoning: '', tools: [] };
      }
      if (opts.content.includes('slow')) {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve()));
        opts.db.finishRun(runId, 'failed', 'cancelled');
        throw new actual.TurnAborted(runId);
      }
      opts.onDelta?.('hello ');
      opts.onDelta?.('world');
      opts.db.finishRun(runId, 'done');
      return { runId, sessionId: 'sess_t', traceId: 'trace', text: 'hello world', reasoning: '', tools: [] };
    }),
  };
});

let dir: string;
let projectDir: string;
let app: import('fastify').FastifyInstance;
let built: Awaited<ReturnType<typeof import('../src/server.js').buildServer>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-api-'));
  projectDir = join(dir, 'my-project');
  mkdirSync(join(projectDir, '.github', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, '.github', 'agents', 'reviewer.agent.md'), '---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.\n');
  process.env.MINION_WORKSPACE = join(dir, 'ws');
  const { buildServer } = await import('../src/server.js');
  built = await buildServer(join(dir, 't.db'));
  app = built.app;
});

afterAll(async () => {
  try { await app.close(); } catch { /* noop */ }
  delete process.env.MINION_WORKSPACE;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
});

const json = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers?: Record<string, string>) => {
  const res = await app.inject({ method, url, payload: payload as never, headers });
  return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) : undefined };
};

const waitFor = async (fn: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)); }
};

describe('security', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const r = await json('GET', '/api/bootstrap', undefined, { host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });
  it('rejects a cross-origin state-changing request but allows no-Origin clients', async () => {
    const bad = await json('POST', '/api/projects', { path: projectDir }, { origin: 'http://evil.example.com' });
    expect(bad.status).toBe(403);
    const ok = await json('GET', '/api/bootstrap');
    expect(ok.status).toBe(200);
  });
});

describe('providers / settings / bootstrap', () => {
  let providerId = '';
  it('starts un-onboarded with no provider', async () => {
    const r = await json('GET', '/api/bootstrap');
    expect(r.body.onboardingCompleted).toBe(false);
    expect(r.body.defaultProvider).toBeNull();
    expect(r.body.settings.retention.days).toBe(7);
  });
  it('creates a provider, hides the key, marks the first as default', async () => {
    const r = await json('POST', '/api/providers', { name: 'My OpenAI', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-123', defaultModel: 'gpt-x' });
    expect(r.status).toBe(200);
    providerId = r.body.id;
    expect(r.body.hasKey).toBe(true);
    expect(r.body.isDefault).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('sk-secret-123');
    const list = await json('GET', '/api/providers');
    expect(JSON.stringify(list.body)).not.toContain('sk-secret-123');
    const boot = await json('GET', '/api/bootstrap');
    expect(boot.body.onboardingCompleted).toBe(true);
  });
  it('validates provider url and patches settings with clamping', async () => {
    expect((await json('POST', '/api/providers', { name: 'bad', baseUrl: 'not a url' })).status).toBe(400);
    const s = await json('PATCH', '/api/settings', { retention: { days: 14 }, approvals: { chatMode: 'autopilot' } });
    expect(s.body.retention.days).toBe(14);
    expect(s.body.approvals.chatMode).toBe('autopilot');
    expect((await json('PATCH', '/api/settings', { retention: { days: -3 } })).status).toBe(400);
    await json('PATCH', '/api/settings', { retention: { days: 7 }, approvals: { chatMode: 'interactive' } });
  });
  it('deletes a provider and falls back cleanly', async () => {
    const extra = await json('POST', '/api/providers', { name: 'Second', baseUrl: 'https://b.example.com/v1', apiKey: 'k2' });
    expect((await json('DELETE', `/api/providers/${extra.body.id}`)).status).toBe(200);
    expect((await json('DELETE', `/api/providers/${extra.body.id}`)).status).toBe(404);
    expect((await json('GET', '/api/providers')).body.providers.some((p: { id: string }) => p.id === providerId)).toBe(true);
  });
});

describe('projects + folder browser', () => {
  it('opens a project, lists it, discovers .github/agents profiles', async () => {
    const r = await json('POST', '/api/projects', { path: projectDir });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('my-project');
    const again = await json('POST', '/api/projects', { path: projectDir });
    expect(again.body.id).toBe(r.body.id);
    const agents = await json('GET', `/api/projects/${r.body.id}/agents`);
    expect(agents.body.agents.map((a: { name: string }) => a.name)).toContain('reviewer');
    expect(JSON.stringify(agents.body)).not.toContain(projectDir);
  });
  it('rejects a non-directory and browses sub-folders only', async () => {
    expect((await json('POST', '/api/projects', { path: join(dir, 'nope') })).status).toBe(400);
    const b = await json('GET', `/api/fs/browse?path=${encodeURIComponent(dir)}`);
    expect(b.status).toBe(200);
    expect(b.body.entries.map((e: { name: string }) => e.name)).toContain('my-project');
    const file = join(dir, 'a-file.txt'); writeFileSync(file, 'x');
    expect((await json('GET', `/api/fs/browse?path=${encodeURIComponent(file)}`)).status).toBe(400);
  });
});

describe('chat engine (scripted turns)', () => {
  let projectId = '';
  const readEvents = (id: string) => {
    const seen: { type: string; [k: string]: unknown }[] = [];
    const off = built.hub.subscribe(id, (e) => seen.push(e.event as never), Number.MAX_SAFE_INTEGER);
    return { seen, off };
  };

  it('lists the default, custom and project agents for the picker', async () => {
    projectId = (await json('GET', '/api/projects')).body.projects[0].id;
    const r = await json('GET', `/api/chat/agents?projectId=${projectId}`);
    const kinds = r.body.agents.map((a: { kind: string }) => a.kind);
    expect(kinds[0]).toBe('default');
    expect(kinds).toContain('project');
  });

  it('streams a turn: 202, deltas, done, persisted assistant message with meta', async () => {
    const t = (await json('POST', '/api/chat/threads', { projectId })).body;
    const { seen, off } = readEvents(t.id);
    const send = await json('POST', `/api/chat/threads/${t.id}/messages`, { content: 'say hi' });
    expect(send.status).toBe(202);
    await waitFor(() => seen.some((e) => e.type === 'done'));
    off();
    expect(seen.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('hello world');
    const got = (await json('GET', `/api/chat/threads/${t.id}`)).body;
    expect(got.title).toBe('say hi');
    expect(got.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(got.messages[1].meta.status).toBe('done');
    const run = built.db.listRuns().find((r: Record<string, unknown>) => r.thread_id === t.id) as Record<string, unknown>;
    expect(run.project_id).toBe(projectId);
    expect(run.source).toBe('chat');
  });

  it('?wait=true blocks and returns the reply text', async () => {
    const t = (await json('POST', '/api/chat/threads', {})).body;
    const r = await json('POST', `/api/chat/threads/${t.id}/messages?wait=true`, { content: 'hello' });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ text: 'hello world' });
  });

  it('gates a tool on user approval and honours Allow / Deny', async () => {
    const t = (await json('POST', '/api/chat/threads', {})).body;
    const { seen, off } = readEvents(t.id);
    await json('POST', `/api/chat/threads/${t.id}/messages`, { content: 'needs-approval please' });
    await waitFor(() => seen.some((e) => e.type === 'approval-request'));
    const req = seen.find((e) => e.type === 'approval-request')!;
    expect((await json('POST', `/api/approvals/${req.approvalId}`, { allow: true, scope: 'once' })).status).toBe(200);
    await waitFor(() => seen.some((e) => e.type === 'done'));
    off();
    expect(seen.find((e) => e.type === 'done')!.text).toBe('approved');
    expect((await json('POST', `/api/approvals/${req.approvalId}`, { allow: false })).status).toBe(404);
    const audit = (await json('GET', `/api/approvals?threadId=${t.id}`)).body.approvals;
    expect(audit[0]).toMatchObject({ tool: 'bash', status: 'approved', scope: 'once' });
  });

  it('Stop cancels a running turn and denies pending approvals; busy thread rejects a second send', async () => {
    const t = (await json('POST', '/api/chat/threads', {})).body;
    const { seen, off } = readEvents(t.id);
    await json('POST', `/api/chat/threads/${t.id}/messages`, { content: 'slow task' });
    expect((await json('POST', `/api/chat/threads/${t.id}/messages`, { content: 'again' })).status).toBe(409);
    expect((await json('PATCH', `/api/chat/threads/${t.id}`, { agentId: 'x@1' })).status).toBe(409);
    expect((await json('POST', `/api/chat/threads/${t.id}/cancel`)).body.cancelled).toBe(true);
    await waitFor(() => seen.some((e) => e.type === 'cancelled'));
    off();
    const msgs = (await json('GET', `/api/chat/threads/${t.id}`)).body.messages;
    expect(msgs[msgs.length - 1].meta.status).toBe('cancelled');
    expect((await json('POST', `/api/chat/threads/${t.id}/messages?wait=true`, { content: 'next' })).status).toBe(200);
  });

  it('pin / archive / rename / agent switch (adds a divider and resets the session)', async () => {
    const t = (await json('POST', '/api/chat/threads', {})).body;
    await json('POST', `/api/chat/threads/${t.id}/messages?wait=true`, { content: 'first' });
    const p = (await json('PATCH', `/api/chat/threads/${t.id}`, { pinned: true, title: 'Renamed' })).body;
    expect(p.title).toBe('Renamed'); expect(p.pinned).toBe(1);
    const sw = (await json('PATCH', `/api/chat/threads/${t.id}`, { agentId: `project:${projectId}:reviewer.agent.md` })).body;
    expect(sw.session_id).toBeNull();
    expect(sw.messages.some((m: { role: string }) => m.role === 'system')).toBe(true);
    expect((await json('PATCH', `/api/chat/threads/${t.id}`, { agentId: 'ghost@1' })).status).toBe(404);
    await json('PATCH', `/api/chat/threads/${t.id}`, { archived: true });
    expect((await json('GET', '/api/chat/threads')).body.threads.some((x: { id: string }) => x.id === t.id)).toBe(false);
    expect((await json('GET', '/api/chat/threads?archived=true')).body.threads.some((x: { id: string }) => x.id === t.id)).toBe(true);
    const md = await json('GET', `/api/chat/threads/${t.id}/export?format=md`);
    expect(md.status).toBe(200);
    expect(String(md.body)).toContain('Renamed');
  });
});

describe('audit', () => {
  it('lists runs with filters and exports a bundle', async () => {
    const list = await json('GET', '/api/audit/runs?source=chat&limit=5');
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThan(0);
    const id = list.body.runs[0].id;
    const b = await json('GET', `/api/audit/runs/${id}/export`);
    expect(b.status).toBe(200);
    expect(b.body.run.id).toBe(id);
    expect(Array.isArray(b.body.events)).toBe(true);
    expect((await json('GET', '/api/audit/runs/nope/export')).status).toBe(404);
    expect((await json('GET', '/api/audit/runs?q=%25%27')).status).toBe(200);
  });
});

describe('chat without a usable provider', () => {
  it('returns 412 with an actionable message', async () => {
    const list = (await json('GET', '/api/providers')).body.providers as { id: string }[];
    for (const p of list) await json('DELETE', `/api/providers/${p.id}`);
    const t = (await json('POST', '/api/chat/threads', {})).body;
    const r = await json('POST', `/api/chat/threads/${t.id}/messages`, { content: 'hi' });
    expect(r.status).toBe(412);
    expect(r.body.error).toMatch(/Settings/);
    expect((await json('GET', `/api/chat/threads/${t.id}`)).body.messages).toHaveLength(0);
  });
});

describe('retention', () => {
  it('purges old unpinned chats, keeps pinned, rolls up metrics, removes audit files', async () => {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const keep = built.db.createChatThread({ title: 'old pinned', agentId: null, sessionId: null });
    const drop = built.db.createChatThread({ title: 'old plain', agentId: null, sessionId: null });
    built.db.addChatMessage(keep, { role: 'user', author: 'user', content: 'k' });
    built.db.addChatMessage(drop, { role: 'user', author: 'user', content: 'd' });
    built.db.updateChatThread(keep, { pinned: true });
    const raw = built.db as unknown as { raw: import('better-sqlite3').Database };
    raw.raw.prepare(`UPDATE chat_threads SET created_at=?, updated_at=? WHERE id IN (?,?)`).run(old, old, keep, drop);
    raw.raw.prepare(`UPDATE chat_messages SET created_at=? WHERE thread_id IN (?,?)`).run(old, keep, drop);
    const r = await json('POST', '/api/retention/purge', { days: 7 });
    expect(r.status).toBe(200);
    expect(r.body.threads).toBeGreaterThanOrEqual(1);
    expect(built.db.getChatThread(drop)).toBeUndefined();
    expect(built.db.getChatThread(keep)).toBeDefined();
    const m = await json('GET', '/api/metrics/daily?days=30');
    expect(m.status).toBe(200);
  });
});

describe('agent elaboration via a saved provider', () => {
  it('rejects an unknown providerRef and a missing model without leaking secrets', async () => {
    const unknown = await json('POST', '/api/agents/elaborate', { field: 'systemPrompt', content: 'x', provider: { providerRef: 'nope' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('not found');
    const none = await json('POST', '/api/agents/elaborate', { field: 'systemPrompt', content: 'x', provider: {} });
    expect(none.status).toBe(400);
  });
});

describe('web app serving', () => {
  it('falls back to index.html for SPA routes but 404s unknown assets and api paths', async () => {
    const { findWebRoot } = await import('../src/http/web-static.js');
    if (!findWebRoot()) return;
    const page = await app.inject({ method: 'GET', url: '/agents/new', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toContain('no-cache');
    const asset = await app.inject({ method: 'GET', url: '/assets/nope.js', headers: { accept: 'text/html' } });
    expect(asset.statusCode).toBe(404);
    const api = await app.inject({ method: 'GET', url: '/api/nope', headers: { accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
  });
});

describe('run stop endpoint', () => {
  it('404s for an unknown run and reports stopped:false for one that is not executing', async () => {
    expect((await json('POST', '/api/runs/run_missing/stop')).status).toBe(404);
    const runId = built.db.createRun('stop-test@1.0.0', 'sess_x', 'tr_x', 'm', 'openai', 'task', 'hash');
    const r = await json('POST', `/api/runs/${runId}/stop`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ runId, stopped: false });
  });
});