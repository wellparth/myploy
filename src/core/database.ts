import crypto from 'node:crypto';
import { SSHClient } from '../remote/ssh.js';
import { escapeShellArg, sanitizeAppName } from '../utils/security.js';

export type DatabaseType = 'postgres' | 'mysql' | 'redis' | 'mongo' | 'mariadb';

export interface DatabaseMetadata {
  name: string;
  type: DatabaseType;
  containerName: string;
  database: string;
  user: string;
  password?: string;
  port: number;
  connectionUrl: string;
  createdAt: string;
}

export interface CreateDatabaseOptions {
  name: string;
  type: DatabaseType;
  database?: string;
  user?: string;
  password?: string;
  version?: string;
}

export class DatabaseManager {
  constructor(private ssh: SSHClient) {}

  private async getRegistry(): Promise<Record<string, DatabaseMetadata>> {
    const registryPath = '/var/lib/myploy/databases/registry.json';
    const exists = await this.ssh.fileExists(registryPath);
    if (!exists) return {};

    try {
      const raw = await this.ssh.readFile(registryPath);
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async saveRegistry(registry: Record<string, DatabaseMetadata>): Promise<void> {
    await this.ssh.execOrThrow('mkdir -p /var/lib/myploy/databases');
    await this.ssh.writeFile(
      '/var/lib/myploy/databases/registry.json',
      JSON.stringify(registry, null, 2)
    );
  }

  async create(opts: CreateDatabaseOptions): Promise<DatabaseMetadata> {
    const safeName = sanitizeAppName(opts.name);
    const containerName = `db_${safeName}`;
    const password = opts.password || crypto.randomBytes(16).toString('hex');
    const dbName = opts.database || safeName.replace(/-/g, '_');
    const user = opts.user || (opts.type === 'postgres' ? 'postgres' : 'root');

    const dataDir = `/var/lib/myploy/databases/${opts.type}_${safeName}`;
    await this.ssh.execOrThrow(`mkdir -p ${escapeShellArg(dataDir)}`);

    let dockerCmd = '';
    let port = 5432;
    let connUrl = '';

    switch (opts.type) {
      case 'postgres': {
        port = 5432;
        const img = `postgres:${opts.version || '16-alpine'}`;
        connUrl = `postgresql://${user}:${password}@${containerName}:${port}/${dbName}`;
        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          -e POSTGRES_DB=${escapeShellArg(dbName)} \\
          -e POSTGRES_USER=${escapeShellArg(user)} \\
          -e POSTGRES_PASSWORD=${escapeShellArg(password)} \\
          -v ${escapeShellArg(dataDir)}:/var/lib/postgresql/data \\
          ${escapeShellArg(img)}`;
        break;
      }
      case 'mysql': {
        port = 3306;
        const img = `mysql:${opts.version || '8.0'}`;
        connUrl = `mysql://${user}:${password}@${containerName}:${port}/${dbName}`;
        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          -e MYSQL_DATABASE=${escapeShellArg(dbName)} \\
          -e MYSQL_ROOT_PASSWORD=${escapeShellArg(password)} \\
          -v ${escapeShellArg(dataDir)}:/var/lib/mysql \\
          ${escapeShellArg(img)}`;
        break;
      }
      case 'mariadb': {
        port = 3306;
        const img = `mariadb:${opts.version || '11'}`;
        connUrl = `mysql://${user}:${password}@${containerName}:${port}/${dbName}`;
        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          -e MARIADB_DATABASE=${escapeShellArg(dbName)} \\
          -e MARIADB_ROOT_PASSWORD=${escapeShellArg(password)} \\
          -v ${escapeShellArg(dataDir)}:/var/lib/mysql \\
          ${escapeShellArg(img)}`;
        break;
      }
      case 'redis': {
        port = 6379;
        const img = `redis:${opts.version || '7-alpine'}`;
        connUrl = `redis://:${password}@${containerName}:${port}`;
        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          -v ${escapeShellArg(dataDir)}:/data \\
          ${escapeShellArg(img)} redis-server --requirepass ${escapeShellArg(password)} --appendonly yes`;
        break;
      }
      case 'mongo': {
        port = 27017;
        const img = `mongo:${opts.version || '7.0'}`;
        connUrl = `mongodb://${user}:${password}@${containerName}:${port}/${dbName}?authSource=admin`;
        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          -e MONGO_INITDB_ROOT_USERNAME=${escapeShellArg(user)} \\
          -e MONGO_INITDB_ROOT_PASSWORD=${escapeShellArg(password)} \\
          -e MONGO_INITDB_DATABASE=${escapeShellArg(dbName)} \\
          -v ${escapeShellArg(dataDir)}:/data/db \\
          ${escapeShellArg(img)}`;
        break;
      }
    }

    // Stop existing container if present
    await this.ssh.exec(`docker rm -f ${escapeShellArg(containerName)} 2>/dev/null`);
    // Run container
    await this.ssh.execOrThrow(dockerCmd);

    const metadata: DatabaseMetadata = {
      name: safeName,
      type: opts.type,
      containerName,
      database: dbName,
      user,
      password,
      port,
      connectionUrl: connUrl,
      createdAt: new Date().toISOString()
    };

    const registry = await this.getRegistry();
    registry[safeName] = metadata;
    await this.saveRegistry(registry);

    return metadata;
  }

  async list(): Promise<(DatabaseMetadata & { status: string })[]> {
    const registry = await this.getRegistry();
    const result: (DatabaseMetadata & { status: string })[] = [];

    for (const item of Object.values(registry)) {
      const statusRes = await this.ssh.exec(
        `docker inspect -f '{{.State.Status}}' ${escapeShellArg(item.containerName)} 2>/dev/null`
      );
      const status = statusRes.stdout.trim() || 'stopped';
      result.push({ ...item, status });
    }

    return result;
  }

  async backup(name: string): Promise<string> {
    const safeName = sanitizeAppName(name);
    const registry = await this.getRegistry();
    const db = registry[safeName];

    if (!db) {
      throw new Error(`Database "${name}" not found in MyPloy registry.`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = `/var/lib/myploy/backups/${safeName}`;
    await this.ssh.execOrThrow(`mkdir -p ${escapeShellArg(backupDir)}`);

    let backupFile = '';

    switch (db.type) {
      case 'postgres': {
        backupFile = `${backupDir}/${safeName}_${timestamp}.sql.gz`;
        const cmd = `docker exec ${escapeShellArg(db.containerName)} pg_dump -U ${escapeShellArg(db.user)} ${escapeShellArg(db.database)} | gzip > ${escapeShellArg(backupFile)}`;
        await this.ssh.execOrThrow(cmd);
        break;
      }
      case 'mysql':
      case 'mariadb': {
        backupFile = `${backupDir}/${safeName}_${timestamp}.sql.gz`;
        const cmd = `docker exec ${escapeShellArg(db.containerName)} mysqldump -u ${escapeShellArg(db.user)} -p${escapeShellArg(db.password || '')} ${escapeShellArg(db.database)} | gzip > ${escapeShellArg(backupFile)}`;
        await this.ssh.execOrThrow(cmd);
        break;
      }
      case 'mongo': {
        backupFile = `${backupDir}/${safeName}_${timestamp}.archive.gz`;
        const cmd = `docker exec ${escapeShellArg(db.containerName)} mongodump --archive --gzip -u ${escapeShellArg(db.user)} -p ${escapeShellArg(db.password || '')} --authenticationDatabase admin > ${escapeShellArg(backupFile)}`;
        await this.ssh.execOrThrow(cmd);
        break;
      }
      case 'redis': {
        backupFile = `${backupDir}/${safeName}_${timestamp}.rdb`;
        await this.ssh.execOrThrow(`docker exec ${escapeShellArg(db.containerName)} redis-cli -a ${escapeShellArg(db.password || '')} save`);
        await this.ssh.execOrThrow(`docker cp ${escapeShellArg(db.containerName)}:/data/dump.rdb ${escapeShellArg(backupFile)}`);
        break;
      }
    }

    return backupFile;
  }
}
