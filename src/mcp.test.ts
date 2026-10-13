import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from './mcp.js';
import { validateMcpConfig, expandMcpRefs, toSdkMcpConfig } from './mcp.js';

const reg = (m: object) => m as unknown as McpServerConfig;

describe('mcp', () => {
  it('validates stdio config requires command', async () => {
    await expect(validateMcpConfig({ type: 'local' })).rejects.toThrow(/command/);
    await expect(validateMcpConfig({ type: 'http' })).rejects.toThrow(/url/);
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
  it('expandMcpRefs honors disabled flag', () => {
    const registry = new Map([['echo', reg({ type: 'local', command: 'node', tools: ['*'] })]]);
    const { servers, disabled } = expandMcpRefs(undefined, [{ name: 'echo', disabled: true }], registry, new Map());
    expect(disabled).toEqual(['echo']);
    expect(servers.echo).toBeDefined();
  });
});
