import yaml from 'yaml';
import { SSHClient } from '../remote/ssh.js';
import { Slot, DeploymentState } from '../types/config.js';
import { escapeShellArg } from '../utils/security.js';

export async function getDeploymentState(ssh: SSHClient, appName: string): Promise<DeploymentState | null> {
  const statePath = `/var/lib/myploy/apps/${appName}/state.json`;
  const exists = await ssh.fileExists(statePath);
  if (!exists) return null;

  try {
    const raw = await ssh.readFile(statePath);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveDeploymentState(ssh: SSHClient, state: DeploymentState): Promise<void> {
  const dir = `/var/lib/myploy/apps/${state.app}`;
  await ssh.execOrThrow(`mkdir -p ${escapeShellArg(dir)}`);
  const statePath = `${dir}/state.json`;
  await ssh.writeFile(statePath, JSON.stringify(state, null, 2));
}

export function determineNextSlot(currentSlot?: Slot | null): Slot {
  return currentSlot === 'blue' ? 'green' : 'blue';
}

/**
 * Strips host port bindings from compose content to prevent port conflicts
 * between blue and green slots running simultaneously.
 */
export function sanitizeComposeForSlot(
  baseComposeYaml: string,
  appName: string,
  slot: Slot
): { sanitizedCompose: string; overrideCompose: string } {
  let parsed: any;
  try {
    parsed = yaml.parse(baseComposeYaml) || {};
  } catch {
    parsed = {};
  }

  const services = parsed.services || {};
  const serviceNames = Object.keys(services);

  if (serviceNames.length === 0) {
    throw new Error('docker-compose.yml contains no services.');
  }

  const primaryService =
    serviceNames.find((s) => ['web', 'app', 'api', 'server', appName].includes(s.toLowerCase())) ||
    serviceNames[0];

  // Remove host port bindings from primary service to prevent "port already allocated"
  if (parsed.services[primaryService] && parsed.services[primaryService].ports) {
    delete parsed.services[primaryService].ports;
  }

  const targetContainerName = `${appName}_${slot}`;

  const override: any = {
    version: parsed.version || '3.8',
    services: {
      [primaryService]: {
        container_name: targetContainerName,
        networks: {
          myploy_net: {
            aliases: [targetContainerName]
          },
          default: null
        }
      }
    },
    networks: {
      myploy_net: {
        name: 'myploy-net',
        external: true
      }
    }
  };

  return {
    sanitizedCompose: yaml.stringify(parsed),
    overrideCompose: yaml.stringify(override)
  };
}

export function generateComposeOverride(
  baseComposeYaml: string,
  appName: string,
  slot: Slot
): string {
  return sanitizeComposeForSlot(baseComposeYaml, appName, slot).overrideCompose;
}

