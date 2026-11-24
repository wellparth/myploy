import { describe, it, expect } from 'vitest';
import {
  analyzeLogsWithHeuristics,
  diagnoseContainerFailure
} from '../../src/core/diagnostics.js';

describe('Post-Mortem Failure Diagnostics Engine', () => {
  it('diagnoses Out-Of-Memory (Exit 137) container kills', () => {
    const logs = 'Process received signal\nKilled\n';
    const report = analyzeLogsWithHeuristics(logs, 137);

    expect(report.category).toBe('OUT_OF_MEMORY');
    expect(report.confidence).toBe('high');
    expect(report.suggestedFix).toContain('swap');
  });

  it('diagnoses localhost database connection misconfiguration', () => {
    const logs = `
      [Nest] 1  - ERROR [TypeOrmModule] Unable to connect to the database.
      Error: connect ECONNREFUSED 127.0.0.1:5432
          at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('DATABASE_CONNECTION');
    expect(report.title).toContain('Localhost Misconfiguration');
    expect(report.rootCause).toContain('localhost / 127.0.0.1 inside the container');
    expect(report.suggestedFix).toContain('DATABASE_URL');
  });

  it('diagnoses database authentication failures', () => {
    const logs = `
      FATAL: password authentication failed for user "postgres"
      Connection to database failed.
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('DATABASE_CONNECTION');
    expect(report.title).toBe('Database Authentication Failed');
    expect(report.suggestedFix).toContain('password');
  });

  it('diagnoses missing environment variables (Prisma / Key errors)', () => {
    const logs = `
      PrismaClientInitializationError: Environment variable not found: DATABASE_URL.
        at PrismaClient.init (client.js:42:10)
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('MISSING_ENV');
    expect(report.rootCause).toContain('DATABASE_URL');
    expect(report.suggestedFix).toContain('.env');
  });

  it('diagnoses port collisions (EADDRINUSE)', () => {
    const logs = `
      Error: listen EADDRINUSE: address already in use :::3000
          at Server.setupListenHandle [as _listen2] (node:net:1904:16)
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('PORT_IN_USE');
    expect(report.rootCause).toContain('already occupied');
    expect(report.suggestedFix).toContain('appPort');
  });

  it('diagnoses missing application dependencies', () => {
    const logs = `
      node:internal/modules/cjs/loader:1252
        throw err;
        ^
      Error: Cannot find module 'bcrypt'
      Require stack:
      - /app/dist/auth.js
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('MISSING_DEPENDENCY');
    expect(report.rootCause).toContain('bcrypt');
    expect(report.suggestedFix).toContain('package.json');
  });

  it('diagnoses runtime syntax errors', () => {
    const logs = `
      SyntaxError: Unexpected token '?' in JSON at position 4
          at JSON.parse (<anonymous>)
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('SYNTAX_ERROR');
    expect(report.confidence).toBe('medium');
  });

  it('falls back to UNKNOWN with helpful troubleshooting when no error pattern matches', () => {
    const logs = `
      App listening on port 8080.
      Server initialized successfully.
    `;
    const report = analyzeLogsWithHeuristics(logs);

    expect(report.category).toBe('UNKNOWN');
    expect(report.confidence).toBe('low');
    expect(report.suggestedFix).toContain('/health');
  });

  it('main entrypoint diagnoseContainerFailure returns valid report without API key', async () => {
    const logs = 'connect ECONNREFUSED localhost:5432';
    const report = await diagnoseContainerFailure(logs);

    expect(report.category).toBe('DATABASE_CONNECTION');
    expect(report.diagnosedBy).toBe('heuristic-rules');
  });
});
