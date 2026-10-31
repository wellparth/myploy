import { describe, it, expect } from 'vitest';
import { determineNextSlot, generateComposeOverride } from '../../src/core/bluegreen.js';
import yaml from 'yaml';

describe('Blue/Green Orchestration', () => {
  describe('determineNextSlot', () => {
    it('returns blue when no active slot is set', () => {
      expect(determineNextSlot(null)).toBe('blue');
      expect(determineNextSlot(undefined)).toBe('blue');
    });

    it('toggles between blue and green', () => {
      expect(determineNextSlot('blue')).toBe('green');
      expect(determineNextSlot('green')).toBe('blue');
    });
  });

  describe('generateComposeOverride', () => {
    it('injects container_name and network aliases for primary web service', () => {
      const baseYaml = `
version: '3.8'
services:
  web:
    build: .
    ports:
      - "3000:3000"
`;
      const overrideStr = generateComposeOverride(baseYaml, 'myapp', 'blue');
      const override = yaml.parse(overrideStr);

      expect(override.services.web.container_name).toBe('myapp_blue');
      expect(override.services.web.networks.myploy_net.aliases).toContain('myapp_blue');
      expect(override.networks.myploy_net.name).toBe('myploy-net');
      expect(override.networks.myploy_net.external).toBe(true);
    });

    it('identifies custom service names like api or server', () => {
      const baseYaml = `
services:
  api:
    image: node:alpine
`;
      const overrideStr = generateComposeOverride(baseYaml, 'store', 'green');
      const override = yaml.parse(overrideStr);

      expect(override.services.api.container_name).toBe('store_green');
    });

    it('throws error if compose file has no services', () => {
      expect(() => generateComposeOverride('version: "3"', 'myapp', 'blue')).toThrow(
        'no services'
      );
    });
  });
});
