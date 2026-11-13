import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionCookie } from '../src/services/account.js';

describe('session cookie when sharing a laptop copy', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is Secure in production or when COOKIE_SECURE=true, and httpOnly with SameSite=Lax always', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(sessionCookie()).toEqual({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(sessionCookie().secure).toBe(true);
    vi.stubEnv('COOKIE_SECURE', ''); vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookie().secure).toBe(true);
  });
});
