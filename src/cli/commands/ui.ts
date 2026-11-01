import { loadConfig } from '../../core/config.js';
import { startDashboard } from '../../server/dashboard.js';
import { sanitizeInteger } from '../../utils/security.js';

export async function uiCommand(options: { port?: string; host?: string }): Promise<void> {
  const config = loadConfig();
  const port = sanitizeInteger(options.port || '3333', 3333);
  const host = options.host || '0.0.0.0';
  startDashboard(config, port, host);
}
