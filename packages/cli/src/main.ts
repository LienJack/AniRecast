#!/usr/bin/env node
import { ok } from '@anirecast/shared';

process.stdout.write(`${JSON.stringify(ok({ name: 'anirecast', version: '0.1.0' }))}\n`);
