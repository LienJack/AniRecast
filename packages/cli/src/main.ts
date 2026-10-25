#!/usr/bin/env node
import { Command } from 'commander';
import { registerDoctor } from './commands/doctor.ts';
import { registerJobs } from './commands/jobs.ts';
import { registerMedia } from './commands/media.ts';
import { registerServe } from './commands/serve.ts';
import { registerWorkspace } from './commands/workspace.ts';

const program = new Command()
  .name('anirecast')
  .description(
    'AniRecast: replace characters in anime openings, shot by shot. stdout is always one JSON object.',
  )
  .version('0.1.0')
  .option(
    '-w, --workspace <dir>',
    'workspace folder (default: $ANIRECAST_WORKSPACE, current folder, or configured default)',
  )
  .showHelpAfterError();

registerWorkspace(program);
registerJobs(program);
registerMedia(program);
registerDoctor(program);
registerServe(program);

await program.parseAsync(process.argv);
