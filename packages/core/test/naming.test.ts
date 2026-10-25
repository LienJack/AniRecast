import { describe, expect, it } from 'vitest';
import { assertSafeRelativePath, segmentViolations, slugify, uniqueSlug } from '../src/index.ts';

describe('cross-platform naming', () => {
  it('rejects Windows reserved names, trailing dots and forbidden characters', () => {
    expect(segmentViolations('con')).toContain('Windows reserved name');
    expect(segmentViolations('nul.txt')).toContain('Windows reserved name');
    expect(segmentViolations('shot.')).toContain('ends with dot or space');
    expect(segmentViolations('a:b')).toContain('forbidden character');
    expect(segmentViolations('鏡頭')).toContain('not a lowercase ASCII slug');
    expect(segmentViolations('Shot')).toContain('not a lowercase ASCII slug');
    expect(segmentViolations('shot_01abc.mp4')).toEqual([]);
  });

  it('validates whole relative paths', () => {
    expect(() => assertSafeRelativePath('projects/op-1/shots/a.mp4')).not.toThrow();
    expect(() => assertSafeRelativePath('/abs/path')).toThrow(/relative/);
    expect(() => assertSafeRelativePath('projects\\x')).toThrow(/relative/);
    expect(() => assertSafeRelativePath('projects/../x')).toThrow(/relative segment/);
    expect(() => assertSafeRelativePath(`${'a/'.repeat(120)}b`)).toThrow(/longer/);
  });

  it('slugifies display names to ASCII and keeps names unique case-insensitively', () => {
    expect(slugify('Cowboy Bebop OP!', 'project')).toBe('cowboy-bebop-op');
    expect(slugify('進擊的巨人', 'project')).toBe('project');
    expect(slugify('Café Noël', 'x')).toBe('cafe-noel');
    expect(slugify('con', 'x')).toBe('con-1');
    expect(uniqueSlug('op', ['OP', 'op-2'])).toBe('op-3');
  });
});
