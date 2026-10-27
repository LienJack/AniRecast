import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENTS_FILE, CLAUDE_FILE, initWorkspace, openWorkspace, workspaceClaudeMd } from '../src/index.ts';
import { tempDir } from './helpers.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

describe('workspace CLAUDE.md', () => {
  it('is written beside AGENTS.md: imports it and names the task loop and the code repo', () => {
    const root = tempDir();
    initWorkspace(root, { name: 'Media Hub' }).close();
    const guide = readFileSync(path.join(root, CLAUDE_FILE), 'utf8');
    expect(guide).toBe(workspaceClaudeMd('Media Hub'));
    expect(guide.split('\n')).toContain('@AGENTS.md');
    expect(guide).toContain('anirecast tasks next --for claude');
    expect(guide).toContain(REPO_ROOT);
    expect(existsSync(path.join(root, AGENTS_FILE))).toBe(true);
  });

  it('is created when an existing workspace without one is opened', () => {
    const root = tempDir();
    initWorkspace(root, { name: 'mediaHub' }).close();
    rmSync(path.join(root, CLAUDE_FILE));
    openWorkspace(root, { role: 'cli' }).close();
    expect(readFileSync(path.join(root, CLAUDE_FILE), 'utf8')).toBe(workspaceClaudeMd('mediaHub'));
  });

  it('is rewritten while still ours, and left alone once the human wrote their own', () => {
    const root = tempDir();
    initWorkspace(root, { name: 'mediaHub' }).close();
    const file = path.join(root, CLAUDE_FILE);
    writeFileSync(file, '# AniRecast Workspace：mediaHub（Claude Code）\n\nold\n');
    openWorkspace(root, { role: 'cli' }).close();
    expect(readFileSync(file, 'utf8')).toBe(workspaceClaudeMd('mediaHub'));
    writeFileSync(file, '# My notes\n\n@AGENTS.md\n');
    openWorkspace(root, { role: 'daemon' }).close();
    expect(readFileSync(file, 'utf8')).toBe('# My notes\n\n@AGENTS.md\n');
  });
});
