import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireDaemonLock,
  DEFAULT_CONFIG,
  LOCK_FILE,
  loadConfig,
  readLock,
  releaseDaemonLock,
  rememberWorkspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('local config', () => {
  it('defaults without a file and remembers recent workspaces', () => {
    const env = { ANIRECAST_CONFIG_DIR: tempDir() };
    expect(loadConfig(env)).toEqual(DEFAULT_CONFIG);
    rememberWorkspace('/tmp/a', env);
    const config = rememberWorkspace('/tmp/b', env);
    expect(config.workspace).toBe(path.resolve('/tmp/b'));
    expect(loadConfig(env).recentWorkspaces).toEqual([path.resolve('/tmp/b'), path.resolve('/tmp/a')]);
  });
});

describe('daemon lock', () => {
  it('refuses a lock held by a live process on this host and takes over a dead one', () => {
    const root = tempDir();
    const live = { host: os.hostname(), pid: process.ppid, startedAt: 1, refreshedAt: Date.now() };
    writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(live));
    expect(() => acquireDaemonLock(root)).toThrow(/is open by AniRecast/);

    writeFileSync(path.join(root, LOCK_FILE), JSON.stringify({ ...live, pid: 999_999 }));
    expect(acquireDaemonLock(root).pid).toBe(process.pid);
    releaseDaemonLock(root);
    expect(readLock(root)).toBeUndefined();
  });

  it('respects a fresh lock from another machine but not an abandoned one', () => {
    const root = tempDir();
    const foreign = { host: 'other-mac', pid: 42, startedAt: 1, refreshedAt: Date.now() };
    writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(foreign));
    expect(() => acquireDaemonLock(root)).toThrow(/Close AniRecast on the other computer|other-mac/);
    writeFileSync(
      path.join(root, LOCK_FILE),
      JSON.stringify({ ...foreign, refreshedAt: Date.now() - 3_600_000 }),
    );
    expect(acquireDaemonLock(root).host).toBe(os.hostname());
  });
});
