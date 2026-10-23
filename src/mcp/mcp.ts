/** MCP server registry helpers: validation, expandMcpRefs, live tool discovery. */
import { spawn } from 'node:child_process';
import { decryptFromToken, encryptToToken, isEncryptedToken } from '../core/crypto.js';

/** Registry config shape (what users POST). `cwd`/`timeoutMs` are accepted aliases of the SDK's `workingDirectory`/`timeout`. */
export interface McpServerConfig {
  type: 'local' | 'stdio' | 'http' | 'sse';
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; workingDirectory?: string;
  url?: string; headers?: Record<string, string>; tools?: string[] | ['*'];
  timeoutMs?: number; timeout?: number;
  /**
   * Optional explicit auth method: 'none' (no auth), 'headers' (static Authorization
   * header / PAT / Bearer), 'env' (stdio server credentials via the env map), or
   * 'oauth' (browser PKCE flow — POST /api/mcp/oauth/start). Auto-derived from the
   * config shape when omitted.
   */
  authType?: 'none' | 'headers' | 'env' | 'oauth';
}

/** Map registry config -> SDK MCPServerConfig (canonical field names). */
export function toSdkMcpConfig(c: McpServerConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { type: c.type === 'local' ? 'local' : c.type, tools: c.tools ?? ['*'] };
  if (c.type === 'local' || c.type === 'stdio') {
    out.command = c.command;
    if (c.args?.length) out.args = c.args;
    if (c.env) out.env = c.env;
    const wd = c.workingDirectory ?? c.cwd;
    if (wd) out.workingDirectory = wd;
  } else {
    out.url = c.url;
    if (c.headers) out.headers = c.headers;
  }
  const t = c.timeout ?? c.timeoutMs;
  if (t) out.timeout = t;
  return out;
}

export async function validateMcpConfig(input: unknown): Promise<{ config: McpServerConfig }> {
  let cfg = input as McpServerConfig;
  if (!cfg || typeof cfg !== 'object') throw new Error('config must be an object');
  // Accept the ubiquitous wrapper styles (Claude Desktop / Cursor use "mcpServers";
  // VS Code / GitHub-style snippets use "servers"): a single-entry wrapper is
  // unwrapped to the inner server config.
  const maybe = input as { mcpServers?: Record<string, McpServerConfig>; servers?: Record<string, McpServerConfig> };
  const wrapper = maybe.mcpServers ?? maybe.servers;
  if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
    const entries = Object.entries(wrapper);
    if (entries.length === 1) {
      cfg = { ...(entries[0][1] as McpServerConfig) };
    } else if (entries.length > 1) {
      const key = maybe.mcpServers ? 'mcpServers' : 'servers';
      throw new Error(`config has ${entries.length} servers under "${key}" (${entries.map(e => e[0]).join(', ')}) — register them one at a time, using just the server object as the config`);
    } else {
      throw new Error('config: server wrapper is empty');
    }
  }
  // Infer a missing `type` from the shape of the config (most real-world configs omit it):
  // has `command` → local stdio server; otherwise assume a streamable HTTP url.
  if (!cfg.type) {
    cfg = { ...cfg, type: (cfg.command ? 'local' : 'http') as McpServerConfig['type'] };
  } else if (!['local', 'stdio', 'http', 'sse'].includes(cfg.type)) {
    throw new Error(`type must be 'local'|'stdio'|'http'|'sse' (got '${cfg.type}')`);
  }
  // authType: optional + validated; derived from the config shape when omitted.
  if (cfg.authType !== undefined && !['none', 'headers', 'env', 'oauth'].includes(cfg.authType)) {
    throw new Error(`authType must be 'none'|'headers'|'env'|'oauth' (got '${cfg.authType}')`);
  }
  if (cfg.authType === 'headers' && !(cfg.headers?.Authorization || cfg.headers?.authorization)) {
    throw new Error("authType 'headers' requires headers.Authorization (Bearer/PAT — literal, ${ENV_VAR} or enc:v1: sealed)");
  }
  if (cfg.authType === 'env' && !cfg.env) {
    throw new Error("authType 'env' requires an env map (stdio server credentials — values may be ${ENV_VAR} refs or enc:v1: sealed)");
  }
  if (cfg.type === 'local' || cfg.type === 'stdio') {
    if (!cfg.command) throw new Error("local/stdio servers require 'command'");
  } else {
    if (!cfg.url) throw new Error("http/sse servers require 'url'");
    try { new URL(cfg.url); } catch { throw new Error(`url is not a valid URL: ${cfg.url}`); }
  }
  if (cfg.tools) {
    if (!Array.isArray(cfg.tools) || cfg.tools.length === 0) throw new Error('tools must be a non-empty array (e.g. ["*"] or ["tool1"])');
  }
  return { config: cfg };
}

export interface McpTool { name: string; description: string; inputSchema: unknown }

/** Probe timeout default. Generous: `npx -y` may download the package on first use (~30 s+). */
const PROBE_TIMEOUT_MS = 60000;

/** Windows cmd.exe quoting: wrap args containing whitespace/specials in double quotes, escaping embedded quotes. */
function windowsQuote(arg: string): string {
  if (!/[\s"&|^<>]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** One MCP JSON-RPC exchange over a stdio server process (spawn → initialize → tools/list → kill). */
async function discoverStdioTools(cfg: McpServerConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpTool[]> {
  try {
    return await stdioHandshake(cfg, timeoutMs, false);
  } catch (first) {
    // Windows-only resilience: a child can die with 0xC0000142 (3221225794, "DLL initialization
    // routine failed") purely because of the *parent's* console state (desktop-launched detached
    // servers, broken console streams). Retrying once through cmd.exe gives the child a fresh
    // console without changing what the user configured — do not mask non-Windows spawn errors.
    const winish = process.platform === 'win32';
    const prematurish = /exited prematurely|0xC0000142|3221225794|DLL initialization/i.test(String((first as Error)?.message ?? ''));
    if (winish && prematurish && !cfg.cwd) {
      return stdioHandshake(cfg, timeoutMs, true);
    }
    throw first;
  }
}

function stdioHandshake(cfg: McpServerConfig, timeoutMs: number, viaShellFallback: boolean): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    // Windows quirk: npm-installed launchers (npx, npm, pnpm, yarn) are .cmd/.bat shims;
    // Node refuses to spawn those without a shell (EINVAL since the CVE-2024-27980 fix).
    const isWin = process.platform === 'win32';
    const launcherShim = isWin && /^(npx|npm|pnpm|yarn)(\.cmd|\.bat)?$/i.test(cfg.command!.trim());
    const needsShell = launcherShim || viaShellFallback;
    // With shell:true Node concatenates unescaped args (DEP0190) — quote them ourselves.
    const argStr = (cfg.args ?? []).map(windowsQuote).join(' ');
    const spawnCmd = needsShell && argStr ? `${cfg.command!.trim()} ${argStr}` : cfg.command!;
    const child = spawn(spawnCmd, needsShell ? [] : (cfg.args ?? []), {
      cwd: cfg.cwd, env: { ...process.env, ...(cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'],
      ...(needsShell ? { shell: true, windowsHide: true } : {}),
    });
    let buf = '';
    const init = new Map<unknown, unknown>();
    let done = false;
    const to = setTimeout(() => {
      if (!done) { child.kill(); reject(new Error(`timed out after ${timeoutMs}ms waiting for tools/list`)); }
    }, timeoutMs);
    const fail = (stage: string, msg: string) => { if (!done) { done = true; clearTimeout(to); try { child.kill(); } catch { /* already dead */ } reject(new Error(`${stage}: ${msg}`)); } };
    child.on('error', (e) => fail('spawn failed', e.message));
    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s || done) return;
      let msg: { jsonrpc?: string; id?: unknown; error?: unknown; result?: unknown };
      try { msg = JSON.parse(s); } catch { return; } // not JSON (banner/log output) — ignore
      if (msg.error && msg.id === 1) return fail('initialize', JSON.stringify(msg.error));
      if (msg.error && msg.id === 2) return fail('tools/list', JSON.stringify(msg.error));
      if (msg.id === 1) init.set(1, msg.result);
      if (msg.id === 2 && msg.result) {
        const tools: McpTool[] = (msg.result as { tools?: McpTool[] }).tools ?? [];
        done = true; clearTimeout(to); try { child.kill(); } catch { /* already dead */ } resolve(tools);
      }
    };
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      // A chunk can splice one JSON object, several, or half of one — split on newlines
      // but also tolerate LSP-style Content-Length framing used by some SDK servers.
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
      if (buf.trim()) handleLine(buf); // final unterminated line buffered so far
    });
    let stderrTail = '';
    child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-500); /* children often log to stderr; not fatal */ });
    child.on('exit', (code, signal) => {
      // A child that exits before completing the handshake is a spawn/config failure —
      // report it instead of waiting for the timeout.
      if (!done) fail('server exited prematurely', `code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}${stderrTail.trim() ? ` — ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
    });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'minions-assembler', version: '1.0.0' } } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    } catch (e) { fail('handshake write', (e as Error).message); }
  });
}

/** Extract the JSON-RPC payload from a probe response: plain JSON, or SSE (`data: {...}` lines). */
async function parseRpcResponse(res: Response, stage: string): Promise<{ id?: unknown; error?: unknown; result?: unknown }> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { /* fall through to SSE parse */ }
  }
  // SSE framing: one JSON object per `data:` line (possibly multi-line events).
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const msg = JSON.parse(payload) as { id?: unknown; error?: unknown; result?: unknown };
      if (msg.error || msg.result || msg.id !== undefined) return msg; // first complete RPC message wins
    } catch { /* try next data line */ }
  }
  throw new Error(`${stage}: response is neither JSON nor SSE (content-type: ${res.headers.get('content-type') ?? 'unknown'})`);
}

async function discoverHttpTools(cfg: McpServerConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpTool[]> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const hasAuth = Boolean(cfg.headers?.Authorization) || Boolean(cfg.headers?.authorization);
  const authHeaders = cfg.headers ?? {};
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, ...authHeaders };
    const res = await fetch(cfg.url!, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'minions-assembler', version: '1.0.0' } } }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const hint = await describeAuthFailure(res, cfg.url!);
      throw authAware(`initialize failed HTTP ${res.status}${hint ? ` — ${hint.guidance}` : ''}`, hint);
    }
    const init = await parseRpcResponse(res, 'initialize');
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
    const sid = res.headers.get('mcp-session-id');
    const list = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, ...(sid ? { 'mcp-session-id': sid } : {}), ...authHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: ac.signal,
    });
    if (!list.ok) {
      const hint = await describeAuthFailure(list, cfg.url!);
      throw authAware(`tools/list failed HTTP ${list.status}${hint ? ` — ${hint.guidance}` : ''}`, hint);
    }
    const j = await parseRpcResponse(list, 'tools/list');
    if (j.error) throw new Error(`tools/list error: ${JSON.stringify(j.error)}`);
    return ((j.result as { tools?: McpTool[] } | undefined)?.tools) ?? [];
  } finally { clearTimeout(to); }
}

/** MCP protocol revision this probe speaks on streamable-HTTP requests. */
const MCP_PROTOCOL_VERSION = '2025-11-25';

/** Parse a Bearer WWW-Authenticate challenge into its key="value" params. */
function parseBearerChallenge(res: Response): Record<string, string> {
  const h = res.headers.get('www-authenticate');
  if (!h || !/^Bearer/i.test(h)) return {};
  const params: Record<string, string> = {};
  const re = /([a-zA-Z_]+)=("([^"]*)"|[^,\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h))) params[m[1]] = m[3] ?? m[2];
  return params;
}

/** Structured, actionable guidance for a 401/403 from an http/sse MCP server. */
export interface AuthHint {
  status: 401 | 403;
  guidance: string;
  issuer?: string;
  scopes_supported?: string[];
  resource_name?: string;
  resource?: string;
  challenge?: Record<string, string>;
}

async function describeAuthFailure(res: Response, serverUrl: string): Promise<AuthHint | null> {
  if (res.status !== 401 && res.status !== 403) return null;
  const ch = parseBearerChallenge(res);
  let bodyHint = '';
  try {
    const t = (await res.text()).trim();
    if (t) bodyHint = t.slice(0, 140);
  } catch { /* body unreadable */ }
  const is403 = res.status === 403;
  const insufficientScope = ch.error === 'insufficient_scope';
  let guide = is403
    ? (insufficientScope ? `403 insufficient_scope — token accepted but lacks scope${ch.scope ? ` "${ch.scope}"` : ''}. Re-authorize with more scopes.` : '403 — token authenticated but lacks permission. Check scopes/account.')
    : 'Server requires authentication (401).';
  const hint: AuthHint = { status: res.status as 401 | 403, guidance: guide, ...(Object.keys(ch).length ? { challenge: ch } : {}) };
  // Best-effort: name the real authorization server + accepted scopes in the guidance.
  try {
    const { discoverProtectedResourceMetadata } = await import('./oauth.js');
    const prm = await discoverProtectedResourceMetadata(serverUrl, ch.resource_metadata);
    if (prm) {
      if (prm.resource) hint.resource = prm.resource;
      if (prm.resource_name) { hint.resource_name = prm.resource_name; guide = `${prm.resource_name}: ` + guide; }
      const issuer = prm.authorization_servers?.[0];
      if (issuer) reminderGuide(hint, issuer);
      if (prm.scopes_supported?.length) hint.scopes_supported = prm.scopes_supported;
    }
  } catch { /* metadata discovery is best-effort */ }
  if (ch.error_description) guide += ` Server said: ${ch.error_description}.`;
  else if (bodyHint && !/^</.test(bodyHint)) guide += ` Server suggested: ${bodyHint}`;
  hint.guidance = guide;
  return hint;
}

function reminderGuide(hint: AuthHint, issuer: string): void {
  hint.issuer = issuer;
  hint.guidance += ` OAuth authorization server: ${issuer}. Sign in via POST /api/mcp/oauth/start (browser PKCE) or set headers.Authorization to a Bearer token/PAT.`;
}

/** Attach the structured AuthHint to any probe error(*) so routes/UI can render actionable next steps. */
export interface AuthAwareError extends Error { authHint?: AuthHint }

function authAware(msg: string, hint: AuthHint | null): AuthAwareError {
  const e: AuthAwareError = new Error(msg);
  if (hint) e.authHint = hint;
  return e;
}

/** Probe a server and return its tool list (name, description, inputSchema). */
export async function probeMcpTools(input: unknown, timeoutMs?: number): Promise<McpTool[]> {
  const { config } = await validateMcpConfig(input); // shape-check the raw input first
  void config;
  const { config: cfg } = await validateMcpConfig(resolveMcpProbeAuth(input as McpServerConfig));
  const wd = cfg.workingDirectory ?? cfg.cwd;
  const probeCfg: McpServerConfig = { ...cfg, cwd: wd };
  const t = timeoutMs ?? cfg.timeout ?? cfg.timeoutMs ?? PROBE_TIMEOUT_MS;
  return cfg.type === 'local' || cfg.type === 'stdio' ? discoverStdioTools(probeCfg, t) : discoverHttpTools(probeCfg, t);
}

/**
 * Probe/run-time auth resolution for ALL supported auth methods:
 * - http/sse `headers.Authorization`: `enc:v1:` token (stored sealed) or `Bearer ${ENV_VAR}`
 * - stdio `env` values: `enc:v1:` tokens or bare `${ENV_VAR}` references
 * Unseal/expand here so plaintext exists only in memory; config_json keeps the
 * sealed/env-ref form.
 */
export function resolveMcpProbeAuth<T extends { headers?: Record<string, string>; env?: Record<string, string> }>(input: T): T {
  let out = input;
  const authz = out.headers?.Authorization;
  if (authz) {
    let resolved = authz;
    const envRef = authz.match(/^Bearer \$\{([A-Z0-9_]+)\}$/);
    if (envRef) {
      const v = process.env[envRef[1]];
      if (!v) throw new Error(`Environment variable "${envRef[1]}" referenced by MCP config headers.Authorization is not set`);
      resolved = `Bearer ${v}`;
    } else if (isEncryptedToken(authz)) {
      resolved = `Bearer ${decryptFromToken(authz)}`;
    } else if (isEncryptedToken(authz.replace(/^Bearer /, ''))) {
      resolved = `Bearer ${decryptFromToken(authz.replace(/^Bearer /, ''))}`;
    }
    if (resolved !== authz) out = { ...out, headers: { ...out.headers, Authorization: resolved } };
  }
  if (out.env) {
    const env: Record<string, string> = { ...out.env };
    let changed = false;
    for (const [k, v] of Object.entries(env)) {
      const envRef = /^\$\{([A-Z0-9_]+)\}$/.exec(v);
      if (envRef) {
        const val = process.env[envRef[1]];
        if (!val) throw new Error(`Environment variable "${envRef[1]}" referenced by MCP config env.${k} is not set`);
        env[k] = val;
        changed = true;
      } else if (isEncryptedToken(v)) {
        env[k] = decryptFromToken(v);
        changed = true;
      }
    }
    if (changed) out = { ...out, env };
  }
  return out;
}

const SECRET_ENV_KEY = /(key|token|secret|pass(word)?|auth|credential)/i;

/**
 * Seal literal secrets before a registry config is persisted so plaintext never rests in the DB:
 * stdio `env` values with secret-like names and a literal `headers.Authorization`.
 * `${ENV_VAR}` references and already-sealed `enc:v1:` tokens are left untouched.
 */
export function sealMcpSecrets<T extends { headers?: Record<string, string>; env?: Record<string, string> }>(cfg: T): T {
  const keep = (v: string) => !v || /^\$\{[A-Z0-9_]+\}$/.test(v) || isEncryptedToken(v);
  let out = cfg;
  if (out.env) {
    const env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, SECRET_ENV_KEY.test(k) && !keep(v) ? encryptToToken(v) : v]));
    out = { ...out, env };
  }
  const authz = out.headers?.Authorization;
  if (authz) {
    const m = /^(Bearer )?(.*)$/.exec(authz)!;
    if (!keep(m[2])) out = { ...out, headers: { ...out.headers, Authorization: `${m[1] ?? ''}${encryptToToken(m[2])}` } };
  }
  return out;
}

/** Merge agent-definition inline servers with registry references (\`use: ["name", …]\`). */
export function expandMcpRefs(
  defServers: Record<string, McpServerConfig> | undefined,
  refs: unknown,
  registry: Map<string, McpServerConfig>,
  registryTools: Map<string, string[]>,
): { servers: Record<string, McpServerConfig>; disabled: string[] } {
  const servers: Record<string, McpServerConfig> = { ...(defServers ?? {}) };
  const disabled: string[] = [];
  if (registry.size === 0 && !refs) return { servers, disabled };
  for (const raw of Array.isArray(refs) ? refs : []) {
    const ref = typeof raw === 'string' ? { name: raw } : (raw as { name: string; allow?: string[]; deny?: string[]; disabled?: boolean });
    const name = ref?.name;
    if (!name) throw new Error(`Invalid mcp.use entry: ${JSON.stringify(raw)} — expected a name or {name, allow, deny}`);
    const registered = registry.get(name);
    if (!registered) throw new Error(`MCP server '${name}' not found in registry — register it first via POST /api/mcp or 'minions-assembler mcp register' (mcp.use: ["${name}"] cannot be resolved)`);
    const allowed = registryTools.get(name) ?? [];
    let tools: string[] | ['*'] | undefined = registered.tools;
    if ('allow' in (ref as object) || 'deny' in (ref as object)) {
      const base = allowed.length ? allowed : [];
      const allow = (ref as { allow?: string[] }).allow;
      const deny = (ref as { deny?: string[] }).deny ?? [];
      tools = base.filter((t) => (!allow || allow.includes('*') || allow.includes(t)) && !deny.includes(t));
      if (tools.length === 0) throw new Error(`MCP server '${name}' ref leaves 0 tools (allow/deny mismatch with discovered tools: ${allowed.join(', ')})`);
    }
    const cfg: McpServerConfig = { ...registered, tools: tools ?? ['*'] };
    // Resolve sealed/env Authorization headers to plaintext in-memory for SDK consumption at run time
    const sdkReady = resolveMcpProbeAuth(cfg as McpServerConfig & { headers?: Record<string, string> }) as McpServerConfig;
    // normalize for SDK consumption at run time
    const sdkCfg = toSdkMcpConfig(sdkReady) as unknown as McpServerConfig;
    Object.assign(cfg, sdkCfg);
    if ((ref as { disabled?: boolean }).disabled) disabled.push(name);
    servers[name] = cfg;
  }
  return { servers, disabled };
}
