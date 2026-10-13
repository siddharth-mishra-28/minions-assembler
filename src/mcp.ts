/** MCP server registry helpers: validation, expandMcpRefs, live tool discovery. */
import { spawn } from 'node:child_process';

/** Registry config shape (what users POST). `cwd`/`timeoutMs` are accepted aliases of the SDK's `workingDirectory`/`timeout`. */
export interface McpServerConfig {
  type: 'local' | 'stdio' | 'http' | 'sse';
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; workingDirectory?: string;
  url?: string; headers?: Record<string, string>; tools?: string[] | ['*'];
  timeoutMs?: number; timeout?: number;
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
  const cfg = input as McpServerConfig;
  if (!cfg || typeof cfg !== 'object') throw new Error('config must be an object');
  if (!['local', 'stdio', 'http', 'sse'].includes(cfg.type)) throw new Error("type must be 'local'|'stdio'|'http'|'sse'");
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

/** One MCP JSON-RPC exchange over a stdio server process (spawn → initialize → tools/list → kill). */
function discoverStdioTools(cfg: McpServerConfig, timeoutMs = 10000): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command!, cfg.args ?? [], {
      cwd: cfg.cwd, env: { ...process.env, ...(cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const to = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${timeoutMs}ms waiting for tools/list`)); }, timeoutMs);
    const fail = (stage: string, msg: string) => { clearTimeout(to); reject(new Error(`${stage}: ${msg}`)); };
    child.on('error', (e) => fail('spawn failed', e.message));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n').filter((l) => l.trim());
      if (lines.length < 2) return; // need initialize response + tools/list response
      try {
        const init = JSON.parse(lines[0]);
        if (init.error) return fail('initialize', JSON.stringify(init.error));
        const list = JSON.parse(lines[1]);
        if (list.error) return fail('tools/list', JSON.stringify(list.error));
        const tools: McpTool[] = list.result?.tools ?? [];
        clearTimeout(to); resolve(tools);
      } catch (e) { fail('parse', (e as Error).message); }
    });
    child.stderr.on('data', () => { /* children often log to stderr; not fatal */ });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'minion-assembler', version: '1.0.0' } } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    } catch (e) { fail('handshake write', (e as Error).message); }
  });
}

async function discoverHttpTools(cfg: McpServerConfig, timeoutMs = 10000): Promise<McpTool[]> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(cfg.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'minion-assembler', version: '1.0.0' } } }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`initialize failed HTTP ${res.status}`);
    const init = await res.json().catch(() => ({}));
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
    const sid = res.headers.get('mcp-session-id');
    const list = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}), ...(cfg.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: ac.signal,
    });
    if (!list.ok) throw new Error(`tools/list failed HTTP ${list.status}`);
    const j = await list.json().catch(() => ({}));
    if (j.error) throw new Error(`tools/list error: ${JSON.stringify(j.error)}`);
    return j.result?.tools ?? [];
  } finally { clearTimeout(to); }
}

/** Probe a server and return its tool list (name, description, inputSchema). */
export async function probeMcpTools(input: unknown, timeoutMs?: number): Promise<McpTool[]> {
  const { config: cfg } = await validateMcpConfig(input);
  const wd = cfg.workingDirectory ?? cfg.cwd;
  const probeCfg: McpServerConfig = { ...cfg, cwd: wd };
  const t = timeoutMs ?? cfg.timeout ?? cfg.timeoutMs ?? 10000;
  return cfg.type === 'local' || cfg.type === 'stdio' ? discoverStdioTools(probeCfg, t) : discoverHttpTools(probeCfg, t);
}

/** Merge agent-definition inline servers with registry references (`use: ["name", …]`). */
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
    if (!registered) throw new Error(`MCP server '${name}' not found in registry — register it first via POST /api/mcp or 'minion-assembler mcp register' (mcp.use: ["${name}"] cannot be resolved)`);
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
    // normalize for SDK consumption at run time
    const sdkCfg = toSdkMcpConfig(cfg) as unknown as McpServerConfig;
    Object.assign(cfg, sdkCfg);
    if ((ref as { disabled?: boolean }).disabled) disabled.push(name);
    servers[name] = cfg;
  }
  return { servers, disabled };
}
