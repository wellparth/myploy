import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AuthState {
  isConfigured: boolean;
  passwordHash?: string;
  salt?: string;
}

export class AuthManager {
  private authFilePath: string;
  private activeSessions: Map<string, { createdAt: number }> = new Map();
  private failedAttempts: Map<string, { count: number; lastAttempt: number }> = new Map();

  constructor(customStoragePath?: string) {
    const dir = customStoragePath || path.join(os.homedir(), '.myploy');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.authFilePath = path.join(dir, 'auth.json');
  }

  getAuthState(): AuthState {
    if (!fs.existsSync(this.authFilePath)) {
      return { isConfigured: false };
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.authFilePath, 'utf-8'));
      return {
        isConfigured: Boolean(data.passwordHash && data.salt),
        passwordHash: data.passwordHash,
        salt: data.salt
      };
    } catch {
      return { isConfigured: false };
    }
  }

  setupAdminPassword(password: string): void {
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters long for security.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');

    fs.writeFileSync(
      this.authFilePath,
      JSON.stringify({ passwordHash: hash, salt, updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 }
    );
  }

  verifyPassword(password: string, ip = 'unknown'): boolean {
    // Brute-force protection: rate-limit failed attempts
    const now = Date.now();

    // Prune stale failed attempts if map grows large to prevent memory exhaustion DoS
    if (this.failedAttempts.size > 500) {
      for (const [key, val] of this.failedAttempts.entries()) {
        if (now - val.lastAttempt > 600000) {
          this.failedAttempts.delete(key);
        }
      }
      if (this.failedAttempts.size > 1000) {
        this.failedAttempts.clear();
      }
    }

    const attempts = this.failedAttempts.get(ip);
    if (attempts && attempts.count >= 5 && now - attempts.lastAttempt < 300000) {
      throw new Error('Too many failed login attempts. Please wait 5 minutes before trying again.');
    }

    const state = this.getAuthState();
    if (!state.isConfigured || !state.passwordHash || !state.salt || !password) {
      return false;
    }

    const hash = crypto.scryptSync(password, state.salt, 64).toString('hex');
    const hashBuf = Buffer.from(hash, 'utf-8');
    const targetBuf = Buffer.from(state.passwordHash, 'utf-8');

    // crypto.timingSafeEqual throws RangeError if buffer lengths differ
    if (hashBuf.length !== targetBuf.length) {
      const current = this.failedAttempts.get(ip) || { count: 0, lastAttempt: now };
      this.failedAttempts.set(ip, { count: current.count + 1, lastAttempt: now });
      return false;
    }

    const valid = crypto.timingSafeEqual(hashBuf, targetBuf);

    if (!valid) {
      const current = this.failedAttempts.get(ip) || { count: 0, lastAttempt: now };
      this.failedAttempts.set(ip, { count: current.count + 1, lastAttempt: now });
      return false;
    }

    // Reset on success
    this.failedAttempts.delete(ip);
    return true;
  }

  createSession(): string {
    // Prune expired sessions if session map grows
    if (this.activeSessions.size > 500) {
      const now = Date.now();
      for (const [tok, session] of this.activeSessions.entries()) {
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
          this.activeSessions.delete(tok);
        }
      }
      if (this.activeSessions.size > 1000) {
        const keys = Array.from(this.activeSessions.keys());
        for (let i = 0; i < keys.length - 500; i++) {
          this.activeSessions.delete(keys[i]);
        }
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    this.activeSessions.set(token, { createdAt: Date.now() });
    return token;
  }

  validateSession(token?: string): boolean {
    if (!token) return false;
    const session = this.activeSessions.get(token);
    if (!session) return false;

    // Session valid for 7 days
    const isExpired = Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000;
    if (isExpired) {
      this.activeSessions.delete(token);
      return false;
    }
    return true;
  }

  revokeSession(token: string): void {
    this.activeSessions.delete(token);
  }
}
