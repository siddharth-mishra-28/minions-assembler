import { describe, it, expect } from 'vitest';
import { agentColor, normalizeHex, USER_COLOR, IDENTITY_PALETTE, textColorOn, luminance } from '../src/core/agent-colors.js';

describe('agent identity colors', () => {
  it('explicit metadata.color wins', () => {
    expect(agentColor({ metadata: { name: 'x', version: '1.0.0', color: '#ff00ff' } })).toBe('#ff00ff');
  });

  it('derives a deterministic palette color when no color set — stable across calls', () => {
    const a = agentColor({ metadata: { name: 'fullstack-tester', version: '1.0.0' } });
    const b = agentColor({ metadata: { name: 'fullstack-tester', version: '1.0.0' } });
    expect(a).toBe(b);
    expect(IDENTITY_PALETTE).toContain(a);
  });

  it('different agents get distinct colors across an 8-agent roster (with high probability)', () => {
    const names = ['fullstack-product-owner', 'fullstack-architect', 'fullstack-implementor', 'day-planner-implementor', 'fullstack-tester', 'fullstack-fe-polisher', 'fullstack-uat-reviewer', 'fullstack-tech-lead'].map((n) => agentColor(`${n}@1.0.0`));
    expect(new Set(names).size).toBeGreaterThanOrEqual(5);
  });

  it('string id form works as well', () => {
    expect(agentColor('pure-default-prompt@1.0.0')).toBe(agentColor('pure-default-prompt@1.0.0'));
    expect(IDENTITY_PALETTE).toContain(agentColor('pure-default-prompt@1.0.0'));
  });

  it('normalizeHex accepts 6-digit hex only', () => {
    expect(normalizeHex('#FFAA00')).toBe('#ffaa00');
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#fff')).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });

  it('user color is the fixed indigo and never derived', () => {
    expect(USER_COLOR).toBe('#6d5cff');
  });

  it('text stays readable on both light and dark identities', () => {
    expect(textColorOn('#ffffff')).toBe('#14171f'); // light bg → dark text
    expect(textColorOn('#111111')).toBe('#f5f6f8'); // dark bg → light text
  });

  it('luminance ordering sanity', () => {
    expect(luminance('#ffffff')).toBeGreaterThan(luminance('#000000'));
  });
});
