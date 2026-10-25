import { AniError } from '@anirecast/shared';
import { type Db, one, run } from './db.ts';

export const HEARTBEAT_INTERVAL_MS = 2_000;
export const HEARTBEAT_STALE_MS = 10_000;

export interface Heartbeat {
  host: string;
  pid: number;
  version: string;
  startedAt: number;
  at: number;
}

export function writeHeartbeat(db: Db, hb: Omit<Heartbeat, 'at'>, now: number = Date.now()): void {
  run(
    db,
    `INSERT INTO daemon_heartbeat (id, host, pid, version, started_at, at) VALUES (1, :host, :pid, :version, :startedAt, :now)
     ON CONFLICT (id) DO UPDATE SET host = :host, pid = :pid, version = :version, started_at = :startedAt, at = :now`,
    { ...hb, now },
  );
}

export function clearHeartbeat(db: Db, pid: number): void {
  run(db, 'DELETE FROM daemon_heartbeat WHERE pid = :pid', { pid });
}

export function readHeartbeat(db: Db): Heartbeat | undefined {
  const row = one<{ host: string; pid: number; version: string; started_at: number; at: number }>(
    db,
    'SELECT * FROM daemon_heartbeat WHERE id = 1',
  );
  return row && { host: row.host, pid: row.pid, version: row.version, startedAt: row.started_at, at: row.at };
}

export function daemonStatus(db: Db, now: number = Date.now()): { alive: boolean; heartbeat?: Heartbeat } {
  const heartbeat = readHeartbeat(db);
  if (!heartbeat) return { alive: false };
  return { alive: now - heartbeat.at < HEARTBEAT_STALE_MS, heartbeat };
}

export function assertDaemonAlive(db: Db, now: number = Date.now()): Heartbeat {
  const status = daemonStatus(db, now);
  if (status.alive && status.heartbeat) return status.heartbeat;
  throw new AniError('daemon_not_running', 'AniRecast 服務沒有在執行，任務不會被處理', {
    hint: 'Start it with `anirecast serve` (or `anirecast setup` to install the launchd agent).',
    details: status.heartbeat ? { lastHeartbeatAt: status.heartbeat.at } : undefined,
  });
}
