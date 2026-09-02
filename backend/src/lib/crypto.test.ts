import { describe, expect, it } from 'vitest';
import { encryptSecret, decryptSecret, sha256 } from './crypto.js';

describe('crypto', () => {
  it('round-trips secrets', () => {
    process.env.TOKEN_ENCRYPTION_KEY =
      process.env.TOKEN_ENCRYPTION_KEY ||
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const encrypted = encryptSecret('refresh-token-value');
    expect(encrypted.split('.')).toHaveLength(3);
    expect(decryptSecret(encrypted)).toBe('refresh-token-value');
  });

  it('hashes consistently', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abcd'));
  });
});
