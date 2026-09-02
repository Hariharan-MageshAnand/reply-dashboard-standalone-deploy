import { describe, expect, it } from 'vitest';
import { getSessionToken, setSessionToken, clearSessionToken } from './auth-token';

describe('auth token storage', () => {
  it('stores and clears a session token', () => {
    clearSessionToken();
    expect(getSessionToken()).toBeNull();
    setSessionToken('local.test.token');
    expect(getSessionToken()).toBe('local.test.token');
    clearSessionToken();
    expect(getSessionToken()).toBeNull();
  });
});
