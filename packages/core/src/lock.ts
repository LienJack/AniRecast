import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AniError } from '@anirecast/shared';

export const LOCK_FILE = '.anirecast.lock';
/** A lock from another machine older than this is considered abandoned. */
export const FOREIGN_LOCK_STALE_MS = 5 * 60_000;

export interface LockInfo {
  host: string;
  pid: number;
  startedAt: number;
  refreshedAt: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(root: string): LockInfo | undefined {
  const file = path.join(root, LOCK_FILE);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/** Only the daemon locks a workspace; CLI processes share it through SQLite. */
export function acquireDaemonLock(root: string, now: number = Date.now()): LockInfo {
  const host = os.hostname();
  const existing = readLock(root);
  if (existing && existing.pid !== process.pid) {
    const sameHost = existing.host === host;
    const held = sameHost ? pidAlive(existing.pid) : now - existing.refreshedAt < FOREIGN_LOCK_STALE_MS;
    if (held) {
      throw new AniError(
        'workspace_locked',
        `Workspace is open by AniRecast on ${existing.host} (pid ${existing.pid})`,
        {
          hint: sameHost
            ? 'Another AniRecast daemon is already serving this workspace.'
            : 'Close AniRecast on the other computer first.',
          details: existing,
        },
      );
    }
  }
  const lock: LockInfo = { host, pid: process.pid, startedAt: now, refreshedAt: now };
  writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(lock)}\n`);
  return lock;
}

export function refreshDaemonLock(root: string, lock: LockInfo, now: number = Date.now()): void {
  lock.refreshedAt = now;
  writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(lock)}\n`);
}

export function releaseDaemonLock(root: string): void {
  const existing = readLock(root);
  if (existing?.pid === process.pid) rmSync(path.join(root, LOCK_FILE), { force: true });
}
