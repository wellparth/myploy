import { Client, ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import { MyPloyConfig } from '../types/config.js';
import { expandTilde } from '../core/config.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  streamOutput?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class SSHClient {
  private client: Client;
  private connected = false;

  constructor(private config: MyPloyConfig) {
    this.client = new Client();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const connectOpts: ConnectConfig = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.user,
        readyTimeout: 20000,
        keepaliveInterval: 10000
      };

      if (this.config.password) {
        connectOpts.password = this.config.password;
      }

      if (this.config.sshKey) {
        const keyPath = expandTilde(this.config.sshKey);
        if (fs.existsSync(keyPath)) {
          connectOpts.privateKey = fs.readFileSync(keyPath);
        } else if (!this.config.password) {
          return reject(
            new Error(`SSH private key not found at "${keyPath}" and no password was provided.`)
          );
        }
      }

      this.client
        .on('ready', () => {
          this.connected = true;
          resolve();
        })
        .on('error', (err) => {
          reject(new Error(`SSH connection failed to ${this.config.user}@${this.config.host}:${this.config.port}: ${err.message}`));
        })
        .on('close', () => {
          this.connected = false;
        })
        .connect(connectOpts);
    });
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';

        stream
          .on('close', (code: number) => {
            resolve({ stdout, stderr, code: code ?? 0 });
          })
          .on('data', (data: Buffer) => {
            const str = data.toString('utf-8');
            stdout += str;
            if (options.streamOutput) {
              process.stdout.write(str);
            }
            if (options.onStdout) {
              options.onStdout(str);
            }
          })
          .stderr.on('data', (data: Buffer) => {
            const str = data.toString('utf-8');
            stderr += str;
            if (options.streamOutput) {
              process.stderr.write(str);
            }
            if (options.onStderr) {
              options.onStderr(str);
            }
          });
      });
    });
  }

  async execStream(
    command: string,
    callback: (err: Error | undefined, stream: any) => void
  ): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    this.client.exec(command, callback);
  }

  async execOrThrow(command: string, options: ExecOptions = {}): Promise<string> {
    const res = await this.exec(command, options);
    if (res.code !== 0) {
      throw new Error(`Command failed with code ${res.code}: ${command}\nError: ${res.stderr || res.stdout}`);
    }
    return res.stdout.trim();
  }

  async writeFile(remotePath: string, content: string | Buffer): Promise<void> {
    if (!this.connected) await this.connect();

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);

        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });
        writeStream.on('error', (err: Error) => {
          sftp.end();
          reject(err);
        });

        writeStream.end(content);
      });
    });
  }

  async readFile(remotePath: string): Promise<string> {
    if (!this.connected) await this.connect();

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);

        const readStream = sftp.createReadStream(remotePath);
        let content = '';

        readStream.on('data', (chunk: Buffer) => {
          content += chunk.toString('utf-8');
        });
        readStream.on('end', () => {
          sftp.end();
          resolve(content);
        });
        readStream.on('error', (err: Error) => {
          sftp.end();
          reject(err);
        });
      });
    });
  }

  async fileExists(remotePath: string): Promise<boolean> {
    const res = await this.exec(`test -e "${remotePath}" && echo 1 || echo 0`);
    return res.stdout.trim() === '1';
  }

  disconnect(): void {
    if (this.connected) {
      this.client.end();
      this.connected = false;
    }
  }
}
