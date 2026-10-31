import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { DatabaseManager, DatabaseType } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

export async function dbCreateCommand(type: string, name: string): Promise<void> {
  const validTypes: DatabaseType[] = ['postgres', 'mysql', 'redis', 'mongo', 'mariadb'];
  if (!validTypes.includes(type as DatabaseType)) {
    throw new Error(`Invalid database type "${type}". Supported types: ${validTypes.join(', ')}`);
  }

  logger.header(`1-Click Database Provisioning: ${type.toUpperCase()}`);

  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    const spinner = logger.step(`Connecting to ${config.user}@${config.host}...`);
    await ssh.connect();
    spinner.succeed(`Connected to ${config.host}`);

    const dbManager = new DatabaseManager(ssh);
    const dbSpinner = logger.step(`Spinning up isolated ${type} instance [db_${name}]...`);

    const result = await dbManager.create({
      type: type as DatabaseType,
      name
    });

    dbSpinner.succeed(`Database [${name}] is running on internal network "myploy-net"!`);

    console.log('\n' + chalk.bold('Database Connection Details:'));
    logger.table([
      ['Engine', result.type.toUpperCase()],
      ['Container Name', result.containerName],
      ['Port', String(result.port)],
      ['User', result.user],
      ['Password', result.password || '(none)'],
      ['Internal URL', chalk.cyan(result.connectionUrl)]
    ]);

    console.log(
      '\n' +
        chalk.green(
          `💡 Apps deployed on this VPS can connect directly using the internal hostname "${result.containerName}"!`
        ) +
        '\n'
    );
  } finally {
    ssh.disconnect();
  }
}

export async function dbListCommand(): Promise<void> {
  logger.header('Managed Databases');

  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    await ssh.connect();
    const dbManager = new DatabaseManager(ssh);
    const list = await dbManager.list();

    if (list.length === 0) {
      logger.info('No databases provisioned yet. Run "myploy db create postgres mydb"');
      return;
    }

    console.log(chalk.bold('Active Databases:'));
    for (const db of list) {
      console.log(`\n  📦 ${chalk.bold.white(db.name)} [${db.type.toUpperCase()}] - Status: ${chalk.green(db.status)}`);
      console.log(`     Container: ${chalk.dim(db.containerName)}:${db.port}`);
      console.log(`     Connection: ${chalk.cyan(db.connectionUrl)}`);
    }
    console.log();
  } finally {
    ssh.disconnect();
  }
}

export async function dbBackupCommand(name: string): Promise<void> {
  logger.header(`Snapshot Backup: ${name}`);

  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    await ssh.connect();
    const dbManager = new DatabaseManager(ssh);
    const spinner = logger.step(`Creating snapshot backup for [${name}]...`);

    const backupPath = await dbManager.backup(name);
    spinner.succeed(`Snapshot backup completed successfully!`);
    console.log(`\n  💾 Backup Archive: ${chalk.green(backupPath)}\n`);
  } finally {
    ssh.disconnect();
  }
}
