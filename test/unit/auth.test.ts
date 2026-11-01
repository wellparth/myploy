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

  it('cleans up temp directory', () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
