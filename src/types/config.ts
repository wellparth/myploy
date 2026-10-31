export interface HealthcheckConfig {
  path: string;
  port?: number;
  timeoutSeconds: number;
  intervalSeconds: number;
}

export interface SSLConfig {
  enabled: boolean;
  email?: string;
  staging?: boolean;
}

export interface MyPloyConfig {
  app: string;
  domain: string;
  host: string;
  user: string;
  port?: number;
  sshKey?: string;
  password?: string;
  service?: string; // Optional: specify which service in docker-compose.yml receives public traffic
  appPort: number;
  healthcheck?: Partial<HealthcheckConfig>;
  envFile?: string;
  ssl?: boolean | Partial<SSLConfig>;
  composeFile?: string;
  keepPreviousRunning?: boolean;
}

export type Slot = 'blue' | 'green';

export interface DeploymentState {
  app: string;
  activeSlot: Slot;
  previousSlot?: Slot;
  domain: string;
  updatedAt: string;
}
