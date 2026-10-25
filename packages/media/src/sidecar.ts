import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AniError } from '@anirecast/shared';
import { exec } from './exec.ts';

/** The uv project under `<repo>/python`. Overridable for installs that relocate it. */
export const sidecarProject = (env: NodeJS.ProcessEnv = process.env): string =>
  env.ANIRECAST_SIDECAR_PROJECT ?? fileURLToPath(new URL('../../../python', import.meta.url));

type SidecarEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function parseEnvelope<T>(stdout: string): SidecarEnvelope<T> | undefined {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line) as SidecarEnvelope<T>;
  } catch {
    return undefined;
  }
}

/** Runs `anirecast-py <command> …` and unwraps its single-line `{ok,data|error}` JSON. */
export async function runSidecar<T>(
  command: string,
  args: string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<T> {
  const project = sidecarProject();
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'uv',
      ['run', '--quiet', '--project', project, 'anirecast-py', command, ...args],
      {
        ...(signal ? { signal } : {}),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      },
    ));
  } catch (error) {
    const details = (error as AniError).details as { stdout?: string; stderr?: string } | undefined;
    const envelope = details?.stdout ? parseEnvelope<T>(details.stdout) : undefined;
    if (envelope && !envelope.ok) {
      throw new AniError('internal', `Python sidecar "${command}": ${envelope.error.message}`, {
        details: { stderr: details?.stderr },
      });
    }
    if (error instanceof AniError && error.code === 'internal') {
      throw new AniError('internal', `Python sidecar "${command}" failed`, {
        details: error.details,
        cause: error,
      });
    }
    throw error;
  }
  const envelope = parseEnvelope<T>(stdout);
  if (!envelope) {
    throw new AniError('internal', `Python sidecar "${command}" returned non-JSON output`, {
      details: { stdout: stdout.slice(-2000), project: path.resolve(project) },
    });
  }
  if (!envelope.ok) throw new AniError('internal', `Python sidecar "${command}": ${envelope.error.message}`);
  return envelope.data;
}
