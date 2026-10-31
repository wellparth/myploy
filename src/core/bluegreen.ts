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
 * Strips host port bindings from all compose services to prevent port conflicts
 * between blue and green slots and existing host services, and connects the public
 * ingress service to the myploy-net reverse proxy network.
 */
export function sanitizeComposeForSlot(
  baseComposeYaml: string,
  appName: string,
  slot: Slot,
  targetService?: string
): { sanitizedCompose: string; overrideCompose: string; primaryService: string } {
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

  // 1. Determine public ingress service (custom specified or intelligent auto-detection)
  let primaryService = targetService;
  if (!primaryService || !services[primaryService]) {
    const candidates = ['frontend', 'client', 'web', 'app', 'gateway', 'api', 'server', appName.toLowerCase()];
    primaryService =
      serviceNames.find((s) => candidates.includes(s.toLowerCase())) || serviceNames[0];
  }

  // 2. Strip host port bindings from ALL services in the project to avoid port collisions
  // with existing VPS services or between blue/green slots.
  // Containers still communicate with each other over Docker's internal DNS using internal ports.
  for (const sName of serviceNames) {
    if (parsed.services[sName] && parsed.services[sName].ports) {
      delete parsed.services[sName].ports;
    }
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
    overrideCompose: yaml.stringify(override),
    primaryService
  };
}

export function generateComposeOverride(
  baseComposeYaml: string,
  appName: string,
  slot: Slot,
  targetService?: string
): string {
  return sanitizeComposeForSlot(baseComposeYaml, appName, slot, targetService).overrideCompose;
}

