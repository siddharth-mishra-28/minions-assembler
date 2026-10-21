import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { createUsageProxy, type UsageCapture } from '../src/execution/usage-proxy.js';

let upstream: Server | undefined;
let seenBodies: Record<string, unknown>[] = [];

async function startUpstream(handler: (body: Buffer | undefined, req: import('node:http').IncomingMessage) => { status: number; contentType: string; payload: string }): Promise<number> {
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      if (body) seenBodies.push(body);
      const out = handler(raw ? Buffer.from(raw) : undefined, req);
      res.writeHead(out.status, { 'content-type': out.contentType });
      res.end(out.payload);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  upstream = srv;
  const address = srv.address();
  return (typeof address === 'object' && address ? address.port : 0);
}

afterAll(async () => {
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
});

describe('usage-proxy', () => {
  it('captures usage from non-stream completion JSON and forwards the body verbatim', async () => {
    const port = await startUpstream(() => ({
      status: 200,
      contentType: 'application/json',
      payload: JSON.stringify({ id: 'resp-1', model: 'm', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } } }),
    }));
    const captures: UsageCapture[] = [];
    const proxy = await createUsageProxy({ upstream: `http://127.0.0.1:${port}`, onUsage: (u) => captures.push(u) });
    let resp = await fetch(`${proxy.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    expect(resp.status).toBe(200);
    const fwd = (await resp.json()) as { id: string; usage: { prompt_tokens: number } };
    expect(fwd.id).toBe('resp-1');
    expect(fwd.usage.prompt_tokens).toBe(10);
    expect(captures).toHaveLength(1);
    expect(captures[0].tokIn).toBe(10);
    expect(captures[0].tokOut).toBe(5);
    expect(captures[0].tokTotal).toBe(15);
    expect(captures[0].tokReasoning).toBe(2);
    expect(captures[0].model).toBe('m');
    expect(captures[0].requestId).toBe('resp-1');
    await proxy.close();
  });

  it('adds stream_options.include_usage to streaming requests and captures the final SSE usage chunk', async () => {
    const port = await startUpstream((body, req) => {
      const wantsSse = req.headers['x-mode'] === 'stream';
      if (!wantsSse) return { status: 200, contentType: 'application/json', payload: '{}' };
      return {
        status: 200,
        contentType: 'text/event-stream',
        payload: [
          'data: {"id":"c1","usage":null,"model":"m2"}',
          '',
          'data: {"id":"c1","choices":[{"delta":{"content":"a"}}]}',
          '',
          'data: {"id":"c1","usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      };
    });
    const captures: UsageCapture[] = [];
    const proxy = await createUsageProxy({ upstream: `http://127.0.0.1:${port}`, onUsage: (u) => captures.push(u) });
    let resp = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', headers: { 'x-mode': 'stream', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('data: {"id":"c1","usage":{"prompt_tokens":7');
    expect(text).toContain('[DONE]');
    // upstream saw the rewritten body with include_usage forced on
    const sent = seenBodies.find((b) => typeof (b as { stream?: unknown }).stream === 'boolean') as { stream: boolean; stream_options?: { include_usage?: boolean } } | undefined;
    expect(sent?.stream).toBe(true);
    expect(sent?.stream_options?.include_usage).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0].tokIn).toBe(7);
    expect(captures[0].tokOut).toBe(3);
    expect(captures[0].model).toBe('m2');
    await proxy.close();
  });

  it('does not report usage when the provider sends none, and forwards errors', async () => {
    const port = await startUpstream((body, req) => {
      if (req.headers['x-mode'] === 'nouse') return { status: 200, contentType: 'application/json', payload: JSON.stringify({ id: 'r2', choices: [] }) };
      return { status: 502, contentType: 'application/json', payload: JSON.stringify({ error: { message: 'upstream boom' } }) };
    });
    const captures: UsageCapture[] = [];
    const proxy = await createUsageProxy({ upstream: `http://127.0.0.1:${port}`, onUsage: (u) => captures.push(u) });
    let resp = await fetch(`${proxy.url}/chat/completions`, { method: 'POST', headers: { 'x-mode': 'nouse', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) });
    expect(resp.status).toBe(200);
    await resp.json();
    resp = await fetch(`${proxy.url}/chat/completions`, { method: 'POST', body: '{}' });
    expect(resp.status).toBe(502);
    expect(captures).toHaveLength(0);
    await proxy.close();
  });

  it('handles concurrent forwards without mixing captures', async () => {
    const port = await startUpstream((body, req) => {
      const label = req.headers['x-tag'] ?? 'x';
      return { status: 200, contentType: 'application/json', payload: JSON.stringify({ id: `r-${label}`, usage: { prompt_tokens: label === 'a' ? 100 : 200, completion_tokens: 1, total_tokens: 101 } }) };
    });
    const captures: UsageCapture[] = [];
    const proxy = await createUsageProxy({ upstream: `http://127.0.0.1:${port}`, onUsage: (u) => captures.push(u) });
    const results = await Promise.all(['a', 'b'].map((tag) => fetch(`${proxy.url}/chat/completions`, { method: 'POST', headers: { 'x-tag': tag, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) }).then((r) => r.json())));
    expect(results).toHaveLength(2);
    expect(captures).toHaveLength(2);
    expect(captures.map((c) => c.tokIn).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([100, 200]);
    await proxy.close();
  });
});
