import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'ssh2';
import { expandTilde } from '../core/config.js';
import { escapeShellArg } from '../utils/security.js';

const execFileAsync = promisify(execFile);

export interface SSHKeyInfo {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyContent: string;
  isNew: boolean;
}

export function getDefaultSSHKeyPaths(): { privateKey: string; publicKey: string } {
  const sshDir = path.join(os.homedir(), '.ssh');
  const ed25519 = path.join(sshDir, 'id_ed25519');
  const myployEd25519 = path.join(sshDir, 'myploy_ed25519');
  const rsa = path.join(sshDir, 'id_rsa');

  if (fs.existsSync(ed25519)) {
    return { privateKey: ed25519, publicKey: `${ed25519}.pub` };
  }
  if (fs.existsSync(myployEd25519)) {
    return { privateKey: myployEd25519, publicKey: `${myployEd25519}.pub` };
  }
  if (fs.existsSync(rsa)) {
    return { privateKey: rsa, publicKey: `${rsa}.pub` };
  }

  // Default target for new key
  return { privateKey: myployEd25519, publicKey: `${myployEd25519}.pub` };
}

export async function ensureSSHKeyPair(customPath?: string): Promise<SSHKeyInfo> {
  const targetPrivate = customPath ? expandTilde(customPath) : getDefaultSSHKeyPaths().privateKey;
  const targetPublic = `${targetPrivate}.pub`;

  const sshDir = path.dirname(targetPrivate);
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  // Key already exists
  if (fs.existsSync(targetPrivate)) {
    let publicKeyContent = '';
    if (fs.existsSync(targetPublic)) {
      publicKeyContent = fs.readFileSync(targetPublic, 'utf-8').trim();
    }
    return {
      privateKeyPath: targetPrivate,
      publicKeyPath: targetPublic,
      publicKeyContent,
      isNew: false
    };
  }

  // Generate new high-security Ed25519 keypair
  try {
    await execFileAsync('ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '', // empty passphrase
      '-f',
      targetPrivate,
      '-C',
      'myploy@vps-deploy-key'
    ]);
  } catch (err: any) {
    throw new Error(`Failed to generate SSH key with ssh-keygen: ${err.message}`);
  }

  const publicKeyContent = fs.existsSync(targetPublic)
    ? fs.readFileSync(targetPublic, 'utf-8').trim()
    : '';

  return {
    privateKeyPath: targetPrivate,
    publicKeyPath: targetPublic,
    publicKeyContent,
    isNew: true
  };
}

export async function authorizeKeyOnVPS(params: {
  host: string;
  user: string;
  password?: string;
  port?: number;
  publicKey: string;
}): Promise<void> {
  if (!params.password) {
    throw new Error('VPS password is required to authorize the SSH key for the first time.');
  }

  const client = new Client();
  const port = params.port || 22;

  return new Promise((resolve, reject) => {
    client
      .on('ready', () => {
        // Safe idempotent append to authorized_keys with strict permissions
        const cleanKey = params.publicKey.trim();
        const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qxF ${escapeShellArg(cleanKey)} ~/.ssh/authorized_keys 2>/dev/null || echo ${escapeShellArg(cleanKey)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

        client.exec(cmd, (err, stream) => {
          if (err) {
            client.end();
            return reject(err);
          }

          let stderr = '';
          stream
            .on('close', (code: number) => {
              client.end();
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`Failed to write authorized_keys on VPS (code ${code}): ${stderr}`));
              }
            })
            .stderr.on('data', (d: Buffer) => {
              stderr += d.toString('utf-8');
            });
        });
      })
      .on('error', (err) => {
        reject(new Error(`Failed to connect with password to ${params.user}@${params.host}:${port}: ${err.message}`));
      })
      .connect({
        host: params.host,
        port,
        username: params.user,
        password: params.password,
        readyTimeout: 15000
      });
  });
}
