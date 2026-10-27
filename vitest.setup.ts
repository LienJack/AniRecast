import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests never read the developer's own ~/.config/anirecast: each test process starts from the defaults.
process.env.ANIRECAST_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'anirecast-test-config-'));
// Tests act as the human user whichever shell runs them (Claude Code sets CLAUDECODE, a Codex turn CODEX_THREAD_ID).
delete process.env.CLAUDECODE;
delete process.env.CODEX_THREAD_ID;
