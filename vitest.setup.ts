import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests never read the developer's own ~/.config/anirecast: each test process starts from the defaults.
process.env.ANIRECAST_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'anirecast-test-config-'));
