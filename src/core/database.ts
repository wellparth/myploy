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
    const envFile = `${dataDir}/.env`;

    let dockerCmd = '';
    let port = 5432;
    let connUrl = '';

    switch (opts.type) {
      case 'postgres': {
        port = 5432;
        const img = `postgres:${opts.version || '16-alpine'}`;
        connUrl = `postgresql://${user}:${password}@${containerName}:${port}/${dbName}`;
        await this.ssh.writeFile(
          envFile,
          `POSTGRES_DB=${dbName}\nPOSTGRES_USER=${user}\nPOSTGRES_PASSWORD=${password}\n`
        );
        await this.ssh.exec(`chmod 600 ${escapeShellArg(envFile)}`);

        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          --env-file ${escapeShellArg(envFile)} \\
          -v ${escapeShellArg(dataDir)}:/var/lib/postgresql/data \\
          ${escapeShellArg(img)}`;
        break;
      }
      case 'mysql': {
        port = 3306;
        const img = `mysql:${opts.version || '8.0'}`;
        connUrl = `mysql://${user}:${password}@${containerName}:${port}/${dbName}`;
        await this.ssh.writeFile(
          envFile,
          `MYSQL_DATABASE=${dbName}\nMYSQL_ROOT_PASSWORD=${password}\n`
        );
        await this.ssh.exec(`chmod 600 ${escapeShellArg(envFile)}`);

        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          --env-file ${escapeShellArg(envFile)} \\
          -v ${escapeShellArg(dataDir)}:/var/lib/mysql \\
          ${escapeShellArg(img)}`;
        break;
      }
      case 'mariadb': {
        port = 3306;
        const img = `mariadb:${opts.version || '11'}`;
        connUrl = `mysql://${user}:${password}@${containerName}:${port}/${dbName}`;
        await this.ssh.writeFile(
          envFile,
          `MARIADB_DATABASE=${dbName}\nMARIADB_ROOT_PASSWORD=${password}\n`
        );
        await this.ssh.exec(`chmod 600 ${escapeShellArg(envFile)}`);

        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          --env-file ${escapeShellArg(envFile)} \\
          -v ${escapeShellArg(dataDir)}:/var/lib/mysql \\
          ${escapeShellArg(img)}`;
        break;
      }
      case 'redis': {
        port = 6379;
        const img = `redis:${opts.version || '7-alpine'}`;
        connUrl = `redis://:${password}@${containerName}:${port}`;
        // Redis config file with password to avoid process table sniffing
        const redisConf = `${dataDir}/redis.conf`;
        await this.ssh.writeFile(redisConf, `requirepass ${password}\nappendonly yes\n`);
        await this.ssh.exec(`chmod 600 ${escapeShellArg(redisConf)}`);

        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          -v ${escapeShellArg(dataDir)}:/data \\
          -v ${escapeShellArg(redisConf)}:/usr/local/etc/redis/redis.conf \\
          ${escapeShellArg(img)} redis-server /usr/local/etc/redis/redis.conf`;
        break;
      }
      case 'mongo': {
        port = 27017;
        const img = `mongo:${opts.version || '7.0'}`;
        connUrl = `mongodb://${user}:${password}@${containerName}:${port}/${dbName}?authSource=admin`;
        await this.ssh.writeFile(
          envFile,
          `MONGO_INITDB_ROOT_USERNAME=${user}\nMONGO_INITDB_ROOT_PASSWORD=${password}\nMONGO_INITDB_DATABASE=${dbName}\n`
        );
        await this.ssh.exec(`chmod 600 ${escapeShellArg(envFile)}`);

        dockerCmd = `docker run -d --name ${escapeShellArg(containerName)} \\
          --restart always \\
          --network myploy-net \\
          --env-file ${escapeShellArg(envFile)} \\
          -v ${escapeShellArg(dataDir)}:/data/db \\
          ${escapeShellArg(img)}`;
        break;
      }
      default: {
        throw new Error(`Unsupported database type: ${(opts as any).type}`);
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
      default: {
        throw new Error(`Unsupported database type for backup: ${(db as any).type}`);
      }
    }

    return backupFile;
  }
}
