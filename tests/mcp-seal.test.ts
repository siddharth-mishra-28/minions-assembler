import { describe, it, expect } from 'vitest';
import { sealMcpSecrets, resolveMcpProbeAuth } from '../src/mcp/mcp.js';

describe('sealMcpSecrets', () => {
  it('seals secret-like env values and literal Authorization, round-trips, leaves refs and plain values', () => {
    const sealed = sealMcpSecrets({
      env: { API_KEY: 'plain-secret', MODE: 'fast', TOKEN: '${GH_TOKEN}' },
      headers: { Authorization: 'Bearer abc123' },
    });
    expect(sealed.env!.API_KEY).toMatch(/^enc:v1:/);
    expect(sealed.env!.MODE).toBe('fast');
    expect(sealed.env!.TOKEN).toBe('${GH_TOKEN}');
    expect(sealed.headers!.Authorization).toMatch(/^Bearer enc:v1:/);
    expect(JSON.stringify(sealed)).not.toContain('plain-secret');
    expect(JSON.stringify(sealed)).not.toContain('abc123');
    expect(sealMcpSecrets(sealed)).toEqual(sealed);
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'gh-secret';
    try {
      const resolved = resolveMcpProbeAuth(sealed);
      expect(resolved.env!.API_KEY).toBe('plain-secret');
      expect(resolved.env!.TOKEN).toBe('gh-secret');
      expect(resolved.headers!.Authorization).toContain('abc123');
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});