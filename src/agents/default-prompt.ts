import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { CopilotClient, SYSTEM_MESSAGE_SECTIONS } from '@github/copilot-sdk';

/**
 * Default-system-prompt introspection for the Persona wizard.
 *
 * The Copilot CLI composes its default system prompt (preamble, identity, tone,
 * tool_instructions, safety, …) inside the native runtime — there is no SDK API
 * to read that text back. To SHOW it (the "customize" Persona mode needs a
 * visible editing base), we capture it from the wire: a probe session is pointed
 * at a loopback stub provider (same pattern as execution/usage-proxy.ts), the
 * runtime sends its fully-composed first request there, and we extract the
 * system/developer messages. No real API key is used and no traffic leaves the
 * machine.
 */

/** Section catalog straight from the installed SDK — never out of sync with it. */
export const SECTION_CATALOG: Record<string, { description: string }> = SYSTEM_MESSAGE_SECTIONS;

export interface DefaultPromptCapture {
  ok: boolean;
  /** The composed default system prompt exactly as the runtime would send it. */
  text?: string;
  chars?: number;
  model?: string;
  capturedAt?: string;
  workdir?: string;
  /** Set when capture failed — `sections` is still usable as the prompt anatomy. */
  error?: string;
  note: string;
}

const PROBE_MODEL = 'default-prompt-probe';
const DEFAULT_CAPTURE_TIMEOUT_MS = 90_000;
const SEND_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 5 * 60_000;

// Capture spawns the native runtime — cache per workdir so repeated button
// clicks in the wizard are instant after the first capture.
const cache = new Map<string, { at: number; capture: DefaultPromptCapture }>();

export function clearDefaultPromptCache(): void {
  cache.clear();
}

interface StubProvider {
  url: string;
  getSystemText(): string | null;
  close(): Promise<void>;
}

/** Minimal OpenAI-compatible endpoint that records the composed system prompt. */
async function startStubProvider(): Promise<StubProvider> {
  let systemText: string | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = (req.url ?? '').toLowerCase();
      // Model listings the runtime may probe.
      if (req.method === 'GET' || url.includes('models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: PROBE_MODEL, object: 'model', owned_by: 'probe' }] }));
        return;
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch { /* non-JSON body */ }

      if (parsed && systemText === null) {
        const extracted = extractSystemText(parsed);
        if (extracted) systemText = extracted;
      }

      const stream = !!(parsed && parsed.stream === true);
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
      if (stream) {
        const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(chunk({ id: 'probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: PROBE_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }));
        res.write(chunk({ id: 'probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: PROBE_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.end(JSON.stringify({
        id: 'probe',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: PROBE_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    getSystemText: () => systemText,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Pull system/developer messages out of an OpenAI-style request body. */
function extractSystemText(body: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : '')).join('');
    }
    return '';
  };
  // Some wire shapes carry a top-level system field.
  if (typeof body.system === 'string' && body.system) parts.push(body.system);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    const content = textOf(m?.content);
    if (!content) continue;
    if (m?.role === 'system' || m?.role === 'developer') parts.push(content);
  }
  // Last resort: a single leading message without a role carrying the prompt.
  if (!parts.length && messages.length === 1) {
    const content = textOf((messages[0] as { content?: unknown })?.content);
    if (content) parts.push(content);
  }
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Capture the default Copilot CLI system prompt for this machine.
 *
 * Creates a throwaway session with NO `persona.systemMessage` against the stub
 * provider and reads back what the runtime composed. Purely local: the probe
 * key is fake and the only traffic is loopback.
 */
export async function captureDefaultSystemMessage(opts?: { workdir?: string; timeoutMs?: number }): Promise<DefaultPromptCapture> {
  const workdir = resolvePath(opts?.workdir || process.cwd());
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const note = 'Captured live from the bundled Copilot CLI: this is the exact default system prompt a session without persona.systemMessage receives on this machine. Content varies slightly with tools/MCP/skills config and environment (cwd, OS, git root).';

  const cached = cache.get(workdir);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.capture;

  let stub: StubProvider | null = null;
  let client: InstanceType<typeof CopilotClient> | null = null;
  try {
    stub = await startStubProvider();
    client = new CopilotClient({
      onListModels: () => [{ id: PROBE_MODEL, name: PROBE_MODEL, capabilities: { supports: { vision: false, reasoningEffort: false } }, limits: { max_context_window_tokens: 128000 } }] as never,
    });
    await client.start();
    const session = await client.createSession({
      model: PROBE_MODEL,
      provider: { type: 'openai', baseUrl: `${stub.url}/v1`, apiKey: 'probe-key-not-used', wireApi: 'completions' },
      streaming: false,
      workingDirectory: workdir,
    } as never);
    try {
      await (session as { sendAndWait: (a: unknown, t?: number) => Promise<unknown> }).sendAndWait({ prompt: 'Reply with the single word OK.' }, Math.min(SEND_TIMEOUT_MS, timeoutMs));
    } finally {
      try { await (session as { disconnect?: () => Promise<void> }).disconnect?.(); } catch { /* noop */ }
    }
    const text = stub.getSystemText();
    if (!text) {
      return finish(workdir, {
        ok: false,
        workdir,
        error: 'The probe session ran but the runtime never sent a model request we could intercept.',
        note,
      });
    }
    return finish(workdir, {
      ok: true,
      text,
      chars: text.length,
      model: PROBE_MODEL,
      capturedAt: new Date().toISOString(),
      workdir,
      note,
    });
  } catch (e) {
    return finish(workdir, {
      ok: false,
      workdir,
      error: (e as Error).message,
      note,
    });
  } finally {
    if (client) {
      try { await client.stop(); } catch { /* noop */ }
    }
    if (stub) await stub.close();
  }

  function finish(dir: string, capture: DefaultPromptCapture): DefaultPromptCapture {
    cache.set(dir, { at: Date.now(), capture });
    return capture;
  }
}
