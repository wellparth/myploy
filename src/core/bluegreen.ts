import yaml from 'yaml';
import { SSHClient } from '../remote/ssh.js';
import { Slot, DeploymentState } from '../types/config.js';

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
  await ssh.execOrThrow(`mkdir -p "${dir}"`);
  const statePath = `${dir}/state.json`;
  await ssh.writeFile(statePath, JSON.stringify(state, null, 2));
}

export function determineNextSlot(currentSlot?: Slot | null): Slot {
  return currentSlot === 'blue' ? 'green' : 'blue';
}

/**
 * Inspects the user's docker-compose.yml and creates an override file that:
 * 1. Attaches the primary web service to the `myploy-net` network with alias `${appName}_${slot}`
 * 2. Names the container `${appName}_${slot}`
 * 3. Removes host port bindings to prevent port collision during blue/green overlap
 */
export function generateComposeOverride(
  baseComposeYaml: string,
  appName: string,
  slot: Slot
): string {
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

  // The primary service is usually "web", "app", "api", "server", or the first service
  const primaryService =
    serviceNames.find((s) => ['web', 'app', 'api', 'server', appName].includes(s.toLowerCase())) ||
    serviceNames[0];

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

  return yaml.stringify(override);
}
