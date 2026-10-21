import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Point the master-key path at a temp dir before importing the module under test.
const tempDir = mkdtempSync(join(tmpdir(), 'minions-crypto-'));
process.env.MINIONS_DATA_DIR = tempDir;

const { encryptSecret, decryptSecret, masterKey } = await import('../src/core/crypto.js');

describe('secret encryption', () => {
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('round-trips a secret through AES-256-GCM', () => {
    const secret = 'sk-' + randomBytes(24).toString('hex');
    const enc = encryptSecret(secret);
    expect(enc.ciphertext).not.toContain(secret);
    expect(enc.iv).toBeTruthy();
    expect(enc.tag).toBeTruthy();
    expect(decryptSecret(enc)).toBe(secret);
  });

  it('produces different ciphertext for the same secret (fresh IV each time)', () => {
    const secret = 'same-secret-value';
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptSecret('original-value');
    const tampered = { ...enc, ciphertext: Buffer.from('tampered!!').toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('generates and reuses a stable master key', () => {
    const k1 = masterKey();
    const k2 = masterKey();
    expect(k1.equals(k2)).toBe(true);
    expect(k1.length).toBe(32);
  });
});
