import { describe, it, expect } from 'vitest';
import {
  escapeShellArg,
  sanitizeDomain,
  sanitizeAppName,
  sanitizePath,
  sanitizeInteger
} from '../../src/utils/security.js';

describe('Security Utilities', () => {
  describe('escapeShellArg', () => {
    it('wraps argument in single quotes', () => {
      expect(escapeShellArg('hello')).toBe("'hello'");
      expect(escapeShellArg('hello world')).toBe("'hello world'");
    });

    it('escapes internal single quotes safely', () => {
      expect(escapeShellArg("don't stop")).toBe("'don'\\''t stop'");
      expect(escapeShellArg("'; rm -rf /; echo '")).toBe("''\\''; rm -rf /; echo '\\'''");
    });
  });

  describe('sanitizeDomain', () => {
    it('accepts valid FQDNs and localhost', () => {
      expect(sanitizeDomain('example.com')).toBe('example.com');
      expect(sanitizeDomain('SUB.DOMAIN.EXAMPLE.COM')).toBe('sub.domain.example.com');
      expect(sanitizeDomain('localhost')).toBe('localhost');
    });

    it('rejects shell injection attempts in domains', () => {
      expect(() => sanitizeDomain('example.com; cat /etc/passwd')).toThrow();
      expect(() => sanitizeDomain('example.com\nproxy_pass http://attacker.com')).toThrow();
      expect(() => sanitizeDomain('`whoami`.example.com')).toThrow();
    });
  });

  describe('sanitizeAppName', () => {
    it('cleans app names to valid alphanumeric identifiers', () => {
      expect(sanitizeAppName('My App 1')).toBe('my-app-1');
      expect(sanitizeAppName('---cool-service---')).toBe('cool-service');
    });

    it('rejects malicious app names', () => {
      expect(() => sanitizeAppName('')).toThrow();
      expect(() => sanitizeAppName('   ')).toThrow();
    });
  });

  describe('sanitizePath', () => {
    it('ensures leading slash and strips illegal characters', () => {
      expect(sanitizePath('health')).toBe('/health');
      expect(sanitizePath('/api/v1/health?check=1')).toBe('/api/v1/health?check=1');
      expect(sanitizePath('/health; rm -rf /')).toBe('/healthrm-rf/');
    });
  });

  describe('sanitizeInteger', () => {
    it('parses valid numbers with fallback', () => {
      expect(sanitizeInteger('3000', 80)).toBe(3000);
      expect(sanitizeInteger('invalid', 80)).toBe(80);
      expect(sanitizeInteger(-5, 80)).toBe(80);
    });
  });
});
