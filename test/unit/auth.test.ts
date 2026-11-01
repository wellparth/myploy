import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { AuthManager } from '../../src/server/auth.js';

describe('AuthManager & Security', () => {
  const tempDir = path.join(os.tmpdir(), `myploy_auth_test_${Date.now()}`);

  it('reports unconfigured state initially', () => {
    const auth = new AuthManager(tempDir);
    expect(auth.getAuthState().isConfigured).toBe(false);
  });

  it('rejects passwords shorter than 8 characters', () => {
    const auth = new AuthManager(tempDir);
    expect(() => auth.setupAdminPassword('short')).toThrow('at least 8 characters');
  });

  it('configures admin password and verifies correctly', () => {
    const auth = new AuthManager(tempDir);
    auth.setupAdminPassword('SuperSecret123!');

    expect(auth.getAuthState().isConfigured).toBe(true);
    expect(auth.verifyPassword('SuperSecret123!')).toBe(true);
    expect(auth.verifyPassword('WrongPassword')).toBe(false);
  });

  it('creates and validates session tokens', () => {
    const auth = new AuthManager(tempDir);
    const token = auth.createSession();

    expect(auth.validateSession(token)).toBe(true);
    expect(auth.validateSession('invalid-token')).toBe(false);

    auth.revokeSession(token);
    expect(auth.validateSession(token)).toBe(false);
  });

  it('handles empty password and enforces brute-force rate limiting', () => {
    const auth = new AuthManager(tempDir);
    auth.setupAdminPassword('SuperSecret123!');

    expect(auth.verifyPassword('', '127.0.0.1')).toBe(false);

    // Fail 5 times from same IP
    for (let i = 0; i < 5; i++) {
      expect(auth.verifyPassword('WrongAttempt', '192.168.1.100')).toBe(false);
    }

    // 6th attempt from the same IP must trigger rate limit
    expect(() => auth.verifyPassword('WrongAttempt', '192.168.1.100')).toThrow(
      'Too many failed login attempts'
    );

    // Different IP is not blocked
    expect(auth.verifyPassword('SuperSecret123!', '192.168.1.101')).toBe(true);
  });

  it('safely handles hash buffer length mismatch without throwing RangeError', () => {
    const auth = new AuthManager(tempDir);
    const authFile = path.join(tempDir, 'auth.json');
    // Overwrite auth.json with an invalid hash length (e.g. truncated)
    fs.writeFileSync(
      authFile,
      JSON.stringify({ passwordHash: 'short_corrupted_hash', salt: 'abcdef1234567890' })
    );

    // Must return false cleanly rather than throwing RangeError from timingSafeEqual
    expect(auth.verifyPassword('AnyPasswordHere')).toBe(false);
  });

  it('cleans up temp directory', () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
