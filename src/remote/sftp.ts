import tar from 'tar-fs';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { SSHClient } from './ssh.js';

export interface UploadOptions {
  ignore?: string[];
  onProgress?: (bytes: number) => void;
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.env',
  '.env.local',
  'dist',
  'coverage',
  '.DS_Store'
];

export async function uploadDirectoryAsTar(
  ssh: SSHClient,
  localDir: string,
  remoteTargetDir: string,
  options: UploadOptions = {}
): Promise<void> {
  const ignoreList = new Set([...DEFAULT_IGNORE, ...(options.ignore || [])]);

  // Read .gitignore or .dockerignore if present
  const gitignorePath = path.join(localDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        ignoreList.add(trimmed.replace(/\/$/, ''));
      }
    }
  }

  // Ensure remote directory exists
  await ssh.execOrThrow(`mkdir -p "${remoteTargetDir}"`);

  // Open remote command that untars from stdin
  const remoteCmd = `tar -xzf - -C "${remoteTargetDir}"`;
  
  return new Promise((resolve, reject) => {
    ssh.execStream(remoteCmd, (err, stream) => {
      if (err) return reject(err);

      let stderrOutput = '';
      stream.stderr.on('data', (d: Buffer) => {
        stderrOutput += d.toString('utf-8');
      });

      stream.on('close', (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Remote extraction failed (code ${code}): ${stderrOutput}`));
        }
      });

      // Pack directory and pipe through gzip into SSH stdin stream
      const pack = tar.pack(localDir, {
        ignore: (name) => {
          const rel = path.relative(localDir, name);
          if (!rel) return false;
          const parts = rel.split(path.sep);
          return parts.some((p) => ignoreList.has(p));
        }
      });

      const gzip = zlib.createGzip();
      pack.pipe(gzip).pipe(stream);

      pack.on('error', reject);
      gzip.on('error', reject);
    }).catch(reject);
  });
}
