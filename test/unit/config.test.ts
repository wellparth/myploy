import { describe, it, expect } from 'vitest';
import { normalizeConfig } from '../../src/core/config.js';

describe('Config Loader & Normalizer', () => {
  it('throws error when required fields are missing', () => {
    expect(() => normalizeConfig({})).toThrow('app');
    expect(() => normalizeConfig({ app: 'testapp' })).toThrow('domain');
    expect(() => normalizeConfig({ app: 'testapp', domain: 'example.com' })).toThrow('host');
  });

  it('normalizes valid configuration with defaults', () => {
    const config = normalizeConfig({
      app: 'My Super App!',
      domain: 'APP.Example.COM',
      host: ' 1.2.3.4 '
    });

    expect(config.app).toBe('my-super-app-');
    expect(config.domain).toBe('app.example.com');
    expect(config.host).toBe('1.2.3.4');
    expect(config.user).toBe('root');
    expect(config.appPort).toBe(3000);
    expect(config.healthcheck?.path).toBe('/');
    expect(config.healthcheck?.timeoutSeconds).toBe(30);
    expect(config.ssl).toBe(true);
    expect(config.keepPreviousRunning).toBe(true);
  });

  it('preserves custom settings when provided', () => {
    const config = normalizeConfig({
      app: 'api',
      domain: 'api.test.com',
      host: '10.0.0.1',
      user: 'ubuntu',
      appPort: 8080,
      healthcheck: {
        path: '/v1/healthz',
        timeoutSeconds: 60
      },
      ssl: false,
      keepPreviousRunning: false
    });

    expect(config.user).toBe('ubuntu');
    expect(config.appPort).toBe(8080);
    expect(config.healthcheck?.path).toBe('/v1/healthz');
    expect(config.healthcheck?.timeoutSeconds).toBe(60);
    expect(config.ssl).toBe(false);
    expect(config.keepPreviousRunning).toBe(false);
  });
});
