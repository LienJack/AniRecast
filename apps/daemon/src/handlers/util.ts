import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '@anirecast/core';

/** Absolute path for a workspace-relative path, creating its parent folder. */
export function outPath(ws: Workspace, rel: string): string {
  const abs = ws.abs(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/** Maps a sub-step's 0..1 progress into [from, to] of the job's overall progress. */
export const span =
  (report: (fraction: number, message?: string) => void, from: number, to: number, message?: string) =>
  (fraction: number) =>
    report(from + (to - from) * fraction, message);
