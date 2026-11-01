import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { getDefaultSSHKeyPaths, ensureSSHKeyPair } from '../../src/remote/keygen.js';

describe('SSH Key Automation', () => {
  it('identifies standard SSH key paths in home directory', () => {
    const paths = getDefaultSSHKeyPaths();
    expect(paths.privateKey).toContain('.ssh');
    expect(paths.publicKey).toBe(`${paths.privateKey}.pub`);
  });

  it('generates or retrieves a valid SSH keypair', async () => {
    const testKeyPath = path.join(os.tmpdir(), 'myploy_test_key');
    const keyInfo = await ensureSSHKeyPair(testKeyPath);

    expect(keyInfo.privateKeyPath).toBe(testKeyPath);
    expect(keyInfo.publicKeyPath).toBe(`${testKeyPath}.pub`);
    expect(keyInfo.publicKeyContent).toContain('ssh-ed25519');
  });
});
