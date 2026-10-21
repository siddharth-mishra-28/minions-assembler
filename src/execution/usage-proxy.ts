import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Wire-level token-usage capture.
 *
 * The Copilot runtime masks per-call token usage for BYOK providers ('***' in
 * assistant.usage events) while we ourselves run an OpenAI-compatible endpoint
 * that reports exact usage. This one-shot local proxy fronts the real provider
 * endpoint for a single run:
 *   - forwards every request verbatim to `upstream`
 *   - for streaming bodies, rewrites `body.stream_options.include_usage = true`
 *     so the final SSE chunk carries usage
 *   - parses exact tokens from each completion's response and reports them via
 *     `onUsage` (per API call, i.e. per model round-trip)
 *   - never logs or stores the Authorization header
 */

export interface UsageCapture {
  /** Names avoid the substring "token" — the audit layer scrubs any key matching /token/i. */
  tokIn?: number;
  tokOut?: number;
  tokTotal?: number;
  tokReasoning?: number;
  tokCached?: number;
  model?: string;
  requestId?: string;
  /** ISO timestamp of when the upstream response completed. */
  at: string;
}

export interface UsageProxy {
  /** e.g. http://127.0.0.1:54321 — use as the session provider baseUrl. */
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export async function createUsageProxy(opts: { upstream: string; onUsage: (u: UsageCapture) => void }): Promise<UsageProxy> {
  const upstream = opts.upstream.replace(/\/+$/, '');
  const server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) { tooBig = true; break; }
      chunks.push(c as Buffer);
    }
    if (tooBig) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request body too large for usage proxy' } }));
      return;
    }
    const bodyBuf = Buffer.concat(chunks);
    const started = Date.now();

    try {
      const url = `${upstream}${req.url ?? ''}`;
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!v) continue;
        const key = k.toLowerCase();
        if (key === 'host' || key === 'connection' || key === 'content-length') continue;
        // upstream must not gzip: we need to read JSON/SSE bodies to capture usage
        if (key === 'accept-encoding') { headers[k] = 'identity'; continue; }
        headers[k] = v;
      }
      headers['accept-encoding'] = 'identity';
      if (bodyBuf.length) headers['content-length'] = String(bodyBuf.length);

      let outBody = bodyBuf;
      if (bodyBuf.length) {
        try {
          const parsed = JSON.parse(bodyBuf.toString('utf8')) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && parsed.stream === true) {
            parsed.stream_options = { ...(typeof parsed.stream_options === 'object' && parsed.stream_options ? parsed.stream_options : {}), include_usage: true };
            outBody = Buffer.from(JSON.stringify(parsed), 'utf8');
            headers['content-length'] = String(outBody.length);
          }
        } catch { /* non-JSON body — forward untouched */ }
      }

      const send = url.startsWith('https:') ? httpsRequest : httpRequest;
      const upstreamReq = send(url, { method: req.method, headers }, (upRes) => {
        const contentType = String(upRes.headers['content-type'] ?? '');
        const isSse = contentType.includes('text/event-stream');
        const capture: { usage?: Record<string, unknown>; model?: string; requestId?: string } = {};

        const respond = (out: Buffer | import('node:http').IncomingMessage) => {
          const headersOut: Record<string, string | number | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            if (k === 'content-length' || k === 'transfer-encoding') continue;
            headersOut[k] = Array.isArray(v) ? (v as string[]) : String(v);
          }
          if (isSse) headersOut['transfer-encoding'] = 'chunked';
          res.writeHead(upRes.statusCode ?? 502, headersOut);
          if (Buffer.isBuffer(out)) { res.end(out); return; }
          out.pipe(res);
        };

        if (isSse) {
          // Tee the stream while parsing complete SSE lines for a usage chunk.
          let lineBuf = '';
          upRes.setEncoding('utf8');
          upRes.on('data', (d: string) => {
            lineBuf += d;
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop() ?? '';
            for (const line of lines) parseSseLine(line, capture);
          });
          upRes.on('end', () => {
            parseSseLine(lineBuf, capture);
            report(capture, opts, started, new URL(url));
          });
          respond(upRes);
        } else {
          const parts: Buffer[] = [];
          upRes.on('data', (d) => parts.push(d as Buffer));
          upRes.on('end', () => {
            const full = Buffer.concat(parts);
            try {
              const j = JSON.parse(full.toString('utf8')) as Record<string, unknown>;
              if (j && typeof j === 'object') {
                if (j.usage && typeof j.usage === 'object') capture.usage = j.usage as Record<string, unknown>;
                if (typeof j.model === 'string') capture.model = j.model;
                if (typeof j.id === 'string') capture.requestId = j.id;
              }
            } catch { /* non-JSON response — nothing to capture */ }
            report(capture, opts, started, new URL(url));
            respond(full);
          });
        }
      });
      upstreamReq.on('error', (err) => {
        if (res.headersSent) { res.end(); return; }
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `usage proxy upstream error: ${err.message}` } }));
      });
      if (outBody.length) upstreamReq.end(outBody);
      else upstreamReq.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `usage proxy error: ${message}` } }));
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function parseSseLine(line: string, capture: { usage?: Record<string, unknown>; model?: string; requestId?: string }): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    const j = JSON.parse(payload) as Record<string, unknown>;
    if (j.usage && typeof j.usage === 'object') capture.usage = j.usage as Record<string, unknown>;
    if (typeof j.model === 'string') capture.model = j.model;
    if (typeof j.id === 'string' && !capture.requestId) capture.requestId = j.id;
  } catch { /* ignore malformed lines */ }
}

function report(
  capture: { usage?: Record<string, unknown>; model?: string; requestId?: string },
  opts: { onUsage: (u: UsageCapture) => void },
  started: number,
  url: URL,
): void {
  const u = capture.usage;
  if (!u || typeof u !== 'object') return;
  opts.onUsage({
    tokIn: num(u.prompt_tokens),
    tokOut: num(u.completion_tokens),
    tokTotal: num(u.total_tokens),
    tokReasoning: num(det(u, 'completion_tokens_details', 'reasoning_tokens')),
    tokCached: num(det(u, 'prompt_tokens_details', 'cached_tokens')),
    model: (typeof u.model === 'string' ? u.model : capture.model) ?? undefined,
    requestId: (typeof u.request_id === 'string' ? u.request_id : capture.requestId) ?? undefined,
    at: new Date().toISOString(),
  });
  void url;
  void started;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function det(u: Record<string, unknown>, key: string, field: string): unknown {
  const d = u[key];
  return d && typeof d === 'object' ? (d as Record<string, unknown>)[field] : undefined;
}
