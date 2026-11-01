import { describe, it, expect } from 'vitest';
import { sanitizeContainerIdentifier } from '../../src/server/containers.js';

describe('Container Sanitization & Injection Prevention', () => {
  it('accepts valid alphanumeric, dot, underscore, and hyphen container IDs', () => {
    expect(sanitizeContainerIdentifier('my-app_blue')).toBe('my-app_blue');
    expect(sanitizeContainerIdentifier('db_postgres.1')).toBe('db_postgres.1');
    expect(sanitizeContainerIdentifier('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
  });

  it('rejects option injection attacks starting with dash', () => {
    expect(() => sanitizeContainerIdentifier('-v')).toThrow('cannot start with a dash');
    expect(() => sanitizeContainerIdentifier('--privileged')).toThrow('cannot start with a dash');
    expect(() => sanitizeContainerIdentifier('--time=0')).toThrow('cannot start with a dash');
  });

  it('rejects shell metacharacters and control characters', () => {
    expect(() => sanitizeContainerIdentifier('app; rm -rf /')).toThrow('Invalid container identifier');
    expect(() => sanitizeContainerIdentifier('app$(whoami)')).toThrow('Invalid container identifier');
    expect(() => sanitizeContainerIdentifier('app`id`')).toThrow('Invalid container identifier');
    expect(() => sanitizeContainerIdentifier('app && echo pwned')).toThrow('Invalid container identifier');
  });
});
