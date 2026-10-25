import { AniError } from '@anirecast/shared';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FORBIDDEN_CHARS = /[<>:"\\|?*]/;
const hasControlChar = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 0x20);
/** Generated names are lowercase ASCII only; display names live in the database. */
const GENERATED_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_RELATIVE_PATH = 200;

export interface NamingViolation {
  segment: string;
  reason: string;
}

/** Checks one path segment against the cross-platform rules in design.md §4. */
export function segmentViolations(segment: string, { generated = true } = {}): string[] {
  const reasons: string[] = [];
  if (segment.length === 0) reasons.push('empty segment');
  if (segment === '.' || segment === '..') reasons.push('relative segment');
  if (FORBIDDEN_CHARS.test(segment) || hasControlChar(segment)) reasons.push('forbidden character');
  if (/[. ]$/.test(segment)) reasons.push('ends with dot or space');
  if (WINDOWS_RESERVED.test(segment)) reasons.push('Windows reserved name');
  if (generated && !GENERATED_SEGMENT.test(segment)) reasons.push('not a lowercase ASCII slug');
  return reasons;
}

/** Validates a workspace-relative POSIX path; throws `naming_violation` on the first problem. */
export function assertSafeRelativePath(rel: string, options: { generated?: boolean } = {}): void {
  if (rel.startsWith('/') || rel.includes('\\')) {
    throw new AniError('naming_violation', `Path must be relative and use "/": ${rel}`);
  }
  if (rel.length > MAX_RELATIVE_PATH) {
    throw new AniError('naming_violation', `Path longer than ${MAX_RELATIVE_PATH} characters: ${rel}`);
  }
  for (const segment of rel.split('/')) {
    const reasons = segmentViolations(segment, options);
    if (reasons.length > 0) {
      throw new AniError(
        'naming_violation',
        `Unsafe path segment "${segment}" in ${rel}: ${reasons.join(', ')}`,
      );
    }
  }
}

/** Turns a display name into a lowercase ASCII slug; falls back to `fallback` when nothing ASCII survives. */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const candidate = slug.length > 0 ? slug : fallback;
  return WINDOWS_RESERVED.test(candidate) ? `${candidate}-1` : candidate;
}

/** Picks a slug not already in `taken`, comparing case-insensitively as Windows and macOS do. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!lower.has(candidate)) return candidate;
  }
}
