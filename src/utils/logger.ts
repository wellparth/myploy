import chalk from 'chalk';
import ora, { Ora } from 'ora';

export class Logger {
  private spinner?: Ora;

  info(msg: string) {
    console.log(`${chalk.blue('ℹ')} ${msg}`);
  }

  success(msg: string) {
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.succeed(chalk.green(msg));
    } else {
      console.log(`${chalk.green('✔')} ${msg}`);
    }
  }

  warn(msg: string) {
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.warn(chalk.yellow(msg));
    } else {
      console.log(`${chalk.yellow('⚠')} ${msg}`);
    }
  }

  error(msg: string, error?: unknown) {
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.fail(chalk.red(msg));
    } else {
      console.error(`${chalk.red('✖')} ${msg}`);
    }
    if (error && error instanceof Error) {
      console.error(chalk.redBright(error.stack || error.message));
    }
  }

  step(msg: string): Ora {
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.succeed();
    }
    this.spinner = ora({
      text: chalk.cyan(msg),
      color: 'cyan'
    }).start();
    return this.spinner;
  }

  stopSpinner(success = true, message?: string) {
    if (this.spinner && this.spinner.isSpinning) {
      if (success) {
        this.spinner.succeed(message ? chalk.green(message) : undefined);
      } else {
        this.spinner.fail(message ? chalk.red(message) : undefined);
      }
    }
  }

  header(title: string) {
    console.log('\n' + chalk.bold.cyan('━'.repeat(50)));
    console.log(chalk.bold.white(`  🚀 ${title}`));
    console.log(chalk.bold.cyan('━'.repeat(50)) + '\n');
  }

  table(rows: [string, string][]) {
    const maxKey = Math.max(...rows.map(([k]) => k.length));
    for (const [key, val] of rows) {
      console.log(`  ${chalk.dim(key.padEnd(maxKey + 2))} ${chalk.bold(val)}`);
    }
  }
}

export const logger = new Logger();
