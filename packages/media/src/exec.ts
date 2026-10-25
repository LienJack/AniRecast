import { spawn } from 'node:child_process';
import { AniError } from '@anirecast/shared';

export interface ExecOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called for each stderr line (ffmpeg progress, yt-dlp output). */
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
  input?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a command, rejecting with `dependency_missing` when it is not installed. Abort kills it. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';
    const lines = (buf: string, chunk: string, cb?: (l: string) => void): string => {
      const all = buf + chunk;
      const parts = all.split(/\r?\n|\r/);
      const rest = parts.pop() ?? '';
      if (cb) for (const p of parts) if (p.length > 0) cb(p);
      return rest;
    };
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      outBuf = lines(outBuf, d, opts.onStdoutLine);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      errBuf = lines(errBuf, d, opts.onStderrLine);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(
        error.code === 'ENOENT'
          ? new AniError('dependency_missing', `${cmd} is not installed or not on PATH`, {
              hint: 'Run `anirecast doctor`.',
            })
          : error,
      );
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(opts.signal.reason);
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(
        new AniError('internal', `${cmd} exited with code ${code}`, {
          details: { args, stderr: tail, stdout: stdout.slice(-4000) },
        }),
      );
    });
  });
}
