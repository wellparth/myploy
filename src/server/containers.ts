import { SSHClient } from '../remote/ssh.js';
import { escapeShellArg } from '../utils/security.js';

export interface DiscoveredContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
  isMyPloy: boolean;
}

export function sanitizeContainerIdentifier(id: string): string {
  const sanitized = id.trim();
  if (sanitized.startsWith('-')) {
    throw new Error('Security validation failed: Container identifier cannot start with a dash.');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(sanitized)) {
    throw new Error('Security validation failed: Invalid container identifier.');
  }
  return sanitized;
}

export async function listAllVPSContainers(ssh: SSHClient): Promise<DiscoveredContainer[]> {
  const cmd = `docker ps -a --format '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}'`;
  const res = await ssh.exec(cmd);

  if (res.code !== 0) {
    return [];
  }

  const lines = res.stdout.trim().split('\n').filter(Boolean);
  const containers: DiscoveredContainer[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const isMyPloy =
        parsed.name.startsWith('myploy-') ||
        parsed.name.includes('_blue') ||
        parsed.name.includes('_green') ||
        parsed.name.startsWith('db_');
      containers.push({
        ...parsed,
        isMyPloy
      });
    } catch {
      // ignore malformed line
    }
  }

  return containers;
}

export async function startVPSContainer(ssh: SSHClient, id: string): Promise<void> {
  const safeId = sanitizeContainerIdentifier(id);
  await ssh.execOrThrow(`docker start ${escapeShellArg(safeId)}`);
}

export async function stopVPSContainer(ssh: SSHClient, id: string): Promise<void> {
  const safeId = sanitizeContainerIdentifier(id);
  await ssh.execOrThrow(`docker stop ${escapeShellArg(safeId)}`);
}

export async function restartVPSContainer(ssh: SSHClient, id: string): Promise<void> {
  const safeId = sanitizeContainerIdentifier(id);
  await ssh.execOrThrow(`docker restart ${escapeShellArg(safeId)}`);
}

export async function getVPSContainerLogs(
  ssh: SSHClient,
  id: string,
  tail = 100
): Promise<string> {
  const safeId = sanitizeContainerIdentifier(id);
  const safeTail = Math.min(Math.max(1, tail), 500);
  const res = await ssh.exec(`docker logs --tail ${safeTail} ${escapeShellArg(safeId)} 2>&1`);
  return res.stdout || res.stderr || 'No logs available.';
}
