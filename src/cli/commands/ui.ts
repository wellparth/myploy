import { loadConfig } from '../../core/config.js';
import { startDashboard } from '../../server/dashboard.js';
import { sanitizeInteger } from '../../utils/security.js';

export async function uiCommand(options: { port?: string }): Promise<void> {
  const config = loadConfig();
  const port = sanitizeInteger(options.port || '4000', 4000);
  startDashboard(config, port);
}
