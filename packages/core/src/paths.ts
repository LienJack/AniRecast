import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { assertSafeRelativePath } from './naming.ts';

/** Resolves a workspace-relative POSIX path to an absolute path, refusing escapes. */
export function resolveIn(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'));
  const relBack = path.relative(root, abs);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new AniError('naming_violation', `Path escapes the workspace: ${rel}`);
  }
  return abs;
}

/** Converts an absolute path inside the workspace to the POSIX relative form stored in the database. */
export function toRelative(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AniError('naming_violation', `Path is outside the workspace: ${abs}`);
  }
  return rel.split(path.sep).join('/');
}

/** Joins POSIX segments and validates the result as a generated workspace path. */
export function relPath(...segments: string[]): string {
  const rel = segments.join('/');
  assertSafeRelativePath(rel);
  return rel;
}
