import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '../src/mcp/mcp.js';
import { validateMcpConfig, expandMcpRefs, toSdkMcpConfig, probeMcpTools, resolveMcpProbeAuth } from '../src/mcp/mcp.js';
import { encryptToToken } from '../src/core/crypto.js';
import { fileURLToPath } from 'node:url';

const reg = (m: object) => m as unknown as McpServerConfig;

describe('mcp', () => {
  it('validates stdio config requires command', async () => {
    await expect(validateMcpConfig({ type: 'local' })).rejects.toThrow(/command/);
    await expect(validateMcpConfig({ type: 'http' })).rejects.toThrow(/url/);
  });
  it('accepts Claude-Desktop-style {mcpServers:{name:cfg}} wrapper configs (type inferred)', async () => {
    const { config } = await validateMcpConfig({
      mcpServers: { gitlab: { command: 'npx', args: ['-y', '@yoda.digital/gitlab-mcp-server'], env: { GITLAB_PERSONAL_ACCESS_TOKEN: 'x', GITLAB_API_URL: 'https://gitlab.com/api/v4' } } },
    });
    expect(config.command).toBe('npx');
    expect(config.type).toBe('local');
    const http = await validateMcpConfig({ mcpServers: { wikis: { url: 'https://mcp.example.com/mcp' } } });
    expect(http.config.type).toBe('http');
    await expect(validateMcpConfig({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } })).rejects.toThrow(/one at a time/);
  });
  it('accepts a valid stdio config', async () => {
    const { config } = await validateMcpConfig({ type: 'local', command: 'node', args: ['./x.mjs'] });
    expect(config.command).toBe('node');
  });
  it('toSdkMcpConfig maps cwd->workingDirectory, timeoutMs->timeout, and defaults tools', () => {
    const sdk = toSdkMcpConfig({ type: 'local', command: 'node', cwd: './x', timeoutMs: 5000 } as unknown as Parameters<typeof toSdkMcpConfig>[0]);
    expect(sdk.workingDirectory).toBe('./x');
    expect(sdk.timeout).toBe(5000);
    expect(sdk.command).toBe('node');
    expect(sdk.tools).toEqual(['*']);
    const http = toSdkMcpConfig({ type: 'http', url: 'https://example.com/mcp' } as unknown as Parameters<typeof toSdkMcpConfig>[0]);
    expect(http.url).toBe('https://example.com/mcp');
    expect(http.workingDirectory).toBeUndefined();
  });
  it('expandMcpRefs resolves registered refs and flags missing ones', () => {
    const registry = new Map([['echo', reg({ type: 'local', command: 'node', args: ['--probe'], tools: ['*'] })]]);
    const regTools = new Map([['echo', ['echo']]]);
    const { servers } = expandMcpRefs(undefined, ['echo'], registry, regTools);
    expect(Object.keys(servers)).toEqual(['echo']);
    expect(() => expandMcpRefs(undefined, ['missing'], registry, regTools)).toThrow(/not found in registry/);
  });
  it('expandMcpRefs applies allow filtering and errors when 0 tools remain', () => {
    const registry = new Map([['echo', reg({ type: 'local', command: 'node', tools: ['*'] })]]);
    const regTools = new Map([['echo', ['echo', 'other']]]);
    const { servers } = expandMcpRefs(undefined, [{ name: 'echo', allow: ['echo'] }], registry, regTools);
    expect(servers.echo.tools).toEqual(['echo']);
    expect(() => expandMcpRefs(undefined, [{ name: 'echo', allow: ['nope'] }], registry, regTools)).toThrow(/0 tools/);
  });
  describe('auth matrix (none / headers / env / oauth)', () => {
    it('rejects an unknown authType and enforces the field it implies', async () => {
      await expect(validateMcpConfig({ type: 'http', url: 'https://x/mcp', authType: 'magic' })).rejects.toThrow(/authType/);
      await expect(validateMcpConfig({ type: 'http', url: 'https://x/mcp', authType: 'headers' })).rejects.toThrow(/headers.Authorization/);
      await expect(validateMcpConfig({ type: 'local', command: 'x', authType: 'env' })).rejects.toThrow(/env map/);
    });

    it('accepts every supported authType', async () => {
      expect((await validateMcpConfig({ type: 'http', url: 'https://x/mcp', authType: 'none' })).config.authType).toBe('none');
      expect((await validateMcpConfig({ type: 'http', url: 'https://x/mcp', authType: 'headers', headers: { Authorization: 'Bearer pat' } })).config.authType).toBe('headers');
      expect((await validateMcpConfig({ type: 'local', command: 'x', authType: 'env', env: { TOKEN: 't' } })).config.authType).toBe('env');
      expect((await validateMcpConfig({ type: 'http', url: 'https://x/mcp', authType: 'oauth' })).config.authType).toBe('oauth');
    });

    it('resolves ${ENV_VAR} refs in stdio env values and errors when unset', () => {
      process.env.MCP_TEST_TOKEN = 'secret-123';
      try {
        const out = resolveMcpProbeAuth({ type: 'local', command: 'x', env: { TOKEN: '${MCP_TEST_TOKEN}' } });
        expect(out.env?.TOKEN).toBe('secret-123');
        expect(() => resolveMcpProbeAuth({ type: 'local', command: 'x', env: { T: '${MCP_MISSING_VAR}' } })).toThrow(/MCP_MISSING_VAR/);
      } finally { delete process.env.MCP_TEST_TOKEN; }
    });

    it('unseals enc:v1: tokens in stdio env values (plaintext only in memory)', () => {
      const sealed = encryptToToken('sealed-stdio-secret');
      const out = resolveMcpProbeAuth({ type: 'local', command: 'x', env: { TOKEN: sealed } });
      expect(out.env?.TOKEN).toBe('sealed-stdio-secret');
    });

    it('resolves headers.Authorization from Bearer ${ENV_VAR} and enc:v1: forms', () => {
      process.env.MCP_TEST_AUTH = 'pat-abc';
      try {
        const viaEnv = resolveMcpProbeAuth({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${MCP_TEST_AUTH}' } });
        expect(viaEnv.headers?.Authorization).toBe('Bearer pat-abc');
        const sealed = encryptToToken('pat-sealed');
        const viaSeal = resolveMcpProbeAuth({ type: 'http', url: 'https://x/mcp', headers: { Authorization: `Bearer ${sealed}` } });
        expect(viaSeal.headers?.Authorization).toBe('Bearer pat-sealed');
      } finally { delete process.env.MCP_TEST_AUTH; }
    });
  });

  describe('OAuth PKCE (browser auth flow primitives)', () => {
    it('makePkcePair produces an S256-verifiable verifier/challenge pair', async () => {
      const { createHash } = await import('node:crypto');
      const { makePkcePair } = await import('../src/mcp/oauth.js');
      const { verifier, challenge } = makePkcePair();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      const expected = createHash('sha256').update(verifier).digest('base64url');
      expect(challenge).toBe(expected);
    });

    it('buildAuthorizeUrl carries client id, redirect, state and the S256 challenge', async () => {
      const { buildAuthorizeUrl } = await import('../src/mcp/oauth.js');
      const url = new URL(buildAuthorizeUrl({
        authorizationEndpoint: 'https://as.example/authorize',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:3999/callback',
        resource: 'https://api.example/mcp/',
        scopes: ['repo'],
        state: 'st123',
        codeChallenge: 'ch456',
      }));
      expect(url.origin + url.pathname).toBe('https://as.example/authorize');
      expect(url.searchParams.get('client_id')).toBe('cid');
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3999/callback');
      expect(url.searchParams.get('state')).toBe('st123');
      expect(url.searchParams.get('code_challenge')).toBe('ch456');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toContain('repo');
    });
  });

  it('expandMcpRefs honors disabled flag', () => {
    const registry = new Map([['echo', reg({ type: 'local', command: 'node', tools: ['*'] })]]);
    const { servers, disabled } = expandMcpRefs(undefined, [{ name: 'echo', disabled: true }], registry, new Map());
    expect(disabled).toEqual(['echo']);
    expect(servers.echo).toBeDefined();
  });
  describe('probeMcpTools (live stdio)', () => {
    const echoServer = fileURLToPath(new URL('../scripts/mcp-echo-server.mjs', import.meta.url));
    it('discovers tools from a real stdio MCP server', async () => {
      const tools = await probeMcpTools({ type: 'local', command: 'node', args: [echoServer], tools: ['*'] }, 10000);
      expect(tools.map((t) => t.name)).toContain('echo');
    }, 15000);
    it('fails fast when a non-MCP process exits without a handshake (the old echo template)', async () => {
      // A process that exits before replying to initialize must not burn the full timeout.
      await expect(probeMcpTools({ type: 'local', command: 'node', args: ['-e', "console.log('ok')"], tools: ['*'] }, 10000))
        .rejects.toThrow(/exited prematurely/);
    }, 15000);
    it('errors on a spawn failure (command not found)', async () => {
      await expect(probeMcpTools({ type: 'local', command: 'definitely-not-a-real-command-xyz', tools: ['*'] }, 5000))
        .rejects.toThrow(/spawn failed|ENOENT|timed out/);
    }, 10000);
    it('surfaces a JSON-RPC error from tools/list', async () => {
      // A server that implements initialize but replies with an error to tools/list
      // (simulated via node -e with a two-line responder).
      const script = [
        "const w=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');let b=''",
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf(String.fromCharCode(10)))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===1)w({jsonrpc:'2.0',id:1,result:{}});if(m.id===2)w({jsonrpc:'2.0',id:2,error:{code:-32601,message:'no tools for you'}})}})",
      ].join(';');
      await expect(probeMcpTools({ type: 'local', command: 'node', args: ['-e', script], tools: ['*'] }, 5000))
        .rejects.toThrow(/tools\/list/);
    }, 10000);
  });
});
