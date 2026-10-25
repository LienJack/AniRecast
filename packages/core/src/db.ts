import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue>;

/** Opens a workspace database with the settings both the CLI and the daemon rely on. */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE`, so the write lock is taken up front and two processes never
 * deadlock upgrading read locks. Nested calls reuse the outer transaction.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function one<T>(db: Db, sql: string, params: Params = {}): T | undefined {
  return db.prepare(sql).get(params) as T | undefined;
}

export function all<T>(db: Db, sql: string, params: Params = {}): T[] {
  return db.prepare(sql).all(params) as T[];
}

export function run(db: Db, sql: string, params: Params = {}): { changes: number; lastInsertRowid: number } {
  const result = db.prepare(sql).run(params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

export const toJson = (value: unknown): string => JSON.stringify(value ?? null);
export const fromJson = <T>(text: string | null | undefined, fallback: T): T =>
  text == null || text === '' ? fallback : (JSON.parse(text) as T);
